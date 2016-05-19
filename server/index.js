import express from "express";
import path from "path";
import { NotifHandler } from "hull";
import { renderFile } from "ejs";


import updateUser from "./update-user";
import updateBatch from "./update-batch";
import { updateSegment, deleteSegment } from "./update-segment";

import oauth from "./oauth-client";

export function Server() {
  const app = express();

  app.use(express.static(path.resolve(__dirname, "..", "dist")));
  app.use(express.static(path.resolve(__dirname, "..", "assets")));
  app.set("views", `${__dirname}/views`);
  app.engine("html", renderFile);

  app.use("/auth", oauth({
    name: "Mailchimp",
    clientID: "769465987151",
    clientSecret: "a88916aa7f9b3260401c3019bdcc1aeb",
    callbackUrl: "/callback",
    homeUrl: "/",
    site: "https://login.mailchimp.com",
    tokenPath: "/oauth2/token",
    authorizationPath: "/oauth2/authorize"
  }));

  app.post("/notify", NotifHandler({
    groupTraits: false,
    events: {
      "user_report:update": updateUser,
      "users_segment:update": updateSegment,
      "users_segment:delete": deleteSegment,
    }
  }));

  app.post("/batch", updateBatch(), (req, res) => {
    res.end("ok");
  });


  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "manifest.json"));
  });

  return app;
}
