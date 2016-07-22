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

  /**
   * Replaces `path` param at Mailchimp Api request to fill in the selected
   * list id
   * @param  {Object} request
   * @return {Object}
   */
  replacePath(request) {
    request.path = _.replace(request.path, '{list_id}', this.list_id);
    return request;
  }

  /**
   * Batch operation
   * @param  {Array} ops
   * @return {Promise}
   */
  batch(ops) {
    if (_.isEmpty(ops)) {
      return Promise.resolve([]);
    }
    if (_.isArray(ops) && ops.length === 1) {
      return this.request(ops.pop());
    }

    ops = ops.map(this.replacePath.bind(this));

    return this.client.batch(ops, { verbose: false });
  }

  /**
   * Simple sync operation
   * @param  {Object} params
   * @return {Promise} response
   */
  request(params) {
    params = this.replacePath(params);
    return this.client.request(params);
  }

}
