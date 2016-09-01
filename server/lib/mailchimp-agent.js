import Promise from "bluebird";
import _ from "lodash";
import crypto from "crypto";
import SyncAgent from "./sync-agent";
import EventsAgent from "./events-agent";

const eventsAgents = {};

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
      "mailchimp_list_id",
      "mailchimp_list_name"
    ];
  }

  checkBatchQueue() {
    // count greater that 100 here causes an error
    // using an offset could be useful here, but it seems that the endpoint
    // does not sort the batches by time
    // so the log will present information for 100 batches
    return this.request({
      method: "get",
      path: "/batches",
      query: {
        count: 100,
        fields: "batches.status,total_items"
      }
    })
    .then(res => {
      const pending = res.batches.filter(b => b.status === "pending");
      const started = res.batches.filter(b => b.status === "started");
      const finished = res.batches.filter(b => b.status === "finished");
      this.hull.logger.info("checkBatchQueue", {
        total: res.total_items,
        pending: pending.length,
        started: started.length,
        finished: finished.length
      });
    });
  }

  // Creates an audience (aka Mailchimp Segment)
  createAudience(segment, options = {}) {
    this.hull.logger.info("createAudience", _.pick(segment, "id", "name"));
    return this.request({
      path: "/lists/{list_id}/segments",
      method: "get",
      query: {
        count: 250,
        type: "static",
        fields: "segments.name"
      }
    }).then((res) => {
      const existingSegment = res.segments.filter(s => s.name === segment.name);
      this.hull.logger.info("createAudience.existingSegment", existingSegment);
      if (existingSegment.length > 0) {
        return existingSegment.pop();
      }

      this._audiences = null;
      return this.request({
        path: "/lists/{list_id}/segments",
        body: { name: segment.name, static_segment: [] },
        method: "post"
      })
      .then(audience => {
        if (options.extract) {
          this.requestExtract({ segment, audience });
        }
        return audience;
      });
    })
    .catch(err => this.hull.logger.info("Error in createAudience", err));
  }

  // Deletes an audience (aka Mailchimp Segment)
  deleteAudience(audienceId, segmentId) {
    if (!audienceId) {
      return Promise.reject(new Error("Missing ID"));
    }
    this._audiences = null;
    return this.request({
      path: `/lists/{list_id}/segments/${audienceId}`,
      method: "delete"
    }).then(() => {
      // Save audience mapping in Ship settings once the audience is removed
      return this.saveAudiencesMapping({ [segmentId]: null });
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
          path: `/lists/{list_id}/segments/${audienceId}/members/${hash}`
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
   * of operation would be users (500 are done in one chunk) * audiences
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
                path: `/lists/{list_id}/segments/${audience.id}/members/${hash}`
              });
            });
          }
          return ops;
        }, []);
        return this.request(batch);
      });
  }

  /**
   * Deletes all mapped Mailchimp Segments
   * @return {Promise}
   */
  removeAudiences() {
    this.hull.logger.info("removeAudiences");
    return this.fetchAudiences()
      .map(segment => {
        this.hull.logger.info("removeAudience", segment.id);
        return this.getClient().request({
          method: "delete",
          path: `/lists/{list_id}/segments/${segment.id}`
        });
      }, { concurrency: 3 });
  }

  /**
   * Ensures that all provided users are subscribed to Mailchimp,
   * then adds them to selected audience and updates Hull traits.
   * @param {Array} users
   * @param {Array} segmentIds. list of segment to add the users to
   * @return {Promise}
   */

  addUsersToAudiences(users = [], segment_id) {
    const usersToAdd = users.filter(u => !_.isEmpty(u.email) && !_.isEmpty(u.first_name) && !_.isEmpty(u.last_name));
    this.hull.logger.info("addUsersToAudiences.usersToAdd", { usersToAdd: usersToAdd.length, users: users.length, segment_id });
    return Promise.all([
      this.ensureUsersSubscribed(usersToAdd),
      this.getAudiencesBySegmentId()
    ])
    .then(([usersSubscribed, audiences]) => {
      const batch = usersSubscribed.reduce((ops, user) => {
        const segment_ids = _.compact(_.uniq((user.segment_ids || []).concat(segment_id)));
        const segments = _.pick(audiences, segment_ids);
        _.each(segments, ({ audience }) => {
          if (audience) {
            this.hull.logger.info("addUsersToAudiences.op", { email: user.email, audienceId: audience.id, segment_ids });
            ops.push({
              body: { email_address: user.email, status: "subscribed" },
              method: "post",
              path: `/lists/{list_id}/segments/${audience.id}/members`
            });
          }
        });
        return ops;
      }, []);

      return this.request(batch).then(responses => {
        return { responses, usersSubscribed };
      });
    })
    .then(({ responses, usersSubscribed }) => {
      const errors = _.reject(responses, "email_address");
      const uniqSuccess = _.filter(_.uniqBy(responses, "email_address"), "email_address");
      this.hull.logger.info("addUsersToAudiences.update", {
        responses: responses.length,
        uniqSuccess: uniqSuccess.length,
        errors: errors.length
      });
      errors.map((e) => this.hull.logger.info("addUsersToAudiences.responseError", { error: e.toString(), message: e.message }));
      return Promise.all(uniqSuccess.map((mc) => {
        this.hull.logger.info("addUsersToAudiences.updateUser", mc.email_address);
        const email = mc.email_address && mc.email_address.toLowerCase();
        const user = _.find(usersSubscribed, { email: mc.email_address });
        if (user) {
          // Update user's mailchimp/* traits
          return this.updateUser(user, mc);
        }
        // this warning is triggered by situation where
        // there is not mailchimp member for selected e_mail
        // it could happen during tests when an user has got
        // the `traits_mailchimp/unique_email_id` trait but
        // the testing mailchimp list was changed
        this.hull.logger.error("addUsersToAudiences.userNotFound", mc);
        return Promise.resolve();
      }));
    })
    .catch(err => {
      this.hull.logger.info("error.addUsersToAudiences", err);
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
          path: "/lists/{list_id}/members",
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
      if (!_.isEmpty(value)/* && value !== prev*/) {
        t[key] = value;
      }
      return t;
    }, {});

    // Skip update if everything is already up to date
    if (_.isEmpty(traits)) {
      this.hull.logger.log("updateUser.alreadyUpToDate", user.id);
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
    const client = this.getClient();
    if (_.isArray(params)) {
      if (params.length === 0) {
        return Promise.resolve([]);
      }
      this.hull.logger.info("mailchimp.batch", { ops: params.length, paths: _.uniq(_.map(params, o => [o.method, o.path].join(":"))) });
      return client.batch(params);
    }
    this.hull.logger.debug("mailchimp.request", params);
    return client.request(params);
  }

  fetchAudiences() {
    return this.request({
      method: "get",
      path: "/lists/{list_id}/segments",
      query: { type: "static", count: 250 }
    })
    .then(
      ({ segments }) => segments,
      (err) => this.hull.logger.info("Error in fetchAudiences", err)
    );
  }

  /**
   * Returns a cached instance of EventsAgent and also sets the scheduler
   * for periodic check for new events
   * @return {Object} instance of EventsAgent
   */
  getEventsAgent() {
    const client = this.getClient();
    if (!eventsAgents[client.api_key]) {
      eventsAgents[client.api_key] = new EventsAgent(client, this.hull, this.getCredentials());
    }
    return eventsAgents[client.api_key];
  }

  /**
   * It runs the EventsAgent.runCampaignStrategy with a callback which calls
   * an extract to get information for members to track Mailchimp activity on them.
   * The query which is passed to the callback will select only user which
   * latest tracked activity is older than activity from Mailchimp
   *
   * @return {Promise}
   */
  handleRequestTrackExtract() {
    const eventsAgent = this.getEventsAgent();
    return eventsAgent.runCampaignStrategy(query => {
      const segment = {
        query
      };
      const path = "/track";
      const format = "csv";
      const fields = [
        "id",
        "email",
        "traits_mailchimp/latest_activity_at",
        "traits_mailchimp/unique_email_id"
      ];
      this.hull.logger.info("Request track extract");
      return this.requestExtract({ segment, path, format, fields })
        .catch(err => console.error(err));
    });
  }

  handleUserUpdate({ user, changes = {}, segments = [] }) {
    super.handleUserUpdate({ user, changes, segments });

    // exclude updates related to mailchimp events send to avoid possible loop
    if (this.shouldSyncUser(user)
      && _.isEmpty(_.get(changes, "user['traits_mailchimp/latest_activity_at'][1]"))) {
      this.getEventsAgent().runUserStrategy([user]);
    }
  }
}
