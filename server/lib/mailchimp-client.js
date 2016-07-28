import _ from "lodash";
import Promise from "bluebird";

import Mailchimp from "mailchimp-api-v3";
import limiter from "./limiter";

export default class MailchimpClient {

  constructor({ api_key, domain, mailchimp_list_id = {} }) {
    // the mailchimp-api-v3 library splits the api_key using dash and uses
    // second part as a api datacenter
    this.api_key = `${api_key}-${domain}`;
    this.client = new Mailchimp(this.api_key);
    this.list_id = mailchimp_list_id;
  }

  /**
   * Replaces `path` param at Mailchimp Api request to fill in the selected
   * list id
   * @param  {Object} request
   * @return {Object}
   */
  replacePath(request) {
    request.path = _.replace(request.path, "{list_id}", this.list_id);
    return request;
  }

  /**
   * Batch operation
   * @param  {Array} ops
   * @return {Promise}
   */
  batch(ops, options = {}) {
    if (_.isEmpty(ops)) {
      return Promise.resolve([]);
    }

    _.defaults(options, { verbose: false, forceBatch: false });

    // microbatch - when the batch consists of only 1 operation,
    // let's do it in a traditional query
    if (!options.forceBatch && ops.length === 1) {
      return this.request(ops.pop())
        .then(res => [res], err => [err]);
    }
    ops = ops.map(this.replacePath.bind(this));

    return limiter.key(this.api_key)
      .schedule(this.client.batch.bind(this.client), ops, options);
  }

  /**
   * Simple sync operation
   * @param  {Object} params
   * @return {Promise} response
   */
  request(params) {
    params = this.replacePath(params);
    return limiter.key(this.api_key)
      .schedule(this.client.request.bind(this.client), params);
  }

}
