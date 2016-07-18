import Promise from "bluebird";
import moment from "moment";
import _ from "lodash";

/**
 * CampaignAgent has methods to query Mailchimp for data relevant
 * for Hull Track API and to call Track API Endpoint
 */
export default class CampaignAgent {

  constructor(MailchimpClientClass, hull, credentials) {
    this.client = new MailchimpClientClass(credentials);
    this.hull = hull;
    this.credentials = credentials;
  }

  /**
   * Returns an array of campaigns which can have new events form members.
   * This are sent and being sent campaign not older than a week.
   * @return {Promise}
   */
  getTrackableCampaigns() {
    const weekAgo = moment().subtract(1, "week");

    return this.client.client.get({
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
   * and then flattens it to return one array for every campaign requested.
   * Returns only emails with some activities.
   * @param  {Array} campaigns
   * @return {Promise}
   */
  getEmailActivities(campaigns) {
    const queries = campaigns.map(c => {
      return {
        method: "get",
        path: `/reports/${c.id}/email-activity/`,
        // query: { fields: "sent_to.email_id,sent_to.email_address" },
      };
    });
    return this.client.client.batch(queries)
      .then((results) => {
        return [].concat.apply([], results.map(r => r.emails))
          .filter(r => r.activity.length > 0);
      });
  }

  /**
   * This method takes information downloaded by getEmailActivities
   * and use it to enrich members/activity endpoint data
   * @param  {Array} emails
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
   * @return {Promise}
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
   */
  getMemberActivities(emails) {
    const queries = _.uniqWith(emails.map(e => {
      return {
        method: "get",
        path: `/lists/${e.list_id}/members/${e.email_id}/activity`,
      };
    }), _.isEqual);

    return this.client.client.batch(queries)
      .then((results) => {
        // this part is responsible for filling `getMemberActivities`
        // data with more information from `getEmailActivities`
        // namely the email_address and ip information of "open" action
        emails.forEach(e => {
          const member = _.find(results, { email_id: e.email_id });
          member.email_address = e.email_address;

          e.activity.forEach(a => {
            const m = _.find(results, {
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
        });

        return results;
      });
  }

  /**
   * For every provided email and its activity call Hull Track endpoint.
   * @param  {Array} emails
   * [{
   *   activity: [ [Object] ],
   *   email_id: "039817b3448c634bfb35f33577e8b2b3",
   *   list_id: "319f54214b",
   *   email_address: "michaloo+4@gmail.com"
   * }]
   * @return {Promise}
   */
  trackEvents(emails) {
    const emailTracks = emails.map(email => {
      const user = this.hull.as({ email: email.email_address });

      return email.activity.map(a => {
        return user.track(a.action, {
          type: a.type || "",
          title: a.title || "",
          timestamp: a.timestamp,
          campaign_id: a.campaign_id,
        }, {
          source: "mailchimp",
          ip: a.ip,
          created_at: a.timestamp
        });
      });
    });

    return Promise.all([].concat.apply([], emailTracks));
  }
}
