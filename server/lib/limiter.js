import Bottleneck from "bottleneck";

/**
 * Since Mailchimp has maximum connection limit:
 * http://developer.mailchimp.com/documentation/mailchimp/guides/error-glossary/#toomanyrequests
 * we need to throttle our requesting client.
 *
 * The limit is applied per API KEY, so we use the Cluster feature:
 * https://github.com/SGrondin/bottleneck#cluster
 * and set it lower than allowed since there are now some queries from admin
 * panel done outside the MailchimpClient class
 */
const limiter = new Bottleneck.Cluster(8);
export default limiter;
