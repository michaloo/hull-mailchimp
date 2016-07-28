/* global describe, it */
import assert from "assert";
import sinon from "sinon";
import Promise from "bluebird";
import moment from "moment";
import Hull from "hull";

import MailchimpClient from "../server/lib/mailchimp-client";
import CampaignAgent from "../server/lib/campaign-agent";

const mailchimpClient = {
  request: function() {},
  batch: function() {}
};

const hullClient = {
  logger: {
    info: function() {}
  }
};
const hullClientMock = sinon.mock(hullClient);

describe("CampaignAgent", function CampaignAgentTest() {
  this.timeout(100000);

  const privateSettings = {
    mailchimp_list_id: "test"
  };

  describe("getTrackableCampaigns", () => {
    it("should query mailchimp for campaigns sent since last week", () => {
      const mailchimpClientMock = sinon.mock(mailchimpClient);
      mailchimpClientMock.expects("request")
        .once()
        .withExactArgs({
          path: "/campaigns",
          query: {
            fields: "campaigns.id,campaigns.status,campaigns.title",
            list_id: privateSettings.mailchimp_list_id,
            since_send_time: moment().subtract(1, "week").format()
          },
        })
        .returns(Promise.resolve({
          campaigns: [
            {
              id: "test1",
              status: "draft",
              title: "test1",
            },
            {
              id: "test2",
              status: "sent",
              title: "test2",
            },
          ]
        }));

      const agent = new CampaignAgent(mailchimpClient, hullClient, privateSettings);

      return agent.getTrackableCampaigns()
        .then(res => {
          mailchimpClientMock.verify();
          assert.deepEqual(res, [{
            id: "test2",
            status: "sent",
            title: "test2",
          }]);
        });
    });
  });

  describe("getMemberActivities", () => {

    it("should return all activites for specified user", () => {

      const mailchimpClientMock = sinon.mock(mailchimpClient);
      mailchimpClientMock.expects("batch")
        .once()
        .withExactArgs([{
          method: "get",
          path: `/lists/test/members/ffad177299613c50982e95a32c60adc7/activity`,
        }])
        .returns(Promise.resolve([{
          activity: [ { action: 'bounce',
            timestamp: '2016-07-12T11:06:04+00:00',
            type: 'hard',
            campaign_id: 'fcd1ff3598' },
          { action: 'bounce',
            timestamp: '2016-07-12T11:02:19+00:00',
            type: 'hard',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test' },
          { action: 'sent',
            timestamp: '2016-07-12T11:02:17+00:00',
            type: 'regular',
            campaign_id: 'fcd1ff3598' },
          { action: 'sent',
            timestamp: '2016-07-12T10:58:09+00:00',
            type: 'regular',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test' } ],
          email_id: 'ffad177299613c50982e95a32c60adc7',
          list_id: '319f54214b',
        }]));

      const agent = new CampaignAgent(mailchimpClient, hullClient, privateSettings);

      return agent.getMemberActivities([{
        email_address: "bouncer@michaloo.net",
      }])
      .then(res => {
        mailchimpClientMock.verify();
        assert.deepEqual(res, [{
          activity: [ { action: 'bounce',
            timestamp: '2016-07-12T11:06:04+00:00',
            type: 'hard',
            campaign_id: 'fcd1ff3598' },
          { action: 'bounce',
            timestamp: '2016-07-12T11:02:19+00:00',
            type: 'hard',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test' },
          { action: 'sent',
            timestamp: '2016-07-12T11:02:17+00:00',
            type: 'regular',
            campaign_id: 'fcd1ff3598' },
          { action: 'sent',
            timestamp: '2016-07-12T10:58:09+00:00',
            type: 'regular',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test' } ],
          email_address: "bouncer@michaloo.net",
          email_id: 'ffad177299613c50982e95a32c60adc7',
          list_id: '319f54214b'
        }]);
      });
    });

    it("should return activites more recent than latest_activity", () => {

      const mailchimpClientMock = sinon.mock(mailchimpClient);
      mailchimpClientMock.expects("batch")
        .once()
        .withExactArgs([{
          method: "get",
          path: `/lists/test/members/ffad177299613c50982e95a32c60adc7/activity`,
        }])
        .returns(Promise.resolve([{
          activity: [ { action: 'bounce',
            timestamp: '2016-07-12T11:06:04+00:00',
            type: 'hard',
            campaign_id: 'fcd1ff3598' },
          { action: 'bounce',
            timestamp: '2016-07-12T11:02:19+00:00',
            type: 'hard',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test' },
          { action: 'sent',
            timestamp: '2016-07-12T11:02:17+00:00',
            type: 'regular',
            campaign_id: 'fcd1ff3598' },
          { action: 'sent',
            timestamp: '2016-07-12T10:58:09+00:00',
            type: 'regular',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test' } ],
          email_id: 'ffad177299613c50982e95a32c60adc7',
          list_id: '319f54214b',
        }]));

      const agent = new CampaignAgent(mailchimpClient, hullClient, privateSettings);

      return agent.getMemberActivities([{
        email_address: "bouncer@michaloo.net",
        "traits_mailchimp/latest_activity": "2016-07-12T11:02:17+00:00"
      }])
      .then(res => {
        mailchimpClientMock.verify();
        assert.deepEqual(res, [{
          activity: [ { action: 'bounce',
            timestamp: '2016-07-12T11:06:04+00:00',
            type: 'hard',
            campaign_id: 'fcd1ff3598' },
          { action: 'bounce',
            timestamp: '2016-07-12T11:02:19+00:00',
            type: 'hard',
            campaign_id: '2c4a24e9df',
            title: 'Hull bounce test'
          }],
          email_address: "bouncer@michaloo.net",
          email_id: 'ffad177299613c50982e95a32c60adc7',
          list_id: '319f54214b'
        }]);
      });
    });

  });
});
