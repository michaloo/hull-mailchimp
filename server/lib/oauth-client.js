import { Router } from "express";
import bodyParser from "body-parser";
import fetchShip from "./middlewares/fetch-ship";
import oauth2Factory from "simple-oauth2";
import rp from "request-promise";
import MailchimpAgent from "./mailchimp-agent";
import MailchimpClient from "./mailchimp-client";
import Promise from "bluebird";

export default function oauth({
  name, clientID, clientSecret,
  callbackUrl, homeUrl, selectUrl, syncUrl,
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

  /**
   * If we got auth error let's clear api key and redirect to first step
   * of the ship installation - this is the case when user deleted the api key
   * for the ship mailchimp application and we need to ask for the permission
   * once again
   */
  function mailchimpErrorHandler(req, res, ship, hull, err) {
    if (err.statusCode === 401) {
      hull.utils.log("Mailchimp /lists query returned 401 - ApiKey is invalid");
      hull.put(ship.id, {
        private_settings: { ...ship.private_settings, api_key: null, mailchimp_list_id: null }
      }).then(() => {
        return res.redirect(`${req.baseUrl}${homeUrl}?hullToken=${req.hull.hullToken}`);
      });
    } else {
      // TODO add an error page template to display uncaught errors
      res.status(500).end(`Error: ${err.statusCode} -- ${err.message}`);
    }
  }

  function renderHome(req, res) {
    const { ship = {}, } = req.hull;
    const { api_key: apiKey, mailchimp_list_id: mailchimpListId, api_endpoint: apiEndpoint } = ship.private_settings || {};
    const redirect_uri = `https://${req.hostname}${req.baseUrl}${callbackUrl}?hullToken=${req.hull.hullToken}`;
    const viewData = {
      name,
      url: oauth2.authCode.authorizeURL({ redirect_uri })
    };
    if (!apiKey || !apiEndpoint) {
      return res.render("login.html", viewData);
    }

    if (!mailchimpListId) {
      return res.redirect(`${req.baseUrl}${selectUrl}?hullToken=${req.hull.hullToken}`);
    }

    return res.redirect(`${req.baseUrl}${syncUrl}?hullToken=${req.hull.hullToken}`);
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
    const { api_key: apiKey, mailchimp_list_id, api_endpoint } = ship.private_settings || {};
    const viewData = {
      name,
      form_action: `https://${req.hostname}${req.baseUrl}${selectUrl}?hullToken=${req.hull.hullToken}`,
      mailchimp_list_id
    };
    rp({
      uri: `${api_endpoint}/3.0/lists`,
      qs: {
        fields: "lists.id,lists.name"
      },
      headers: { Authorization: `OAuth ${apiKey}`, },
      json: true
    }).then((data) => {
      viewData.mailchimp_lists = data.lists;
      return res.render("admin.html", viewData);
    }, mailchimpErrorHandler.bind(this, res, res, ship, hull));
  }

  function handleSelect(req, res) {
    const { ship = {}, client: hull } = req.hull;
    const { api_key: apiKey, api_endpoint } = ship.private_settings || {};
    const list_id = req.body.mailchimp_list_id;
    rp({
      uri: `${api_endpoint}/3.0/lists/${list_id}`,
      qs: {
        fields: "id,name"
      },
      headers: { Authorization: `OAuth ${apiKey}`, },
      json: true
    }).then((data) => {
      return hull.put(ship.id, {
        private_settings: { ...ship.private_settings, mailchimp_list_id: data.id, mailchimp_list_name: data.name }
      }).then(() => {
        return res.redirect(`${req.baseUrl}${syncUrl}?hullToken=${req.hull.hullToken}`);
      });
    }, mailchimpErrorHandler.bind(this, res, req, ship, hull));
  }

  function renderSync(req, res) {
    const { ship = {} } = req.hull;
    const { mailchimp_list_name } = ship.private_settings || {};
    const viewData = {
      name,
      select_url: `https://${req.hostname}${req.baseUrl}${selectUrl}?hullToken=${req.hull.hullToken}`,
      form_action: `https://${req.hostname}${req.baseUrl}${syncUrl}?hullToken=${req.hull.hullToken}`,
      mailchimp_list_name
    };
    return res.render("sync.html", viewData);
  }

  /**
   * Sync all operation handler. It drops all Mailchimp Segments aka Audiences
   * then creates them according to `segment_mapping` settings and triggers
   * sync for all users
   */
  function handleSync(req, res) {
    const { ship, client } = req.hull || {};
    const agent = new MailchimpAgent(ship, client, req, MailchimpClient);

    client.utils.log("Start sync all operation");
    agent.removeAudiences()
    .then(agent.handleShipUpdate.bind(agent, false))
    // in use case when hull user decides to sync all his/her userbase
    // and then selects some filters to filter out some users.
    // This is why we need to trigger sync off all users here.
    // .then(agent.fetchSyncHullSegments.bind(this))
    .then(() => {
      // client.utils.log("Request the extract for segments", segments.length);
      // if (segments.length == 0) {
      return agent.requestExtract({});
      // }
      // return Promise.map(segments, segment => {
      //   return agent.requestExtract({ segment });
      // });
    })
    .then(() => {
      res.end("ok");
    });
  }

  const router = Router();
  router.use(bodyParser.json());
  router.use(fetchShip);
  router.get(homeUrl, renderHome);
  router.get(callbackUrl, renderRedirect);
  router.get(selectUrl, renderSelect);
  router.get(syncUrl, renderSync);

  router.post(selectUrl, bodyParser.urlencoded({ extended: true }), handleSelect);
  router.post(syncUrl, handleSync);

  return router;
}
