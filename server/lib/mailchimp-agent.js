import Promise from "bluebird";
import _ from "lodash";
import crypto from "crypto";
import SyncAgent from "./sync-agent";

const MC_KEYS = [
  "stats.avg_open_rate",
  "stats.avg_click_rate",
  "unique_email_id",
  "status",
  "member_rating",
  "language",
  "vip",
  "email_client"
];

function getEmailHash(email) {
  return !_.isEmpty(email) && crypto.createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");
}

export default class MailchimpList extends SyncAgent {

  constructor(ship, hull, req, MailchimpClientClass) {
    super(ship, hull, req);
    this.MailchimpClientClass = MailchimpClientClass;
  }

  static handle(method, MailchimpClientClass) {
    return ({ message }, { hull, ship, req }) => {
      hull.utils.log("handling event", _.get(message,"events[0].event"));
      const handler = new MailchimpList(ship, hull, req, MailchimpClientClass);
      if (!handler.isConfigured()) {
        const error = new Error("Ship not configured properly. Missing credentials");
        error.status = 403;
        return Promise.reject(error);
      }
      try {
        return handler[method](message);
      } catch (err) {
        const error = new Error(`Unhandled error: ${err.message}`);
        error.status = 500;
        return Promise.reject(error);
      }
    };
  }

  // Returns the list of fields to extract
  // for batch extracts
  _getExtractFields() {
    const traits = MC_KEYS.map(path => {
      const trait = _.last(path.split("."));
      return `traits_mailchimp/${trait}`;
    });
    const props = [
      "traits_mailchimp/import_error",
      "traits_mailchimp/last_activity_at",
      "id",
      "email",
      "first_name",
      "last_name"
    ];
    return props.concat(traits);
  }


  // Mandatory settings to check if config is complete
  _getCredentialKeys() {
    return [
      "api_key",
      "domain",
      "mailchimp_list_id"
    ];
  }

  checkBatchQueue() {
    const rawClient = this.getClient().client;

    return rawClient.get({
      path: "/batches",
      query: {
        count: 1
      }
    }).then(res => this.hull.utils.log("Queued Mailchimp Batches", res.total_items));
  }

  // Creates an audience (aka Mailchimp Segment)
  createAudience(segment, extract = true) {
    this._audiences = null;
    this.request({
      path: "segments",
      body: { name: segment.name, static_segment: [] },
      method: "post"
    }).then(audience => {
      if (extract) this.requestExtract({ segment, audience });
      return this.saveAudienceMapping(segment.id, audience.id).then(() => {
        return Object.assign({ isNew: true }, audience);
      });
    }, (err) => this.hull.utils.log("Error in createAudience", err));
  }

  // Deletes an audience (aka Mailchimp Segment)
  deleteAudience(audienceId, segmentId) {
    if (!audienceId) {
      return Promise.reject(new Error("Missing ID"));
    }
    this._audiences = null;
    return this.request({
      path: `segments/${audienceId}`,
      method: "delete"
    }).then(() => {
      // Save audience mapping in Ship settings once the audience is removed
      return this.saveAudienceMapping(segmentId, null);
    }, (err) => this.hull.utils.log("Error in deleteAudience", err));
  }

  removeUsersFromAudience(audienceId, users = []) {
    const batch = users.reduce((ops, user) => {
      const { email } = user;
      const hash = getEmailHash(email);
      if (hash) {
        ops.push({
          method: "delete",
          path: `segments/${audienceId}/members/${hash}`
        });
      }
      return ops;
    }, []);
    return this.request(batch);
  }

  /**
   * Downloads all Mailchimp members list
   * @return {Promise}
   */
  fetchUsers() {
    const listId = this.getClient().list_id;
    const rawClient = this.getClient().client;
    return rawClient.batch({
      method: "get",
      path: `/lists/${listId}/members`,
      query: {
        count: 10000000000,
      }
    });
  }

