import Promise from "bluebird";
import moment from "moment";
import _ from "lodash";
import crypto from "crypto";
import JSONStream from "JSONStream";
import BatchStream from "batch-stream";
import request from "request";
import tar from "tar-stream";
import zlib from "zlib";
import ps from "promise-streams";

/**
 * CampaignAgent has methods to query Mailchimp for data relevant
 * for Hull Track API and to call Track API Endpoint
 */
export default class CampaignAgent {

  constructor(mailchimpClient, hull, credentials) {
    this.client = mailchimpClient;
    this.hull = hull;
    this.credentials = credentials;
  }

  /**
   * Gets information from campaigns about email activies and prepares
   * query to create hull extracts. Takes a callback which is called
   * for 500 emails chunkes with prepared elastic search query.
   * @api
   * @param  {Function} callback
   * @return {Promise}
   */
  runCampaignStrategy(callback) {
    return this.getTrackableCampaigns()
      .then(campaigns => {
        return this.getEmailActivities(campaigns, (chunk) => {
          if (_.isEmpty(chunk)) {
            return null;
          }
          const emails = chunk[0].map(e => {
            return {
              timestamp: _.head(e.activity).timestamp,
              email_address: e.email_address
            };
          });
          this.hull.logger.info("runCampaignStrategy.emailsChunk", emails.length);
          const query = this.buildSegmentQuery(emails);
          return callback(query);
        });
      });
  }

  /**
   * Gets information for a e-mail address from Mailchimp
   * and triggers Hull.track api endpoint
   * @api
   * @param  {Array} hullUsers
   * @return {Promise}
   */
  runUserStrategy(hullUsers) {
    const users = hullUsers.map(u => {
      u.email_address = u.email;
      return u;
    });
    return this.getMemberActivities(users)
      .then(this.trackEvents.bind(this));
  }

  buildSegmentQuery(emails) {
    const queries = emails.map(f => {
      // eslint-disable-next-line object-curly-spacing, quote-props, key-spacing, comma-spacing
      return {"and":{"filters":[{"terms":{"email.exact":[f.email_address]}},{"or":{"filters":[{"range":{"traits_mailchimp/latest_activity.exact":{"lt":f.timestamp}}},{"missing":{"field":"traits_mailchimp/latest_activity"}}]}}]}};
    });

    return {
      filtered: { query: { match_all: {} },
        filter: {
          or: {
            filters: queries
          }
        }
      }
    };
  }

  /**
   * Returns an array of campaigns which can have new events from members.
   * This are sent and being sent campaign not older than a week.
   * @return {Promise}
   */
  getTrackableCampaigns() {
    this.hull.logger.info("getTrackableCampaigns");
    const weekAgo = moment().subtract(1, "week");

    return this.client.request({
      path: "/campaigns",
      query: {
        fields: "campaigns.id,campaigns.status,campaigns.title",
        list_id: this.credentials.mailchimp_list_id,
        since_send_time: weekAgo.format()
      },
    })
    .then(res => {
      return res.campaigns.filter(c => ["sent", "sending"].indexOf(c.status) !== -1);
    });
  }

  /**
   * Takes a list of campaigns to check, then downloads the emails activities
   * and then flattens it to return one array for all campaigns requested.
   * Returns only emails with some activities.
   * @param  {Array} campaigns
   * @param  {Function} callback
   * @return {Promise}
   */
  getEmailActivities(campaigns, callback) {
    this.hull.logger.info("getEmailActivities", campaigns.length);
    const queries = campaigns.map(c => {
      return {
        method: "get",
        path: `/reports/${c.id}/email-activity/`,
        query: { fields: "emails.email_address,emails.activity" },
      };
    });

    // we forceBatch here, because the response for small number of operation
    // can be huge and needs streaming
    return this.client.batch(queries, { unpack: false, forceBatch: true, verbose: true })
      .then((results) => {
        return this.handleMailchimpResponse(results)
          .pipe(ps.map(res => {
            return [].concat.apply([], res.map(r => r.emails))
              .filter(r => r.activity.length > 0);
          }))
          .pipe(new BatchStream({ size: 500 }))
          .pipe(ps.map((...args) => {
            try {
              return callback(...args);
            } catch (e) {
              console.error(e);
              throw e;
            }
          }))
          .wait();
      });
  }

  /**
   * Method to handle Mailchimp batch response as a JSON stream
   * @param  {String} { response_body_url }
   * @return {Stream}
   */
  handleMailchimpResponse({ response_body_url }) {
    const extract = tar.extract();
    const decoder = JSONStream.parse();

    extract.on("entry", (header, stream, callback) => {
      if (header.name.match(/\.json/)) {
        stream.pipe(decoder);
      }

      stream.on("end", () => {
        callback(); // ready for next entry
      });

      stream.resume();
    });

    request(response_body_url)
      .pipe(zlib.createGunzip())
      .pipe(extract);

    return decoder
      .pipe(ps.map(res => res.map(r => JSON.parse(r.response))));
  }

