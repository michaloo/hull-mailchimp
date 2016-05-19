import crypto from "crypto";
import Promise from "bluebird";
import promisify from "./mailchimp-promise";

function getCampaignDefaults(hull) {
  return hull.get("org").then((org = {}) => {
    return {
      name: `[${org.name}] automatically created Hull List`,
      email_type_option: true,
      permission_reminder: "You're receiving this email because you signed up to this mailing list",
      contact: {
        company: org.name,
        address1: "675 Ponce De Leon Ave NE",
        address2: "Suite 5000",
        city: "Atlanta",
        state: "GA",
        zip: "30308",
        country: "US",
        phone: ""
      },
      campaign_defaults: {
        from_name: "You",
        from_email: "you@org.com",
        subject: "",
        language: "en"
      }
    };
  });
}

export function findOrCreateList({ hull, mailchimp, ship = {} }) {
  if (!ship.id) { return Promise.reject("No Ship!"); }

  const { private_settings = {} } = ship;
  const { list_id } = private_settings;

  // create a new list with default settings.
  function create() {
    return getCampaignDefaults(hull)
    .then(body => promisify(mailchimp, { method: "post", path: "/lists", body }))
    .then(list => {
      // save to settings if needed;
      // if doing so, reset the segment Mapping
      if (list_id !== list.id) {
        return hull
        .put(`${ship.id}`, {
          private_settings: {
            ...private_settings,
            list_id: list.id,
            segment_mapping: {}
          }
        })
        .then(() => {
          hull.utils.log("Saved List");
          return list;
        }, err => hull.utils.log("Error saving list", err));
      }
      return list;
    }, err => hull.utils.log(err));
  }


  if (list_id) {
    return promisify(mailchimp, {
      method: "get",
      path: `/lists/${list_id}`
    }).catch(create);
  }

  return create();
}

export function addUser({ mailchimp, list = {}, user = {}, batch = false }) {
  if (!user.email) {
    return Promise.reject("Invalid User");
  }
  const h = crypto.createHash("md5").update((user.email || "").toLowerCase()).digest("hex");
  const data = {
    method: "put",
    path: `/lists/${list.id}/members/${h}`,
    body: {
      email_type: "html",
      merge_fields: {
        FNAME: user.first_name,
        LNAME: user.last_name
      },
      email_address: user.email,
      status: "subscribed"
    }
  };
  console.log(data)
  if (batch) { return data; }
  return promisify(mailchimp, data).then(function userAdded(mailchimpUser) {
    return { list, mailchimpUser };
  });
}

export function getUser({ mailchimp, list = {}, user = {} }) {
  if (!user.email) {
    return Promise.reject("Invalid User");
  }
  const h = crypto.createHash("md5").update((user.email || "").toLowerCase()).digest("hex");
  return promisify(mailchimp, {
    method: "get",
    path: `/lists/${list.id}/members/${h}`,
  }).then(function userGet(mailchimpUser) {
    return { list, mailchimpUser };
  });
}

export function updateUser({ mailchimp, list = {}, user = {} }) {
  // if (!user.email) {
  //   return Promise.reject("Invalid User");
  // }
  // return promisify(mailchimp, {
  //   method: "patch",
  //   path: `/lists/${list.id}/members`,
  //   body: {
  //     email_type: "html",
  //     email_address: user.email,
  //   }
  // }).then(function userAdded(mailchimpUser) {
  //   return { list, mailchimpUser };
  // });
}
