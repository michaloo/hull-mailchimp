import express from "express";
import path from "path";
import { NotifHandler } from "hull";
import { renderFile } from "ejs";

import bodyParser from "body-parser";
import fetchShip from "./lib/middlewares/fetch-ship";
import MailchimpAgent from "./lib/mailchimp-agent";

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
    site: "https://login.mailchimp.com",
    tokenPath: "/oauth2/token",
    authorizationPath: "/oauth2/authorize"
  }));

  const notifHandler = NotifHandler({
    groupTraits: false,
    events: {
      "users_segment:update": MailchimpAgent.handle("handleSegmentUpdate"),
      "users_segment:delete": MailchimpAgent.handle("handleSegmentDelete"),
      "user_report:update": MailchimpAgent.handle("handleUserUpdate"),
      "ship:update": MailchimpAgent.handle("handleShipUpdate"),
    }
  });

  app.post("/notify", notifHandler);

  app.post("/batch", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const { audience } = req.query;
    const mc = new MailchimpAgent(ship, client, req);
    if (ship && audience) {
      mc.handleExtract(req.body, users => {
        mc.addUsersToAudience(audience, users);
      });
    }
    res.end("ok");
  });

  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "manifest.json"));
  });

  return app;
}
