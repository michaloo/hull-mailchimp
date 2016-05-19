import Promise from "bluebird";

export default function promisify(mailchimp, data = {}) {
  return new Promise((resolve, reject) => {
    if (!mailchimp) {
      return reject("No Mailchimp instance");
    }
    console.log("-----------------------Talking to Mailchimp");
    console.log(data);
    return mailchimp.request(data, (err, result) => {
      if (err) {
        console.log("Error taking to Mailchimp", err, result);
        return reject(err);
      }
      return resolve(result);
    });
  });
}
