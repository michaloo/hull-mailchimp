import request from "supertest";
import Promise from "bluebird";
import _ from "lodash";

/**
 * Queue Agent which handle queueing and processing http requests to the ship
 */
export default class QueueAgent {

  /**
   * Adapter on top of the queue system.
   * Should expose create and process methods;
   */
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * Queue process to the internal app
   * @param {Object} req Request object
   * @return {Promise}
   */
  queueRequest(req) {
    const options = _.pick(req, ["method", "path", "query", "body", "hostname", "headers"]);
    options.title = _.get(req, "path", "");
    return this.adapter.create("http_requests", options, 30000);
  }

  /**
   * @param {Object} app the http server application to run queued requests
   */
  processRequest(app) {
    return this.adapter.process("http_requests", (job) => {
      return Promise.fromCallback((callback) => {
        let query = request(app);
        query = query[job.data.method.toLowerCase()](job.data.path)
          .query(job.data.query)
          .set({ host: job.data.hostname });

        if (job.data.method === "POST") {
          query = query.send(job.data.body);
        }

        return query.end(callback);
      });
    });
  }
}
