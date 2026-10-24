import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import { registerDbPlugin } from "./plugins/db.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHeadscalePlugin } from "./plugins/headscale.js";
import { registerPolicyAutoApply } from "./plugins/policyAutoApply.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { nodesRoutes } from "./modules/nodes/nodes.routes.js";
import { groupsRoutes } from "./modules/groups/groups.routes.js";
import { sharesRoutes } from "./modules/shares/shares.routes.js";
import { invitesRoutes } from "./modules/invites/invites.routes.js";
import { policyRoutes } from "./modules/policy/policy.routes.js";
import { apiTokensRoutes } from "./modules/api-tokens/api-tokens.routes.js";
import { auditLogsRoutes } from "./modules/audit-logs/audit-logs.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { bootstrapAdmin } from "./modules/users/users.service.js";
import { reconcilePolicyOnce, startPolicyReconciler } from "./modules/policy/policyReconciler.js";
import { verifyAgainstDummy } from "./utils/secrets.js";

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY, bodyLimit: 256 * 1024 });

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
  // Auth is a bearer header, never a cookie, so credentials are not needed.
  // Only explicitly listed origins get CORS headers.
  const corsAnyOrigin = env.CORS_ORIGINS.includes("*");
  await app.register(cors, {
    origin: corsAnyOrigin ? "*" : env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"]
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
  });
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { algorithm: "HS256" },
    verify: { algorithms: ["HS256"] }
  });
  await app.register(registerDbPlugin);
  await app.register(registerHeadscalePlugin);
  await app.register(registerAuthPlugin);
  await app.register(registerPolicyAutoApply);

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(nodesRoutes);
  await app.register(groupsRoutes);
  await app.register(sharesRoutes);
  await app.register(invitesRoutes);
  await app.register(policyRoutes);
  await app.register(settingsRoutes);
  await app.register(apiTokensRoutes);
  await app.register(auditLogsRoutes);

  app.addHook("onReady", async () => {
    await bootstrapAdmin(app.prisma, app.headscale);
    await verifyAgainstDummy("warm-up");
    // Converge Headscale with the database once at startup, even when the
    // periodic loop is disabled: a policy change whose apply failed before a
    // restart must not stay unenforced.
    await reconcilePolicyOnce(app.prisma, app.headscale, app.log);

    if (env.POLICY_RECONCILE_INTERVAL_MS > 0) {
      const reconciler = startPolicyReconciler(app.prisma, app.headscale, {
        intervalMs: env.POLICY_RECONCILE_INTERVAL_MS,
        logger: app.log
      });
      app.addHook("onClose", async () => {
        reconciler.stop();
      });
      app.log.info(
        { intervalMs: env.POLICY_RECONCILE_INTERVAL_MS },
        "policy reconciler started"
      );
    }
  });

  return app;
}
