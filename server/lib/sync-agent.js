import _ from "lodash";
import URI from "urijs";
import CSVStream from "csv-stream";
import JSONStream from "JSONStream";
import request from "request";
import ps from "promise-streams";
import BatchStream from "batch-stream";

export default class SegmentSyncAgent {

  constructor(ship, hull, req) {
    this.ship = ship;
    this.hull = hull;
    this.req = req;
  }


  /** Interface to implement :
  * - _getCredentialKeys
  * - fetchAudiences
  * - createAudience
  * - deleteAudience
  * - removeUsersFromAudience
  * - addUsersToAudience
  */

 /**
   * Abstract method to implement - list all mandatory settings
   * @return {Array}
   */
  _getCredentialKeys() {
    throw new Error("Not Implemented");
  }

  /**
   * Returns the list of Audiences
   * @return {Promise -> Array<audience>}
   */
  fetchAudiences() {
    throw new Error("Not Implemented");
  }

  /**
   * Create an audience from a segment
   * @param  {Object} segment - A segment
   * @param  {Boolean} extract - Start an extract job to batch sync the segment
   * @return {Promise -> audience}
   */
  createAudience(segment, extract = true) {
    throw new Error("Not Implemented");
  }

  /**
   * Delete an audience a segment
   * @param  {String} audienceId - An audience ID
   * @param  {String} segmentId - A segment ID
   * @return {Promise -> audience}
   */
  deleteAudience(audienceId, segmentId) {
    throw new Error("Not Implemented");
  }

  /**
   * Removes a list of users from an audience
   * @param  {String} audienceId - An audience ID
   * @param  {Array<user>} users - A list of users
   * @return {Promise}
   */
  removeUsersFromAudience(audienceId, users = []) {
    throw new Error("Not Implemented");
  }

  /**
   * Adds a list of users to an audience
   * @param  {String} audienceId - An audience ID
   * @param  {Array<user>} users - A list of users
   * @return {Promise}
   */
  addUsersToAudience(audienceId, users = []) {
    throw new Error("Not Implemented");
  }

  /**
   * Get the mandatory credentials from the ship's settings
   * @return {Object}
   */
  getCredentials() {
    const private_settings = this.ship.private_settings;
    return _.pick(private_settings || {}, this._getCredentialKeys());
  }

  /**
   * Checks if all mandatory settings are set and is the ship is fully configured
   * @return {Boolean}
   */
  isConfigured() {
    const keys = this._getCredentialKeys();
    const vals = this.getCredentials();
    return _.every(keys, k => !_.isEmpty(vals[k]));
  }

  /**
   * Check if user is one of the segments selected in ship configuration.
   * If there is no segment filter always return true.
   *
   * @param  {Object} user - user to check
   * @return {Boolean}
   */
  shouldSyncUser(user) {
    const segmentIds = this.getPrivateSetting("synchronized_segments") || [];
    if (segmentIds.length === 0) {
      return true;
    }
    return _.intersection(segmentIds, user.segment_ids).length > 0;
  }

  /**
   * Ship private setting getter
   * @param  {String} key - key name
   * @return {String}
   */
  getPrivateSetting(key) {
    let value;
    if (this.ship && this.ship.private_settings) {
      value = this.ship.private_settings[key];
    }
    return value;
  }

  /**
   * Returns the audience mapped to a segment
   * @param  {Object} segment - A segment
   * @return {Object} audience
   */
  getAudienceForSegment(segment) {
    return this.getAudiencesBySegmentId().then(
      audiences => audiences[segment.id].audience
    );
  }

  /**
   * Returns the audience mapped to a segment
   * creates it if it does not exist
   * @param  {Object} segment - A segment
   * @return {Object} audience
   */
  getOrCreateAudienceForSegment(segment) {
    return this.getAudienceForSegment(segment).then(
      audience => audience || this.createAudience(segment)
    );
  }

