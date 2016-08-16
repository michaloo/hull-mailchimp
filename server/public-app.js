import express from "express";
import path from "path";
import { renderFile } from "ejs";
import bodyParser from "body-parser";

import fetchShip from "./lib/middlewares/fetch-ship";
import oauth from "./lib/oauth-client";
import snsMessage from "./lib/middlewares/sns-message";

export default function Server({ queueAgent }) {
  const app = express();

  app.use(express.static(path.resolve(__dirname, "..", "dist")));
  app.use(express.static(path.resolve(__dirname, "..", "assets")));
  app.set("views", `${__dirname}/views`);
  app.engine("html", renderFile);

  app.post("/notify", snsMessage, bodyParser.json(), (req, res) => {
    req.body = JSON.stringify(req.body);
    queueAgent.queueRequest(req);
    res.end("ok");
  });

  app.post("/batch", snsMessage, bodyParser.json(), (req, res) => {
    queueAgent.queueRequest(req);
    res.end("ok");
  });

  app.post("/track", snsMessage, bodyParser.json(), (req, res) => {
    queueAgent.queueRequest(req);
    res.end("ok");
  });

  app.post("/sync", snsMessage, bodyParser.json(), (req, res) => {
    queueAgent.queueRequest(req);
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
    queueAgent.queueRequest(req);
    res.end("ok");
  });

  app.get("/checkBatchQueue", bodyParser.json(), fetchShip, (req, res) => {
    queueAgent.queueRequest(req);
    res.end("ok");
  });

  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "manifest.json"));
  });

  return app;
}
