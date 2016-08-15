import _ from "lodash";
import URI from "urijs";
import CSVStream from "csv-stream";
import JSONStream from "JSONStream";
import request from "request";
import ps from "promise-streams";
import BatchStream from "batch-stream";
import Promise from "bluebird";

export default class SegmentSyncAgent {

  constructor(ship, hull, req) {
    this.ship = ship;
    this.hull = hull;
    this.req = req;
  }


  /** Interface to implement :
  * - _getCredentialKeys
  * - fetchAudiences
  * - createAudiences
  * - deleteAudience
  * - removeUsersFromAudience
  * - addUsersToAudiences
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
   * @param  {Boolean} options.extract - Start an extract job to batch sync the segment
   * @param  {Boolean} options.save - Save in ship's mapping
   * @return {Promise -> audience}
   */
  createAudience(segment, options = { extract: false }) { // eslint-disable-line no-unused-vars
    throw new Error("Not Implemented");
  }

  /**
   * Create audiences from a list of segments and saves their IDs in the ship's mapping
   * @param  {Object} segment - A segment
   * @param  {Boolean} options.extract - Start an extract job to batch sync the segment
   * @param  {Boolean} options.reset - Reset the ship's mapping settings
   * @return {Promise -> audience}
   */
  createAudiences(segments, options) {
    const ops = segments.map(segment =>
      this.createAudience(segment, options)
        .then(audience => { return { segment, audience }; })
    );
    return Promise.all(ops).then(results => {
      const mapping = results.reduce((memo, { segment, audience }) => {
        return { ...memo, [segment.id]: audience.id };
      }, {});

      return this.saveAudiencesMapping(mapping, options.reset)
        .then(() => results);
    });
  }


  /**
   * Delete an audience a segment
   * @param  {String} audienceId - An audience ID
   * @param  {String} segmentId - A segment ID
   * @return {Promise -> audience}
   */
  deleteAudience(audienceId, segmentId) { // eslint-disable-line no-unused-vars
    throw new Error("Not Implemented");
  }

  /**
   * Removes a list of users from an audience
   * @param  {String} audienceId - An audience ID
   * @param  {Array<user>} users - A list of users
   * @return {Promise}
   */
  removeUsersFromAudience(audienceId, users = []) { // eslint-disable-line no-unused-vars
    throw new Error("Not Implemented");
  }

  /**
   * Adds a list of users to an audience
   * @param  {String} audienceId - An audience ID
   * @param  {Array<user>} users - A list of users
   * @return {Promise}
   */
  addUsersToAudience(audienceId, users = []) { // eslint-disable-line no-unused-vars
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
   * @param  {Object} options - options
   * @return {Object} audience
   */
  getOrCreateAudienceForSegment(segment, options = {}) {
    return this.getAudienceForSegment(segment).then(
      audience => audience || this.createAudiences([segment], options).then(res => res[0])
    );
  }

  /**
   * Handler for `ship:update` notification.
   * Ensures that synchronized_audiences
   * defined in the ship's settings exist
   * @return {Promise}
   */
  handleShipUpdate(extract = true, create = false) {
    this.hull.logger.info("handleShipUpdate");
    return this.getAudiencesBySegmentId().then((results = {}) => {
      const audiences = [];
      const audiencesToCreate = [];
      _.each(results, ({ audience, segment }) => {
        if (audience) {
          audiences.push(audience);
        } else {
          audiencesToCreate.push(segment);
        }
      });

      if (!create || audiencesToCreate.length === 0) {
        return Promise.resolve(audiences);
      }

      return this.createAudiences(audiencesToCreate, { extract })
        .then(newAudiences => audiences.concat(newAudiences));
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
      this.hull.logger.info("User has empty unique_email_id trait");
      segments.map((segment) => this.handleUserEnteredSegment(user, segment));
    } else {
      const { entered = [], left = [] } = changes.segments || {};
      this.hull.logger.info("User has unique_email_id trait", changes.segments);
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
      if (this.shouldSyncUser(user)) {
        return audience && this.removeUsersFromAudience(audience.id, [user]);
      }
      return this.removeUsersFromAudiences([user]);
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

    return audienceId &&
      this.deleteAudience(audienceId, segment.id);
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
  requestExtract({ segment = null, format = "json", path = "batch", fields = [] }) {
    const { hostname } = this.req;
    const search = (this.req.query || {});
    if (segment) {
      search.segment_id = segment.id;
    }
    const url = URI(`https://${hostname}`)
      .path(path)
      .search(search)
      .toString();

    if (_.isEmpty(fields)) {
      fields = this._getExtractFields();
    }

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
  saveAudiencesMapping(mapping, reset = false) {
    return this.hull.get(this.ship.id).then((ship) => {
      const private_settings = ship.private_settings || {};
      const current_mapping = reset ? {} : private_settings.segment_mapping;
      private_settings.segment_mapping = _.omitBy({
        ...current_mapping,
        ...mapping
      }, _.isNil);
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

    const batch = new BatchStream({ size: 100 });

    return request({ url })
      .pipe(decoder)
      .pipe(batch)
      .pipe(ps.map({ concurrent: 2 }, (...args) => {
        try {
          return callback(...args);
        } catch (e) {
          console.error(e);
          throw e;
        }
      }))
      .wait();
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
    this.hull.logger.info("fetchSyncHullSegments.segmentIds", segmentIds);
    if (_.isEmpty(segmentIds)) {
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
    }, (err) => this.hull.logger.error(err));
  }

}
