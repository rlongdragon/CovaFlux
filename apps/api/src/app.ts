import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import { registerDbPlugin } from "./plugins/db.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHeadscalePlugin } from "./plugins/headscale.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { nodesRoutes } from "./modules/nodes/nodes.routes.js";
import { groupsRoutes } from "./modules/groups/groups.routes.js";
import { sharesRoutes } from "./modules/shares/shares.routes.js";
import { invitesRoutes } from "./modules/invites/invites.routes.js";
import { policyRoutes } from "./modules/policy/policy.routes.js";
import { apiTokensRoutes } from "./modules/api-tokens/api-tokens.routes.js";
import { auditLogsRoutes } from "./modules/audit-logs/audit-logs.routes.js";
import { bootstrapAdmin } from "./modules/users/users.service.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  registerErrorHandler(app);
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = body.toString();
      if (text.trim().length === 0) {
        done(null, {});
        return;
      }

      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error);
      }
    }
  );
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"]
  });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(registerDbPlugin);
  await app.register(registerHeadscalePlugin);
  await app.register(registerAuthPlugin);

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(nodesRoutes);
  await app.register(groupsRoutes);
  await app.register(sharesRoutes);
  await app.register(invitesRoutes);
  await app.register(policyRoutes);
  await app.register(apiTokensRoutes);
  await app.register(auditLogsRoutes);

  app.addHook("onReady", async () => {
    await bootstrapAdmin(app.prisma, app.headscale);
  });

  return app;
}
