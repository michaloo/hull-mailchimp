import kue from "kue";
import QueueAgent from "./lib/queue/queue-agent";
import KueAdapter from "./lib/queue/adapter/kue";


import internalApp from "./internal-app";
import publicApp from "./public-app";

export function Server({ hostSecret }) {
  const queueAdapter = new KueAdapter(kue.createQueue({
    redis: process.env.REDIS_URL
  }));

  const queueAgent = new QueueAgent(queueAdapter);

  internalApp({
    hostSecret,
    queueAgent
  });

  return publicApp({ queueAgent });
}
