import internalApp from "./internal-app";
import publicApp from "./public-app";

export function Server({ hostSecret }) {
  internalApp({
    hostSecret
  });

  return publicApp();
}
