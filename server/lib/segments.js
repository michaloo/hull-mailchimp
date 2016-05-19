import _ from "lodash";
import promisify from "./mailchimp-promise";
import crypto from "crypto";

export function findSegments(mailchimp, list = {}) {
  return promisify(mailchimp, {
    method: "get",
    path: `/lists/${list.id}/segments`
  });
}

export function createSegment(mailchimp, list = {}, segment = {}, batch = false) {
  const data = {
    method: "post",
    path: `/lists/${list.id}/segments`,
    body: {
      name: segment.name,
      static_segment: []
    }
  };
  if (batch) { return data; }
  return promisify(mailchimp, data);
}

// can't be batched;
export function createSegments(mailchimp, list = {}, segments = [], segmentMapping = {}, synchronizedSegments = []) {
  const synced = synchronizedSegments.length ? _.filter(segments, (s) => _.includes(synchronizedSegments, s.id)) : segments;
  const changes = _.map(
    _.filter(synced, segment => !segmentMapping[segment.id]),
    function createPromises(segment) {
      return createSegment(mailchimp, list, segment)
      .then(function joinSegments(response) {
        return { segment, mailchimp: response };
      });
    }
  );
  return Promise.all(changes);
}

export function deleteSegment(mailchimp, list = {}, mailchimpSegment) {
  return promisify(mailchimp, {
    method: "delete",
    path: `/lists/${list.id}/segments/${mailchimpSegment}`
  });
}

export function addUserToSegment(mailchimp, list = {}, mailchimpSegment, user, batch = false) {
  const data = {
    method: "post",
    path: `/lists/${list.id}/segments/${mailchimpSegment}/members`,
    body: {
      email_address: user.email,
      status: "subscribed"
    }
  };
  if (batch) { return data; }
  return promisify(mailchimp, data);
}

export function removeUserFromSegment(mailchimp, list = {}, mailchimpSegment, user, batch = false) {
  const h = crypto.createHash("md5").update((user.email || "").toLowerCase()).digest("hex");
  const data = {
    method: "delete",
    path: `/lists/${list.id}/segments/${mailchimpSegment}/members/${h}`
  };
  if (batch) { return data; }
  return promisify(mailchimp, data);
}

export function updateUserSegments({ mailchimp, list = {}, segmentMapping, user, segmentsIds, batch = false }) {
  const [included, excluded] = _.partition(_.keys(segmentMapping), id => _.includes(segmentsIds, id));

  const includedCalls = _.map(included, id => addUserToSegment(mailchimp, list, segmentMapping[id], user, true));
  const excludedCalls = _.map(excluded, id => removeUserFromSegment(mailchimp, list, segmentMapping[id], user, true));
  const calls = includedCalls.concat(excludedCalls);

  if (batch) { return calls; }
  return new Promise((resolve, reject) => {
    mailchimp.batch(calls, (err, result) => {
      if (err) { return reject(err); }
      return resolve(result);
    });
  });
}
