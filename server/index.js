import express from "express";
import path from "path";
import { NotifHandler } from "hull";
import { renderFile } from "ejs";
import _ from "lodash";
import bodyParser from "body-parser";

import fetchShip from "./lib/middlewares/fetch-ship";
import MailchimpAgent from "./lib/mailchimp-agent";
import MailchimpClient from "./lib/mailchimp-client";
import oauth from "./lib/oauth-client";

export function Server({ hostSecret }) {
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

  app.post("/notify", NotifHandler({
    hostSecret,
    groupTraits: false,
    handlers: {
      "segment:update": MailchimpAgent.handle("handleSegmentUpdate", MailchimpClient),
      "segment:delete": MailchimpAgent.handle("handleSegmentDelete", MailchimpClient),
      "user:update": MailchimpAgent.handle("handleUserUpdate", MailchimpClient),
      "ship:update": MailchimpAgent.handle("handleShipUpdate", MailchimpClient),
    }
  }));

  app.post("/batch", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.batch.start", req.body);
    res.end("ok");

    return agent.handleExtract(req.body, users => {
      client.logger.info("request.batch.parseChunk", users.length);

      const filteredUsers = users.filter((user) => {
        return !_.isEmpty(user.email)
          && agent.shouldSyncUser(user);
      });

      const usersToRemove = users.filter((user) => {
        return !_.isEmpty(user["traits_mailchimp/unique_email_id"])
            && !agent.shouldSyncUser(user);
      });

      client.logger.info("request.batch.filteredUsers", filteredUsers.length);
      client.logger.info("request.batch.usersToRemove", usersToRemove.length);

      return agent.addUsersToAudiences(filteredUsers, req.query.segment_id)
        .then(() => agent.removeUsersFromAudiences(usersToRemove));
    }).then(() => {
      client.logger.info("request.batch.end");
    });
  });

  app.post("/track", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.track.start", req.body);
    res.end("ok");
    return agent.handleExtract(req.body, users => {
      client.logger.info("request.track.parseChunk", users.length);
      const filteredUsers = users.filter((user) => {
        return !_.isEmpty(user.email)
          && agent.shouldSyncUser(user);
      });
      return agent.getCampaignAgent().runUserStrategy(filteredUsers);
    });
  });

  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "manifest.json"));
  });

  return app;
}
