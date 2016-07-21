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
    return (payload, { hull, ship, req }) => {
      const message = payload.message;
      hull.logger.info("handling event", _.get(payload, "subject"));
      const handler = new MailchimpList(ship, hull, req, MailchimpClientClass);
      if (!handler.isConfigured()) {
        const error = new Error("Ship not configured properly. Missing credentials");
        error.status = 403;
        return Promise.reject(error);
      }
      try {
        handler[method](message);
        return Promise.resolve("ok");
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
    }).then(res => this.hull.logger.info("Queued Mailchimp Batches", res.total_items));
  }

  // Creates an audience (aka Mailchimp Segment)
  createAudience(segment, extract = true) {
    this.hull.utils.log("createAudience");
    const listId = this.getClient().list_id;
    const rawClient = this.getClient().client;
    return rawClient.batch({
      path: `/lists/${listId}/segments`,
      method: "get",
      query: {
        count: 10000,
        type: "static"
      }
    }, { verbose: true }).then((res) => {
      const existingSegment = res.segments.filter(s => s.name === segment.name);
      this.hull.utils.log("createAudience.existingSegment", existingSegment);
      if (existingSegment.length > 0) {
        return existingSegment.pop();
      }

      this._audiences = null;
      return this.request({
        path: "segments",
        body: { name: segment.name, static_segment: [] },
        method: "post"
      }).then(audience => {
        return (() => {
          if (extract) {
            return this.requestExtract({ segment, audience });
          }
          return Promise.resolve();
        })()
        .then(() => {
          return this.saveAudienceMapping(segment.id, audience.id).then(() => {
            return Object.assign({ isNew: true }, audience);
          });
        });
      });
    }, (err) => this.hull.logger.info("Error in createAudience", err));
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
    }, (err) => this.hull.logger.info("Error in deleteAudience", err));
  }

  /**
   * Remove selected users from specified audience
   * @param  {Integer} audienceId
   * @param  {Array} users
   * @return {Promise}
   */
  removeUsersFromAudience(audienceId, users = []) {
    const usersToRemove = users.filter(
      u => !_.isEmpty(u.email) && !_.isEmpty(u["traits_mailchimp/unique_email_id"])
    );
    this.hull.logger.info("removeUsersFromAudience.usersToRemove", usersToRemove.length);
    const batch = usersToRemove.reduce((ops, user) => {
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
   * Removes provided users from all audiences
   * TODO - try to optimize the number of batched operations,
   * right now it tries to remove users from all audiences, so the number
   * of operation would be users * audiences
   * @param  {Array} users
   * @return {Promise}
   */
  removeUsersFromAudiences(users = []) {
    const usersToRemove = users.filter(
      u => !_.isEmpty(u.email) && !_.isEmpty(u["traits_mailchimp/unique_email_id"])
    );
    this.hull.logger.info("removeUsersFromAudiences.usersToRemove", usersToRemove.length);
    return this.getAudiencesBySegmentId()
      .then(audiences => {
        const batch = usersToRemove.reduce((ops, user) => {
          const { email } = user;
          const hash = getEmailHash(email);
          if (hash) {
            _.map(audiences, ({ audience }) => {
              ops.push({
                method: "delete",
                path: `segments/${audience.id}/members/${hash}`
              });
            });
          }
          return ops;
        }, []);
        return this.request(batch);
      });
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

    return this.fetchAudiences()
      .then(segments => {
        const calls = segments.map(s => {
          return rawClient.request({
            method: "delete",
            path: `/lists/${listId}/segments/${s.id}`
          });
        });

        if (calls.length === 0) {
          return Promise.resolve([]);
        }

        this.hull.logger.info("Remove Audiences", calls.length);

        return Promise.all(calls);
      });
  }

  /**
   * Ensures that all provided users are subscribed to Mailchimp,
   * then adds them to selected audience and updates Hull traits.
   * @param {Int} audienceId
   * @return {Promise}
   */
  addUsersToAudiences(users = []) {
    const usersToAdd = users.filter(u => !_.isEmpty(u.email));
    this.hull.logger.info("addUsersToAudiences.usersToAdd", usersToAdd.length);

    return this.ensureUsersSubscribed(usersToAdd)
      .bind(this)
      .then(this.getAudiencesBySegmentId)
      .then(audiences => {
        const batch = usersToAdd.reduce((ops, user) => {
          user.segment_ids.map(segmentId => {
            const { audience } = audiences[segmentId] || {};
            return ops.push({
              body: { email_address: user.email, status: "subscribed" },
              method: "post",
              path: `segments/${audience.id}/members`
            });
          });
          return ops;
        }, []);
        this.hull.logger.info("addUsersToAudiences.ops", batch.length);
        return batch;
      })
      .then(batch => {
        if (batch.length === 0) {
          return [];
        }
        return this.request(batch);
      })
      .then(responses => {
        return _.uniqBy(responses, "email_address").map((mc) => {
          const user = _.find(usersToAdd, { email: mc.email_address });
          // TODO an user = undefined here this is a quick fix
          if (user) {
            // Update user's mailchimp/* traits
            return this.updateUser(user, mc);
          } else {
            this.hull.utils.log("addUsersToAudiences.userNotFound", mc.email_address);
          }
          return Promise.resolve();
        });
      });
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

    this.hull.logger.info("ensureUsersSubscribed.usersToSubscribe", batch.length);

    if (batch.length === 0) {
      return Promise.resolve(subscribedUsers);
    }

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
    }, (err) => this.hull.logger.info("Error in ensureUsersSubscribed", err));
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
      if (!_.isEmpty(value) && value !== prev) {
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
    this.hull.logger.info("mailchimp.request", params.length || _.get(params, "path"));
    return this.getClient().request(params);
  }

  fetchAudiences() {
    return this.request({
      path: "segments",
      body: { type: "static", count: 100 }
    })
    .then(
      ({ segments }) => segments,
      (err) => this.hull.logger.info("Error in fetchAudiences", err)
    );
  }
}
