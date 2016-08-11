import express from "express";
import { NotifHandler } from "hull";
import _ from "lodash";
import bodyParser from "body-parser";
import kue from "kue";

import fetchShip from "./lib/middlewares/fetch-ship";
import MailchimpAgent from "./lib/mailchimp-agent";
import MailchimpClient from "./lib/mailchimp-client";
import QueueAgent from "./lib/queue-agent";

export default function Server({ hostSecret }) {
  const app = express();

  const q = kue.createQueue({
    redis: process.env.REDIS_URL
  });

  const queueAgent = new QueueAgent(q);

  queueAgent.processRequest(app);

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
      // TODO: decide if to filter users here
      // is the extract user.segment_ids update?
      // const filteredUsers = users.filter((user) => {
      //   return !_.isEmpty(user.email)
      //     && agent.shouldSyncUser(user);
      // });
      return agent.getEventsAgent().runUserStrategy(users);
    });
  });

  return app;
}
