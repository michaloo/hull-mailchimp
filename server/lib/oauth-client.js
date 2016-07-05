import { Router } from "express";
import bodyParser from "body-parser";
import fetchShip from "./middlewares/fetch-ship";
import oauth2Factory from "simple-oauth2";
import rp from "request-promise";

export default function oauth({
  name, clientID, clientSecret,
  callbackUrl, homeUrl, selectUrl,
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
      url: oauth2.authCode.authorizeURL({ redirect_uri })
    };
    if (!apiKey) {
      return res.render("login.html", viewData);
    }
    return res.redirect(`${req.baseUrl}${selectUrl}?hullToken=${req.hull.hullToken}`);
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
              private_settings: { ...ship.private_settings, domain: b.dc, api_key: message.access_token, api_endpoint: b.api_endpoint }
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

  function renderSelect(req, res) {
    const { ship = {}, client: hull } = req.hull;
    const { domain, api_key: apiKey, list_id, api_endpoint } = ship.private_settings || {};
    const viewData = {
      name,
      form_action: `https://${req.hostname}${req.baseUrl}${selectUrl}?hullToken=${req.hull.hullToken}`,
      list_id: list_id
    }
    rp({
      uri: `${api_endpoint}/3.0/lists`,
      qs: {
        fields: 'lists.id,lists.name'
      },
      headers: { "Authorization": `OAuth ${apiKey}`, },
      json: true
    }).then((data) => {
      viewData.mailchimp_lists = data.lists;

      return res.render("admin.html", viewData);
    }, (err) => {

      // if we got auth error let's clear api key and redirect to first step
      // of the ship installation - this is the case when user deleted the api key
      // for the ship mailchimp application and we need to ask for the permission
      // once again
      if (err.statusCode == 401) {
        hull.put(ship.id, {
          private_settings: { ...ship.private_settings, api_key: null }
        }).then((data) => {
          return res.redirect(`${req.baseUrl}${homeUrl}?hullToken=${req.hull.hullToken}`);
        });
      }

    });
  }

  function handleSelect(req, res) {
    const { ship = {}, client: hull } = req.hull;

    hull.put(ship.id, {
      private_settings: { ...ship.private_settings, list_id: req.body.mailchimp_list }
    }).then((data) => {
      res.end('list_id saved, should redirect to sync all option');
    });


  }

  const router = Router();
  router.use(bodyParser.json());
  router.use(fetchShip);
  router.get(homeUrl, renderHome);
  router.get(callbackUrl, renderRedirect);
  router.get(selectUrl, renderSelect);

  router.post(selectUrl, bodyParser.urlencoded({ extended: true }), handleSelect);

  return router;
}