  /**
   * Handler for `ship:update` notification.
   * Ensures that synchronized_audiences
   * defined in the ship's settings exist
   * @return {Promise}
   */
  handleShipUpdate(extract = true) {
    this.hull.utils.log("handleShipUpdate");
    return this.getAudiencesBySegmentId().then((segments = {}) => {
      return Promise.all(_.map(segments, item => {
        return item.audience || this.createAudience(item.segment, extract);
      }));
    });
  }


  /**
   * Handler for `user_report:update` notification.
   * @param  {Object} user - A User
   * @param  {Object} changes - Changes properties for the user
   * @param  {Array} segments - The list of segment the user belongs to
   * @return {undefined}
   */
  handleUserUpdate({ user, changes = {}, segments = [] }) {
    user.segment_ids = user.segment_ids || segments.map(s => s.id);
    if (_.isEmpty(user["traits_mailchimp/unique_email_id"])) {
      this.hull.utils.log("User has empty unique_email_id trait");
      segments.map((segment) => this.handleUserEnteredSegment(user, segment));
    } else {
      const { entered = [], left = [] } = changes.segments || {};
      this.hull.utils.log("User has unique_email_id trait", changes.segments);
      entered.map((segment) => this.handleUserEnteredSegment(user, segment));
      left.map((segment) => this.handleUserLeftSegment(user, segment));
    }
  }

  /**
   * The user just entered the segment
   * Check if the user belongs to any segment in the synchronized_segments list.
   * Ensure that the audience exists then add the user to the mapped audience
   * @param  {Object} user - A user
   * @param  {Object} segment - A segment
   * @return {undefined}
   */
  handleUserEnteredSegment(user, segment) {
    return this.shouldSyncUser(user) &&
      this.getOrCreateAudienceForSegment(segment).then(audience =>
        audience && this.addUsersToAudiences([user])
      );
  }

  /**
   * The user just left the segment.
   * Check if the user belongs to any segment in the synchronized_segments list.
   * Ensure that the audience exists then remove the user to the mapped audience
   * @param  {Object} user - A user
   * @param  {Object} segment - A segment
   * @return {Promise}
   */
  handleUserLeftSegment(user, segment) {
    return this.getOrCreateAudienceForSegment(segment).then(audience => {
      // the user is still within whitelisted segments
      // remove him/her only from the audience which he left
      if (this.shouldSyncUser(user)) {
        return audience && this.removeUsersFromAudience(audience.id, [user]);
      }
      // if he/she left the filtered segments remove it from all audiences
      return audience && this.removeUsersFromAudiences([user]);
    });
  }

  /**
   * Handler for `segment:update` notification.
   * Ensure that the audience exists and then triggers extract for that segment
   * to make sure users are synced
   * @param  {Object} segment - A segment
   * @return {Promise}
   */
  handleSegmentUpdate(segment) {
    return this.getOrCreateAudienceForSegment(segment)
      .then(() => {
        return this.requestExtract({ segment });
      });
  }

  /**
   * Handler for `segment:delete` notification.
   * Try to get the audience, delete it if it exists
   * @param  {Object} segment - A segment
   * @return {undefined}
   */
  handleSegmentDelete(segment) {
    // since the deleted segment is not returned by Hull `/segments` API endpoint
    // we cannot use fetchAudiencesBySegmentId method, we need to use saved
    // segments to audiences mapping
    const mapping = this.getPrivateSetting("segment_mapping") || {};
    const audienceId = mapping[segment.id] || null;

    return audienceId && this.deleteAudience(audienceId, segment.id)
    .catch(err => console.warn("error deleting audience: ", err));
  }

  _getExtractFields() {
    return [
      "id",
      "email",
      "first_name",
      "last_name"
    ];
  }

