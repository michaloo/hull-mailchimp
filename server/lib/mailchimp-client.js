import _ from "lodash";
import Promise from "bluebird";
import Mailchimp from "mailchimp-api-v3";

export default class MailchimpClient {

  constructor({ api_key, domain, mailchimp_list_id = {} }) {
    // the mailchimp-api-v3 library splits the api_key using dash and uses
    // second part as a api datacenter
    this.client = new Mailchimp(`${api_key}-${domain}`);
    this.list_id = mailchimp_list_id;
  }

  // Mailchimp API request
  // params can be either an operation or an array of operations
  // Operation : { path, body, method }
  // If array of operations and length > 1 we automatically use Mailchimp's batch api
  request(params) {
    const { client, list_id } = this;
    return new Promise((resolve, reject) => {
      const callback = (err, result) => {
        if (err) {
          const error = new Error(err.title);
          error.status = err.status;
          console.log("Error: ", err);
          reject(err);
        } else {
          resolve(result);
        }
      };
      if (_.isArray(params) && params.length > 1) {
        const ops = params.map(({ path, body, method }) => {
          return {
            body, method,
            path: `lists/${list_id}/${path}`
          };
        });
        if (ops.length > 0) {
          client.batch(ops, callback, {
            interval: 2000,
            verbose: false,
          });
        } else {
          resolve([]);
        }
      } else if (params) {
        let operation = params;
        let microbatch = false;
        if (_.isArray(operation)) {
          microbatch = true;
          operation = operation[0];
        }
        if (operation) {
          const { body, method, path } = operation;
          const op = { path: `/lists/${list_id}/${path}`, body, method };
          client.request(op, (err, res) => {
            if (microbatch) {
              callback(null, [err || res]);
            } else {
              callback(err, res);
            }
          });
        } else {
          resolve([]);
        }
      } else {
        reject(new Error("Invalid args"));
      }
    });
  }

}
