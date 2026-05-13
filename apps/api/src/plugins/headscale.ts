import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { MockHeadscaleClient } from "../services/headscale/MockHeadscaleClient.js";
import type { HeadscaleClient } from "../services/headscale/HeadscaleClient.js";

declare module "fastify" {
  interface FastifyInstance {
    headscale: HeadscaleClient;
  }
}

export const registerHeadscalePlugin = fp(async (app) => {
  if (env.HEADSCALE_CLIENT_MODE !== "mock") {
    app.log.warn("Real Headscale client is not implemented yet; falling back to mock client.");
  }

  app.decorate("headscale", new MockHeadscaleClient());
});

