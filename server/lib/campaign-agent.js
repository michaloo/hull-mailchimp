import Promise from "bluebird";
import moment from "moment";

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
   * Gets a flatten array of emails with their activites done in specified campaigns.
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
   * For every provided email and it's activity call Hull Track endpoint.
   * @param  {Array} emails
   * @return {Promise}
   */
  trackEvents(emails) {
    const emailTracks = emails.map(email => {
      const user = this.hull.as({ email: email.email_address });

      const tracks = email.activity.map(a => {
        return user.track(a.action, {
          // title: 3,
          timestamp: a.timestamp,
          campaign_id: email.campaign_id,
          ip: a.ip,
        }, {
          source: "mailchimp",
          ip: a.ip,
          created_at: a.timestamp
        });
      });

      return tracks;
    });

    return Promise.all([].concat.apply([], emailTracks));
  }
}
