/* global describe, it */
const assert = require("assert");
import Promise from "bluebird";
import sinon from "sinon";

import MailchimpAgent from "../server/lib/mailchimp-agent";


describe("MailchimpAgent", () => {
  describe("createAudience", () => {

    it(`should return audience when there is an exisiting static segment in mailchimp`, () => {

      class MailchimpClientStub {
        constructor() {
          this.client = {
            batch() {
              return new Promise.resolve({ segments: [
                { name: "testSegment" }
              ] });
            }
          }
        }
      }

      const mailchimpAgent = new MailchimpAgent({}, {}, {}, MailchimpClientStub);

      return mailchimpAgent.createAudience({ name: "testSegment" })
        .then(res => {
          assert.deepEqual(res, { name: "testSegment" });
        });
    });

    it(`should create and return an audience when there is no an exisiting static segment`, () => {

      class MailchimpClientStub {
        constructor() {
          this.client = {
            batch() {
              return new Promise.resolve({ segments: [] });
            }
          }
        }
      }


      const mailchimpAgent = new MailchimpAgent({}, {}, {}, MailchimpClientStub);

      mailchimpAgent.request = sinon.stub();
      mailchimpAgent.saveAudienceMapping = sinon.stub();

      mailchimpAgent.request.onCall(0)
      .returns(new Promise.resolve({
        id: 123,
        name: 'test',
        type: 'static'
      }));

      mailchimpAgent.saveAudienceMapping.onCall(0)
        .returns((new Promise.resolve([])))

      return mailchimpAgent.createAudience({ name: "testSegment" }, false)
        .then(res => {
          assert.deepEqual(res, {
            id: 123,
            isNew: true,
            type: "static",
            name: "test"
          });
        });
    });
  });
});