  /**
   * This method downloads information for members of a selected list
   * @param  {Array} emails
   * [{ email_address, [[email_id,] "traits_mailchimp/latest_activity"] }]
   * @return {Promise}
   */
  getMemberActivities(emails) {
    this.hull.logger.info("getMemberActivities", emails.length);
    const listId = this.credentials.mailchimp_list_id;
    const emailIds = emails.map(e => {
      e.email_id = e.email_id || this.getEmailId(e.email_address);
      return e;
    });
    const queries = _.uniqWith(emailIds.map(e => {
      return {
        method: "get",
        path: `/lists/${listId}/members/${e.email_id}/activity`,
      };
    }), _.isEqual);

    return this.client.batch(queries)
      .then((results) => {
        const validResults = _.reject(results, (r) => {
          return (r.status >= 400 && r.status <= 499)
            || (r.status >= 500 && r.status <= 599);
        });

        return validResults.map(r => {
          const emailId = _.find(emailIds, {
            email_id: r.email_id,
          });
          r.email_address = emailId.email_address;

          if (emailId["traits_mailchimp/latest_activity"]) {
            r.activity = r.activity.filter(a => {
              return moment(a.timestamp).isAfter(emailId["traits_mailchimp/latest_activity"]);
            });
          }
          return r;
        });
      });
  }

  getEmailId(email) {
    return !_.isEmpty(email) && crypto.createHash("md5")
      .update(email.toLowerCase())
      .digest("hex");
  }

  /**
   * @deprecated since the getEmailActivities is done before extractRequest
   * and it's used to pass e-mail address to the track extract we can't use this
   * method anymore.
   *
   * This method is responsible for filling `getMemberActivities`
   * data with more information from `getEmailActivities`
   * namely the email_address and ip information of "open" action
   * @param  {Array} activities result of getEmailActivities
   * [{
   *   campaign_id: "2c4a24e9df",
   *   list_id: "319f54214b",
   *   email_id: "039817b3448c634bfb35f33577e8b2b3",
   *   email_address: "michaloo+4@gmail.com",
   *   activity: [{
   *     action: "bounce",
   *     type: "hard",
   *     timestamp: "2016-07-12T00:00:00+00:00"
   *   }]
   * }]
   * @param  {Array} members result of getMemberActivities
   * [{
   *   email_id: "039817b3448c634bfb35f33577e8b2b3",
   *   list_id: "319f54214b",
   *   activity: [{
   *     action: "sent",
   *     timestamp: "2016-07-12T11:07:57+00:00",
   *     type: "regular",
   *     campaign_id: "6cfe5bf893",
   *     title: "test123"
   *   }]
   * }]
   * @return {Promise}
   */
  joinData(emails, members) {
    emails.forEach(e => {
      const member = _.find(members, { email_id: e.email_id });
      if (!member) {
        return null;
      }
      member.email_address = e.email_address;

      e.activity.forEach(a => {
        const m = _.find(members, {
          email_id: e.email_id,
        });
        if (m) {
          const memberActivity = _.find(m.activity, {
            timestamp: a.timestamp,
            action: a.action
          });

          if (a.ip && !memberActivity.ip) {
            memberActivity.ip = a.ip;
          }
        }
      });
      return e;
    });

    return members;
  }

  /**
   * For every provided email and its activity call Hull Track endpoint.
   * @param  {Array} emails
   * [{
   *   activity: [{
   *     action: "bounce",
   *     type: "hard",
   *     title: "Campaign Title",
   *     timestamp: "",
   *     campaign_id: "123",
   *     ip: "123.123.123.123"
   *   }],
   *   email_id: "039817b3448c634bfb35f33577e8b2b3",
   *   list_id: "319f54214b",
   *   email_address: "michaloo+4@gmail.com"
   * }]
   * @return {Promise}
   */
  trackEvents(emails) {
    this.hull.logger.info("trackEvents", emails.length);
    const emailTracks = emails.map(email => {
      const user = this.hull.as({ email: email.email_address });
      return email.activity.map(a => {
        // TODO: pass this uniqId to hull.track call
        // eslint-disable-next-line no-unused-vars
        const uniqId = Buffer.from(
          [email.email_address, a.type, a.timestamp].join(),
          "utf8"
        ).toString("base64");

        return user.track(a.action, {
          type: a.type || "",
          title: a.title || "",
          timestamp: a.timestamp,
          campaign_id: a.campaign_id,
        }, {
          source: "mailchimp",
          ip: a.ip,
          created_at: a.timestamp
        })
        .then(() => {
          return user.traits({
            latest_activity: a.timestamp
          }, { source: "mailchimp" });
        });
      });
    });

    return Promise.all([].concat.apply([], emailTracks));
  }
}
