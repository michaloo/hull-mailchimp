/* global describe, it */
import assert from "assert";
import Promise from "bluebird";
import sinon from "sinon";
import proxyquire from "proxyquire";

describe("MailchimpClient", () => {
  describe("batch", () => {
    it(`should return an array in microbatch in successfull query`, () => {
      class MailchimpStub {
        request(params) {
          return new Promise.resolve({ res: "test" });
        }
      }
      const MailchimpClient = proxyquire("../server/lib/mailchimp-client", { 'mailchimp-api-v3': MailchimpStub }).default;

      const mailchimpClient = new MailchimpClient({});

      return mailchimpClient.batch([{ path: "test", method: "get" }])
        .then(res => {
          assert.deepEqual(res, [{ res: "test" }]);
        });
    });

    it(`should return an error in microbatch in rejected query`, () => {

      class MailchimpStub {
        request(params) {
          return new Promise.reject("Internal server error");
        }
      }
      const MailchimpClient = proxyquire("../server/lib/mailchimp-client", { 'mailchimp-api-v3': MailchimpStub }).default;

      const mailchimpClient = new MailchimpClient({});

      return mailchimpClient.batch([{ path: "test", method: "get" }])
        .then(res => {
          assert.deepEqual(res, ["Internal server error"]);
        });
    });
  });
});
