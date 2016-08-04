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
import es from "event-stream";

/**
 * EventsAgent has methods to query Mailchimp for data relevant
 * for Hull Track API.
 * It exposes two main public methods `runCampaignStrategy`, `runUserStrategy`.
 */
export default class EventsAgent {

  constructor(mailchimpClient, hull, credentials) {
    this.client = mailchimpClient;
    this.hull = hull;
    this.credentials = credentials;
  }

  /**
   * Gets information from campaigns about email activies and prepares
   * query to create hull extracts for users who have activities in mailchimp.
   * As a param it takes a callback which is called for every 10000 emails chunkes
   * with prepared elastic search query.
   * It decides about the timestamp for `traits_mailchimp/latest_activity_at`.
   * The query is build by `buildSegmentQuery` method.
   * @api
   * @see buildSegmentQuery
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
          const emails = chunk.map(e => {
            const timestamps = e.activity.sort((x, y) => moment(x.timestamp) - moment(y.timestamp));
            return {
              timestamp: _.get(_.last(timestamps), "timestamp", e.campaign_send_time),
              email_id: e.email_id,
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
   * Gets information from Mailchimp about member activities for provided e-mail addresses
   * and triggers Hull.track api endpoint.
   * @api
   * @see getMemberActivities
   * @see trackEvents
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

  /**
   * Takes prepares requestExtract elastic search query to select users
   * which should be updated with events.
   * It build an OR clause of provided email addresses with optional constraint
   * of traits_mailchimp/latest_activity_at
   * @param  {Array} emails
   * @return {Object}
   */
  buildSegmentQuery(emails) {
    const queries = emails.map(f => {
      // eslint-disable-next-line object-curly-spacing, quote-props, key-spacing, comma-spacing
      return {"and":{"filters":[{"terms":{"email.exact":[f.email_address]}},{"or":{"filters":[{"range":{"traits_mailchimp/latest_activity_at":{"lt":moment(f.timestamp).utc().format()}}},{"missing":{"field":"traits_mailchimp/latest_activity_at"}}]}}]}};
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
        fields: "campaigns.id,campaigns.status,campaigns.title,campaigns.send_time",
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
   * and then flattens it to return one array for all emails of all campaigns requested.
   * It also adds `campaign_send_time` parameter from campaign to the email infromation.
   * @param  {Array} campaigns
   * @param  {Function} callback
   * @return {Promise}
   */
  getEmailActivities(campaigns, callback) {
    this.hull.logger.info("getEmailActivities", campaigns);
    const queries = campaigns.map(c => {
      return {
        method: "get",
        path: `/reports/${c.id}/email-activity/`,
        query: { fields: "emails.email_address,emails.activity" },
      };
    });

    // we forceBatch here, because the response for small number of operation
    // can be huge and always needs streaming
    return this.client.batch(queries, { unpack: false, forceBatch: true })
      .then((results) => {
        if (!results.response_body_url) {
          return [];
        }
        return this.handleMailchimpResponse(results)
          .pipe(es.through(function write(data) {
            data.emails.map(r => {
              const campaign = _.find(campaigns, { id: r.campaign_id });
              r.campaign_send_time = campaign.send_time;
              return this.emit("data", r);
            });
          }))
          // the query for extract is send as POST method so it should not be
          // too long
          .pipe(new BatchStream({ size: 4000 }))
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
      .pipe(es.through(function write(data) {
        data.map(r => {
          return this.emit("data", JSON.parse(r.response));
        });
      }));
  }

  /**
   * This method downloads from Mailchimp information for members.
   * If the latest activity infromation is provided for an user the returned
   * array will be filtered to include only events which happened after the time.
   * The array provided as param needs two required parameters:
   * - `email_address` (user email address)
   * - `id` (Hull user ID)
   * It also can take optional params:
   * - `email_id` the MD5 of the `email_address`
   * - `traits_mailchimp/latest_activity_at` if provided it will be used to filter
   * the returned array
   * @param  {Array} emails
   * [{ email_address, id, [[email_id,] "traits_mailchimp/latest_activity_at"] }]
   * @return {Promise}
   */
  getMemberActivities(emails) {
    this.hull.logger.info("getMemberActivities", emails.length);
    const emailIds = emails.map(e => {
      e.email_id = e.email_id || this.getEmailId(e.email_address);
      return e;
    });
    const queries = _.uniqWith(emailIds.map(e => {
      return {
        method: "get",
        path: `/lists/{list_id}/members/${e.email_id}/activity`,
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
          r.id = emailId.id;

          if (emailId["traits_mailchimp/latest_activity_at"]) {
            r.activity = r.activity.filter(a => {
              return moment(a.timestamp).utc().isAfter(emailId["traits_mailchimp/latest_activity_at"]);
            });
          }
          return r;
        }).filter(e => e.activity.length > 0);
      });
  }

  getEmailId(email) {
    return !_.isEmpty(email) && crypto.createHash("md5")
      .update(email.toLowerCase())
      .digest("hex");
  }

  /**
   * For every provided email and its activity call Hull Track endpoint.
   * After calling the track endpoint it saves the latest event timestamp
   * as `traits_mailchimp/latest_activity_at`.
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
   *   id: "578fc6e644d74b10070043be",
   *   email_id: "039817b3448c634bfb35f33577e8b2b3",
   *   list_id: "319f54214b",
   *   email_address: "michaloo+4@gmail.com"
   * }]
   * @return {Promise}
   */
  trackEvents(emails) {
    this.hull.logger.info("trackEvents", emails.length);
    const emailTracks = emails.map(email => {
      const user = this.hull.as(email.id);
      return Promise.all(email.activity.map(a => {
        const uniqId = this.getUniqId({ email, activity: a });
        this.hull.logger.info("trackEvents.track", email.email_address, a.action);
        const eventName = this.getEventName(a);
        const props = this.getEventProperties(a, email);

        return user.track(eventName, props, {
          source: "mailchimp",
          event_id: uniqId,
          created_at: a.timestamp
        }).then(() => a.timestamp);
      }))
      .then((timestamps) => {
        if (timestamps.length === 0) {
          return true;
        }
        const latest = timestamps.sort((x, y) => moment(x) - moment(y)).pop();
        this.hull.logger.info("trackEvents.latest_activity_at", email.email_address, latest);

        return user.traits({
          latest_activity_at: moment(latest).utc()
        }, { source: "mailchimp" });
      });
    });

    return Promise.all(emailTracks);
  }

  getUniqId({ email, activity }) {
    const uniqString = [email.email_address, activity.type, activity.timestamp].join();
    return Buffer.from(uniqString, "utf8").toString("base64");
  }

  /**
   * Implements data structure from Segment documentation.
   * Mailchimp doesn't provide information for `Email Marked as Spam`
   * and `Email Delivered` events
   * @see https://segment.com/docs/spec/email/#email-delivered
   * @param  {Object} activity
   * @return {String}
   */
  getEventName(activity) {
    const map = {
      open: "Email Opened",
      sent: "Email Sent",
      bounce: "Email Bounced",
      click: "Email Link Clicked",
      unsub: "Unsubscribed"
    };

    return _.get(map, activity.action, activity.action);
  }

  /**
   * @param  {Object} activity
   * @return {Object}
   */
  getEventProperties(activity, email) {
    const defaultProps = {
      timestamp: activity.timestamp,
      campaign_name: activity.title || "",
      campaign_id: activity.campaign_id,
      list_id: email.list_id,
      list_name: this.credentials.mailchimp_list_name,
      // TODO add ip, available here:
      // http://developer.mailchimp.com/documentation/mailchimp/reference/reports/email-activity
      // TODO add email_subject, available here:
      // http://developer.mailchimp.com/documentation/mailchimp/reference/campaigns/#read-get_campaigns
      // campaings.settings.subject_line
    };
    const props = {};

    switch (activity.action) {
      case "click":
        _.defaults(props, defaultProps, {
          link_url: activity.url
        });
        break;
      case "bounce":
        _.defaults(props, defaultProps, {
          type: activity.type
        });
        break;
      default:
        _.defaults(props, defaultProps);
    }

    return props;
  }
}
