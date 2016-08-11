import express from "express";
import path from "path";
import { renderFile } from "ejs";
import bodyParser from "body-parser";
import kue from "kue";

import fetchShip from "./lib/middlewares/fetch-ship";
import MailchimpAgent from "./lib/mailchimp-agent";
import MailchimpClient from "./lib/mailchimp-client";
import oauth from "./lib/oauth-client";
import QueueAgent from "./lib/queue-agent";
import snsMessage from "./lib/middlewares/sns-message";

export default function Server() {
  const app = express();

  app.use(express.static(path.resolve(__dirname, "..", "dist")));
  app.use(express.static(path.resolve(__dirname, "..", "assets")));
  app.set("views", `${__dirname}/views`);
  app.engine("html", renderFile);

  const q = kue.createQueue({
    redis: process.env.REDIS_URL
  });

  const queueAgent = new QueueAgent(q);

  app.post("/notify", snsMessage, bodyParser.json(), (req, res) => {
    req.body = JSON.stringify(req.body);
    queueAgent.queueRequest("notify", req);
    res.end("ok");
  });

  app.post("/batch", snsMessage, bodyParser.json(), (req, res) => {
    queueAgent.queueRequest("batch", req);
    res.end("ok");
  });

  app.post("/track", snsMessage, bodyParser.json(), (req, res) => {
    queueAgent.queueRequest("track", req);
    res.end("ok");
  });

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

  app.get("/requestTrack", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.track.request", req.body);
    res.end("ok");
    return agent.handleRequestTrackExtract();
  });

  app.get("/checkBatchQueue", bodyParser.json(), fetchShip, (req, res) => {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);
    if (!ship || !agent.isConfigured()) {
      return res.status(403).send("Ship is not configured properly");
    }

    client.logger.info("request.track.request", req.body);
    res.end("ok");
    return agent.checkBatchQueue();
  });

  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "manifest.json"));
  });

  return app;
}