  /**
   * Start an extract job and be notified with the url when complete.
   * @param  {Object} segment - A segment
   * @param  {String} format - csv or json
   * @return {Promise}
   */
  requestExtract({ segment = null, format = "json" }) {
    const { hostname } = this.req;
    const search = (this.req.query || {});
    const url = URI(`https://${hostname}`)
      .path("batch")
      .search(search)
      .toString();

    const fields = this._getExtractFields();

    return (() => {
      if (segment == null) {
        return Promise.resolve({
          query: {}
        });
      }

      if (segment.query) {
        return Promise.resolve(segment);
      }
      return this.hull.get(segment.id);
    })()
    .then(({ query }) => {
      const params = { query, format, url, fields };
      return this.hull.post("extract/user_reports", params);
    });
  }


  /**
   * Save the mapping of segment to audience IDs in the Ship's settings
   * @param  {String} segmentId - A Segment ID
   * @param  {String} audienceId - An Audience ID
   * @return {Promise -> ship}
   */
  saveAudienceMapping(segmentId, audienceId) {
    return this.hull.get(this.ship.id).then((ship) => {
      const private_settings = ship.private_settings || {};
      private_settings.segment_mapping = Object.assign(
        (private_settings.segment_mapping || {}),
        { [segmentId]: audienceId }
      );
      return this.hull.put(this.ship.id, { private_settings });
    });
  }


  /**
   * Wrapper for batch call handlers
   * Streams the data from the extract URL and calls a handler with batches of users
   * @param  {String}
   * @param  {String}
   * @param  {Function}
   * @return {Promise}
   */
  handleExtract({ url, format }, callback) {
    if (!url) return Promise.reject(new Error("Missing URL"));
    const decoder = format === "csv" ? CSVStream.createStream({ escapeChar: "\"", enclosedChar: "\"" }) : JSONStream.parse();

    const batch = new BatchStream({ size: 500 });

    return ps.wait(request({ url })
      .pipe(decoder)
      .pipe(batch)
      .pipe(ps.map({ concurrent: 2 }, callback))
    );
  }

  /**
   * Gets memoized list of audiences indexed by segmentId.
   * It is basically a memory caching proxy for fetchAudiencesBySegmentId method.
   * @return {Promise -> Array<audience>}
   */
  getAudiencesBySegmentId() {
    if (this._audiences) {
      return Promise.resolve(this._audiences);
    }
    return this.fetchAudiencesBySegmentId().then(audiences => {
      this._audiences = audiences;
      return audiences;
    });
  }

  /**
   * Fetch all Hull segments.
   * @return {Promise -> Array<segment>}
   */
  fetchHullSegments() {
    return this.hull.get("segments", { limit: 500 });
  }

  /**
   * Fetch only these Hull segments which are included in "synchronized_segments"
   * ship setting.
   * @return {Promise -> Array<segment>}
   */
  fetchSyncHullSegments() {
    const segmentIds = this.getPrivateSetting("synchronized_segments") || [];
    if (!segmentIds) {
      return Promise.resolve([]);
    }
    return this.hull.get("segments", { where: {
      id: { $in: segmentIds }
    } });
  }

  /**
   * Downloads all Hull Segments and all Audiences and then maps them
   * together and returns it grouped by Hull Segments ids.
   * @return {Promise -> Array}
   */
  fetchAudiencesBySegmentId() {
    const mapping = this.getPrivateSetting("segment_mapping") || {};
    return Promise.all([
      this.fetchHullSegments(),
      this.fetchAudiences()
    ]).then(([segments = [], audiences = []]) => {
      const audiencesById = {};
      const audiencesByName = {};
      audiences.map((audience) => {
        audiencesById[audience.id] = audience;
        audiencesByName[audience.name] = audience;
        return audience;
      });
      const audiencesBySegmentId = segments.reduce((res, segment) => {
        const audienceId = mapping[segment.id];
        const audience = audiencesById[audienceId] || audiencesByName[segment.name];
        res[segment.id] = { segment, audience };
        return res;
      }, {});
      return audiencesBySegmentId;
    }, (err) => console.log(err));
  }

}
