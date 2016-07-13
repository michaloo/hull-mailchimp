/* global describe, it */
import Hull from "hull";
import MailchimpClientClass from "../server/lib/mailchimp-client";
import CampaignAgent from "../server/lib/campaign-agent";


describe("CampaignAgent", function CampaignAgentTest() {
  this.timeout(100000);
  describe("getCampaignsToCheck", () => {
    it("run", () => {
      const client = new Hull({
        id: process.env.HULL_ID,
        organization: process.env.HULL_ORG,
        secret: process.env.HULL_SECRET,
      });
      return client.get(process.env.HULL_ID)
        .then((ship) => {
          const agent = new CampaignAgent(MailchimpClientClass, client, ship.private_settings);
          return agent.getTrackableCampaigns()
            .then(agent.getEmailActivities.bind(agent))
            .then(agent.trackEvents.bind(agent));
        })
        .then(res => console.log(res), err => console.error(err));
    });
  });
});
