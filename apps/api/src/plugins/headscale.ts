import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { MockHeadscaleClient } from "../services/headscale/MockHeadscaleClient.js";
import { RestHeadscaleClient } from "../services/headscale/RestHeadscaleClient.js";
import type { HeadscaleClient } from "../services/headscale/HeadscaleClient.js";

declare module "fastify" {
  interface FastifyInstance {
    headscale: HeadscaleClient;
  }
}

export const registerHeadscalePlugin = fp(async (app) => {
  if (env.HEADSCALE_CLIENT_MODE === "rest") {
    if (!env.HEADSCALE_API_KEY) {
      throw new Error("HEADSCALE_API_KEY is required when HEADSCALE_CLIENT_MODE=rest");
    }
    app.decorate("headscale", new RestHeadscaleClient(env.HEADSCALE_BASE_URL, env.HEADSCALE_API_KEY, app.log));
    return;
  }

  app.decorate("headscale", new MockHeadscaleClient());
});
