import express from "express";
import { NotifHandler } from "hull";
import _ from "lodash";
import bodyParser from "body-parser";
import Promise from "bluebird";

import fetchShip from "./lib/middlewares/fetch-ship";
import MailchimpAgent from "./lib/mailchimp-agent";
import MailchimpClient from "./lib/mailchimp-client";

export default function Server({ hostSecret, queueAgent }) {
  const app = express();

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

    return agent.handleExtract(req.body, users => {
      const queueReq = _.cloneDeep(req);
      queueReq.url = queueReq.url.replace("batch", "batchChunk");
      queueReq.body = {
        users
      };

      return queueAgent.queueRequest(queueReq);
    }).then(() => {
      client.logger.info("request.batch.end");
      res.end("ok");
    });
  });

  app.post("/batchChunk", bodyParser.json({ limit: "10mb" }), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    const users = req.body.users;
    client.logger.info("request.batchChunk.start", users.length);

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
      .then(() => agent.removeUsersFromAudiences(usersToRemove))
      .then(() => {
        client.logger.info("request.batchChunk.end");
        res.end("ok");
      });
  });

  app.post("/requestTrack", bodyParser.json({ limit: "10mb" }), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.track.request", req.body);

    return agent.handleRequestTrackExtract()
      .then(() => res.end("ok"));
  });

  app.post("/track", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.track.start", req.body);
    return agent.handleExtract(req.body, users => {
      client.logger.info("request.track.parseChunk", users.length);
      // TODO: decide if to filter users here
      // is the extract user.segment_ids update?
      // const filteredUsers = users.filter((user) => {
      //   return !_.isEmpty(user.email)
      //     && agent.shouldSyncUser(user);
      // });
      const queueReq = _.cloneDeep(req);
      queueReq.url = queueReq.url.replace("track", "trackChunk");
      queueReq.body = {
        users
      };
      return queueAgent.queueRequest(queueReq);
    }).then(() => {
      client.logger.info("request.track.end");
      res.end("ok");
    });
  });

  app.post("/trackChunk", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }
    const users = _.get(req.body, "users", []);
    return agent.getEventsAgent().runUserStrategy(users)
      .then(() => res.end("ok"));
  });

  app.post("/checkBatchQueue", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }
    client.logger.info("request.checkBatchQueue");
    return agent.checkBatchQueue()
      .then(() => res.end("ok"));
  });

  /**
   * Sync all operation handler. It drops all Mailchimp Segments aka Audiences
   * then creates them according to `segment_mapping` settings and triggers
   * sync for all users
   */
  app.post("/sync", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.sync.start");

    return agent.removeAudiences()
    .then(agent.handleShipUpdate.bind(agent, false, true))
    .then(agent.fetchSyncHullSegments.bind(agent))
    .then(segments => {
      client.logger.info("Request the extract for segments", segments.length);
      if (segments.length === 0) {
        return agent.requestExtract({});
      }
      return Promise.map(segments, segment => {
        return agent.requestExtract({ segment });
      });
    })
    .then(() => res.end("ok"));
  });

  return app;
}
