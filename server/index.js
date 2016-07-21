import _ from "lodash";
import express from "express";
import path from "path";
import { NotifHandler } from "hull";
import { renderFile } from "ejs";

import bodyParser from "body-parser";
import fetchShip from "./lib/middlewares/fetch-ship";
import MailchimpAgent from "./lib/mailchimp-agent";
import MailchimpClient from "./lib/mailchimp-client";

import oauth from "./lib/oauth-client";

export function Server() {
  const app = express();

  app.use(express.static(path.resolve(__dirname, "..", "dist")));
  app.use(express.static(path.resolve(__dirname, "..", "assets")));
  app.set("views", `${__dirname}/views`);
  app.engine("html", renderFile);

  app.use("/auth", oauth({
    name: "Mailchimp",
    clientID: process.env.MAILCHIMP_CLIENT_ID,
    clientSecret: process.env.MAILCHIMP_CLIENT_SECRET,
    callbackUrl: "/callback",
    homeUrl: "/",
    selectUrl: "/select",
    syncUrl: "/sync",
    site: "https://login.mailchimp.com",
    tokenPath: "/oauth2/token",
    authorizationPath: "/oauth2/authorize"
  }));

  const notifHandler = NotifHandler({
    groupTraits: false,
    events: {
      "users_segment:update": MailchimpAgent.handle("handleSegmentUpdate", MailchimpClient),
      "users_segment:delete": MailchimpAgent.handle("handleSegmentDelete", MailchimpClient),
      "user_report:update": MailchimpAgent.handle("handleUserUpdate", MailchimpClient),
      "ship:update": MailchimpAgent.handle("handleShipUpdate", MailchimpClient),
    }
  });

  app.post("/notify", notifHandler);

  app.post("/batch", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.utils.log("request.batch.start");
    return agent.handleExtract(req.body, users => {
      client.utils.log("request.batch.parseChunk", users.length);
      const filteredUsers = users.filter(agent.shouldSyncUser.bind(agent));

      return agent.addUsersToAudiences(filteredUsers);
    }).then(() => {
      client.utils.log("request.batch.end");
      res.end("ok");
    });
  });

  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "manifest.json"));
  });

  return app;
}
