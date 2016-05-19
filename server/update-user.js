import _ from "lodash";
import Mailchimp from "mailchimp-api-v3";
import { findOrCreateList, addUser, getUser } from "./lib/list";
import { updateUserSegments } from "./lib/segments";

export default function updateUser({ message = {} }, { ship = {}, hull = {} }) {
  const { user = {}, segments = [] } = message;
  const { private_settings = {} } = ship;
  const { domain, api_key: apiKey, segment_mapping: segmentMapping = {}, synchronized_segments: synchronizedSegments = [] } = private_settings;

  if (!ship || !user || !user.id || !apiKey || !domain) {
    hull.utils.log("Skip update: who is this", { user, ship, apiKey });
    return false;
  }

  // user isn't in any matching segment
  if (synchronizedSegments.length && !_.intersection(synchronizedSegments, _.map(segments, "id")).length) {
    return false;
  }

  const mailchimp = new Mailchimp(apiKey);
  mailchimp.__base_url = `https://${domain}.api.mailchimp.com/3.0`;

  let promise = findOrCreateList({ hull, mailchimp, ship });

  const mcProps = user.mailchimp || {};
  if (!mcProps.unique_email_id) {
    promise = promise.then(list => addUser({ mailchimp, list, user }));
  } else {
    promise.then(list => getUser({ mailchimp, list, user }));
  }

  promise.then(({ mailchimpUser }) => {
    const mcp = {
      ..._.pick(mailchimpUser, "unique_email_id", "status", "member_rating", "language", "vip", "email_client"),
      ...mailchimpUser.stats
    };

    hull.utils.log("Updating Hull User", _.isEqual(mcp, mcProps), mcp);
    if (!_.isEqual(mcp, mcProps)) {
      hull.as(user.id).traits(mcp, { source: "mailchimp" });
    }

    return;
  });

  promise.then(({ list }) => updateUserSegments({ mailchimp, list, user, segments: _.map(segments, "id"), segmentMapping }));

  return true;
}