  /**
   * Deletes all mapped Mailchimp Segments
   * @return {Promise}
   */
  removeAudiences() {
    const listId = this.getClient().list_id;
    const rawClient = this.getClient().client;
    const mapping = this.getPrivateSetting("segment_mapping") || {};

    const calls = Object.keys(mapping).map(segment => {
      const mailchimpId = mapping[segment];
      return {
        method: "delete",
        path: `/lists/${listId}/segments/${mailchimpId}`
      };
    });
    this.hull.utils.log("segment_mapping", mapping);
    this.hull.utils.log("Remove Audiences", calls.length);
    return rawClient.batch(calls, {
      interval: 1000,
      verbose: false
    });
  }

  /**
   * Ensures that all provided users are subscribed to Mailchimp,
   * then adds them to selected audience and updates Hull traits.
   * @param {Int} audienceId
   * @return {Promise}
   */
  addUsersToAudience(audienceId, users = []) {
    const usersToAdd = users.filter(u => !_.isEmpty(u.email));
    return this.ensureUsersSubscribed(usersToAdd)
    .then(() => {
      const batch = usersToAdd.map(user => {
        return {
          body: { email_address: user.email, status: "subscribed" },
          method: "post",
          path: `segments/${audienceId}/members`
        };
      });
      this.hull.utils.log("addUsersToAudience.usersToAdd", batch.length);
      return this.request(batch)
      .then(responses => {
        responses.map((mc, i) => {
          // Update user's mailchimp/* traits
          return this.updateUser(usersToAdd[i], mc);
        });
      });
    }, (err) => this.hull.utils.log("Error in addUsersToAudience", err));
  }

  /**
   * Ensure users are subscribed to the list
   * before trying to add them to the audience
   * @param  {Array} users
   * @return {Promise}
   */
  ensureUsersSubscribed(users = []) {
    const subscribedUsers = users.filter(
      user => !_.isEmpty(user["traits_mailchimp/unique_email_id"])
    );

    // Do not try to reubscribe users who already have a unique_email_id
    // or have already been rejected by mailchimp
    const usersToSubscribe = users.filter(user => {
      return !_.isEmpty(user.email)
          && _.isEmpty(user["traits_mailchimp/unique_email_id"])
          && _.isEmpty(user["traits_mailchimp/import_error"]);
    });

    const batch = usersToSubscribe
      .map(user => {
        return {
          method: "post",
          path: "members",
          body: {
            email_type: "html",
            merge_fields: {
              FNAME: user.first_name,
              LNAME: user.last_name
            },
            email_address: user.email,
            status: "subscribed"
          }
        };
      });

    this.hull.utils.log("ensureUsersSubscribed.usersToSubscribe", batch.length);
    return this.request(batch).then((results) => {
      usersToSubscribe.map((user, i) => {
        const res = results[i];
        if (res.unique_email_id) {
          this.updateUser(user, res);
          subscribedUsers.push(user);
        } else if (res.title === "Member Exists") {
          subscribedUsers.push(user);
        } else {
          // Record error so that next time we don't try to subscribe him again
          const traits = { import_error: res.detail };
          return this.hull.as(user.id).traits(traits, { source: "mailchimp" });
        }
        return user;
      });
      return subscribedUsers;
    }, (err) => this.hull.utils.log("Error in ensureUsersSubscribed", err));
  }

  /**
   * @param  {Object} user
   * @param  {Object} mailchimpUser
   * @return {Promise}
   */
  updateUser(user, mailchimpUser) {
    // Build list of traits to update
    const traits = MC_KEYS.reduce((t, path) => {
      const key = _.last(path.split("."));
      const value = _.get(mailchimpUser, path);
      const prev = user[`traits_mailchimp/${key}`];
      if (!_.isEmpty(value) && value != prev) {
        t[key] = value;
      }
      return t;
    }, {});

    // Skip update if everything is already up to date
    if (_.isEmpty(traits)) {
      return Promise.resolve({});
    }

    return this.hull.as(user.id).traits(traits, { source: "mailchimp" });
  }

  getClient() {
    if (!this._client) {
      this._client = new this.MailchimpClientClass(this.getCredentials());
    }
    return this._client;
  }

  request(params) {
    this.hull.utils.log("mailchimp.request", params.length);
    return this.getClient().request(params);
  }

  fetchAudiences() {
    return this.request({
      path: "segments",
      body: { type: "static", count: 100 }
    })
    .then(
      ({ segments }) => segments,
      (err) => this.hull.utils.log("Error in fetchAudiences", err)
    );
  }
}
