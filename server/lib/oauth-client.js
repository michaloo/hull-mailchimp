import { Router } from "express";
import bodyParser from "body-parser";
import fetchShip from "./middlewares/fetch-ship";
import oauth2Factory from "simple-oauth2";
import rp from "request-promise";

export default function oauth({
  name, clientID, clientSecret,
  callbackUrl, homeUrl,
  site, tokenPath, authorizationPath
  }) {
  const oauth2 = oauth2Factory({
    name, clientID, clientSecret,
    site, tokenPath, authorizationPath,
    headers: {
      "User-Agent": "hull",
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  function renderHome(req, res) {
    const { ship = {}, } = req.hull;
    const { domain, api_key: apiKey } = ship.private_settings || {};
    const redirect_uri = `https://${req.hostname}${req.baseUrl}${callbackUrl}?hullToken=${req.hull.hullToken}`;
    const viewData = {
      name,
      url: oauth2.authCode.authorizeURL({ redirect_uri }),
      list_url: `https://${domain}.admin.mailchimp.com/lists/members/`
    };
    if (!apiKey) {
      return res.render("login.html", viewData);
    }
    return res.render("admin.html", viewData);
  }

  function renderRedirect(req, res) {
    const { ship = {}, client: hull } = req.hull;

    const code = req.query.code;
    const redirect_uri = `https://${req.hostname}${req.baseUrl}${callbackUrl}?hullToken=${req.hull.hullToken}`;
    const form = {
      grant_type: "authorization_code",
      client_id: clientID,
      client_secret: clientSecret,
      code,
      redirect_uri,
    };

    function saveToken(body = {}) {
      try {
        const message = JSON.parse(body);
        if (message && message.error) {
          return res.send(`Error: ${message.error}`);
        }
        if (message && message.access_token) {
          return rp({
            uri: "https://login.mailchimp.com/oauth2/metadata",
            method: "GET",
            json: true,
            auth: {
              bearer: message.access_token
            }
          })
          .then(
            (b = {}) => hull.put(ship.id, {
              private_settings: { ...ship.private_settings, domain: b.dc, api_key: message.access_token }
            }),
            err => res.send(err)
          )
          .then(
            () => res.render("finished.html"),
            err => res.send(err)
          );
        }
        return res.send(`Could not find access token in ${body}`);
      } catch (e) {
        return res.send(`Could not parse response: ${body}`);
      }
    }

    rp({
      uri: "https://login.mailchimp.com/oauth2/token",
      method: "POST",
      headers: { "User-Agent": "node-mailchimp/1.1.6", },
      form
    }).then(saveToken, (err) => res.send(err));
  }

  const router = Router();
  router.use(bodyParser.json());
  router.use(fetchShip);
  router.get(homeUrl, renderHome);
  router.get(callbackUrl, renderRedirect);

  return router;
}
