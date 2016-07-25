import Bottleneck from "bottleneck";

/**
 * Since Mailchimp has maximum connection limit:
 * http://developer.mailchimp.com/documentation/mailchimp/guides/error-glossary/#toomanyrequests
 * we need to throttle our requesting client.
 *
 * The limit is applied per API KEY basis, so we use the Cluster feature:
 * https://github.com/SGrondin/bottleneck#cluster
 */
const limiter = new Bottleneck.Cluster(10);
export default limiter;
