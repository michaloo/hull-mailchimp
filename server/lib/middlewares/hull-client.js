import jwt from "jwt-simple";
import Hull from "hull";

const shipToken = process.env.SHIP_TOKEN || "3095jv02939jfd";

export default function (options) {
  const _cache = [];

  function getCurrentShip(shipId, client, forceUpdate) {
    if (options.useCache) {
      if (forceUpdate) _cache[shipId] = null;
      _cache[shipId] = _cache[shipId] || client.get(shipId);
      return _cache[shipId];
    }
    return client.get(shipId);
  }

  function parseConfig(query) {
    return ["organization", "ship", "secret"].reduce((cfg, k) => {
      const val = query[k];
      if (typeof val === "string") {
        cfg[k] = val;
      } else if (val && val.length) {
        cfg[k] = val[0];
      }

      if (typeof cfg[k] === "string") {
        cfg[k] = cfg[k].trim();
      }

      return cfg;
    }, {});
  }

  return function hullClient(req, res, next) {
    const startAt = new Date();

    req.hull = req.hull || { timings: {} };
    req.hull.timings = req.hull.timings || {};

    let query = {};
    if (req.query.hullToken) {
      try {
        query = jwt.decode(req.query.hullToken, shipToken);
      } catch (e) {
        console.log("Invalid hullToken passed", req.query.hullToken);
      }
    }

    const config = parseConfig({ ...req.query, ...query });
    const forceShipUpdate = false;

    function done() {
      req.hull.timings.fetchShip = new Date() - startAt;
      next();
    }

    if (config.organization && config.ship && config.secret) {
      const client = req.hull.client = new Hull({
        id: config.ship,
        organization: config.organization,
        secret: config.secret
      });

      req.hull.hullToken = jwt.encode({
        ship: config.ship,
        organization: config.organization,
        secret: config.secret
      }, shipToken);

      if (options.fetchShip) {
        getCurrentShip(config.ship, client, forceShipUpdate).then((ship) => {
          req.hull.ship = ship;
          done();
        }, (err) => {
          res.status(404);
          res.status({ reason: "ship_not_found", message: "Ship not found" });
          res.end(`Error: ${err.toString()}`);
        });
      } else {
        done();
      }
    } else {
      res.status(401);
      res.send({ reason: "hull_auth", message: "Missing Hull credentials" });
      res.end();
    }
  };
}
