import _ from "lodash";
import { deleteSegment, createSegment } from "./lib/segments";
import { findOrCreateList } from "./lib/list";
import Mailchimp from "mailchimp-api-v3";

function saveMapping({ hull = {}, ship = {}, segment = {}, mailchimpSegment = {} }) {
  const newMapping = {
    ...ship.private_settings.segment_mapping,
  };

  if (segment.id) {
    if (mailchimpSegment.id) {
      newMapping[segment.id] = mailchimpSegment.id;
    } else {
      delete newMapping[segment.id];
    }
  }

  return hull.put(ship.id, {
    private_settings: {
      ...ship.private_settings,
      segment_mapping: newMapping
    }
  });
}

export function updateUserSegment({ message: segment = {} }, { ship = {}, hull = {} }) {
  const { private_settings = {} } = ship;
  const { domain, api_key: apiKey, segment_mapping: segmentMapping = {}, synchronized_segments: synchronizedSegments = [] } = private_settings;

  if (!apiKey) {
    hull.utils.log("No API Key detected");
  }

  // segment is already saved.
  if (_.includes(_.keys(segmentMapping), segment.id)) {
    return;
  }

  // segment isn't in filtered list
  if (!_.includes(synchronizedSegments, segment.id)) {
    return;
  }

  const mailchimp = new Mailchimp(apiKey);
  mailchimp.__base_url = `https://${domain}.api.mailchimp.com/3.0`;

  findOrCreateList({ hull, mailchimp, ship })
  .then(list => createSegment(mailchimp, list, segment, synchronizedSegments))
  .then(mailchimpSegment => saveMapping({ hull, ship, segment, mailchimpSegment }));

  return;
}

export function deleteUserSegment({ message: segment = {} }, { ship = {}, hull = {} }) {
  const { private_settings = {} } = ship;
  const { domain, api_key: apiKey, segment_mapping: segmentMapping = {} } = private_settings;

  if (!apiKey) {
    hull.utils.log("No API Key detected");
  }

  // segment is already absent.
  if (!_.includes(_.keys(segmentMapping), segment.id)) {
    return;
  }

  const mailchimp = new Mailchimp(apiKey);
  mailchimp.__base_url = `https://${domain}.api.mailchimp.com/3.0`;

  findOrCreateList({ hull, mailchimp, ship })
  .then(list => deleteSegment(mailchimp, list, segment))
  .then(() => saveMapping({ hull, ship, segment }));

  return;
}
