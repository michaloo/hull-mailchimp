import express from "express";
import bodyParser from "body-parser";
import fetchShip from "./middlewares/fetch-ship";

import _ from "lodash";
import Mailchimp from "mailchimp-api-v3";
import { findOrCreateList, addUser } from "./lib/list";
import { findSegments, createSegments, updateUserSegments } from "./lib/segments";

import request from "request";
import JSONStream from "JSONStream";
import es from "event-stream";

// Cow Boy Caching. Works only if we have 1 dyno.
var segmentMapping;

export default function updateBatch() {
  const app = express();
  app.use(bodyParser.json());
  app.use(fetchShip);

  app.use(function batch(req, res, next) {
    var calls = [];
    const { url } = req.body || {};
    const { client: hull, ship } = req.hull;
    const { private_settings = {} } = ship;
    const { api_key, domain, segment_mapping = {}, synchronized_segments: synchronizedSegments = [] } = private_settings;

    segmentMapping = segmentMapping || segment_mapping || [];

    if (!url || !hull || !ship || !api_key) {
      res.status(400);
      res.send({ reason: "missing_params" });
      res.end();
      return;
    }

    const mailchimp = new Mailchimp(api_key);
    mailchimp.__base_url = `https://${domain}.api.mailchimp.com/3.0`;

    function flush(pipe) {
      pipe.on("end", function flushPipe() {
        console.log('Batch', calls);
        mailchimp.batch(calls, function mailchimpDone(resp) {
          hull.utils.log("Batch Result", resp, arguments);
        });
        calls = [];
      });
    }

    function queueUsers({ list, mapping: segmentMapping }) {
      // process the stream, one item at a time.
      return request({ url })
        .pipe(JSONStream.parse())
        .pipe(es.mapSync(function processUser(data = {}) {
          // for each user, add it"s operations to the batch call list.
          const user = _.omit(data, "segment_ids");
          const segmentIds = data.segment_ids;
          calls.push(addUser({ list, user, batch: true }))
          calls = calls.concat(
            updateUserSegments({ list, segmentMapping, user, segmentIds, batch: true })
          );
        }));
    }

    function findOrCreateSegments({ list, segments }) {
      // create matching segments for all those that exist in Hull we didnt find in Mailchimp
      return findSegments(mailchimp, list)
      .then(({ segments: mailchimpSegments }) => {
        const unmatchedSegments = _.differenceWith(segments, mailchimpSegments, (s, ms) => (segmentMapping[s.id] === ms.id));
        return createSegments(mailchimp, list, unmatchedSegments, synchronizedSegments);
      })
      .then(function wrapSegments(responses) {
        return { list, responses };
      });
    }

    function saveSegmentsToHull({ list, responses }) {
      // Nothing was created
      if (!responses.length) {
        return Promise.resolve({ list, mapping: segmentMapping });
      }

      const orphanSegments = _.difference(_.keys(segmentMapping), _.map(_.map(responses, "segment"), "id"));
      const mapping = _.omit({ ...segmentMapping }, orphanSegments);

      _.map(responses, (response = {}) => {
        mapping[response.segment.id] = response.mailchimp.id;
      });

      return hull.put(ship.id, {
        private_settings: {
          ...private_settings,
          segment_mapping: mapping
        }
      }).then(function returnSegments() {
        return { list, mapping };
      });
    }

    function processSegments(segments) {
      // first find the list.
      return findOrCreateList({ hull, mailchimp, ship })

      .then(list => findOrCreateSegments({ list, segments }),
        err => hull.utils.log("Could not get list", err, err.stack)
      )

      .then(saveSegmentsToHull,
        err => hull.utils.log("Could not process Batch", err, err.stack)
      )

      .then(queueUsers,
        err => hull.utils.log("Could not Save Segments", err, err.stack)
      )

      .then(flush,
        err => hull.utils.log("Could not Queue Users", err, err.stack)
      );
    }

    hull.get("segments", { limit: 500 })
    .then(processSegments)
    .catch(
      err => hull.utils.log("Error processing Batch", err, err.stack)
    );

    next();
  });
  return app;
}
