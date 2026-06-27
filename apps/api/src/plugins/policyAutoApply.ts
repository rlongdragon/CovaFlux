import fp from "fastify-plugin";
import { applyCurrentPolicy } from "../modules/policy/policy.service.js";
import {
  createPolicyStore,
  enterPolicyContext,
  type PolicyTrackingStore
} from "./policyTracking.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Number of times the auto-apply hook decided to reapply policy. Test/diagnostic aid. */
    policyAutoApplyCount: number;
  }
  interface FastifyRequest {
    policyStore?: PolicyTrackingStore;
  }
}

/**
 * Automatic policy reapply.
 *
 * onRequest:  create a per-request policy-dirty store, stash it on the request,
 *             and bind it to the async context with enterWith so the Prisma
 *             extension's markPolicyDirty finds THIS request's store throughout
 *             the handler. A fresh store per request means suppressDepth never
 *             bleeds into the next request.
 * onResponse: read the dirty flag from request.policyStore — onResponse runs in
 *             a detached async context where getStore() is undefined, so we read
 *             the concrete object we kept on the request.
 *
 * Routes no longer call applyCurrentPolicy() for DB-driven ACL changes — the
 * data layer drives it. The background reconciler remains the safety net for
 * changes that never pass through an HTTP request.
 */
export const registerPolicyAutoApply = fp(
  async (app) => {
    app.decorate("policyAutoApplyCount", 0);

    app.addHook("onRequest", async (request) => {
      const store = createPolicyStore();
      request.policyStore = store;
      enterPolicyContext(store);
    });

    app.addHook("onResponse", async (request, reply) => {
      // Only reapply for successful, mutating responses.
      if (reply.statusCode >= 400) return;
      if (!request.policyStore?.dirty) return;

      // The mechanism decided this request touched policy state. Count it even
      // if onlyIfChanged later dedups to a no-op — this is the signal that the
      // route correctly triggered an automatic reapply.
      app.policyAutoApplyCount += 1;

      try {
        await applyCurrentPolicy(app.prisma, app.headscale, request.actor, {
          onlyIfChanged: true
        });
      } catch (error) {
        // The response is already sent; never throw here. Surface loudly so a
        // failed reapply is visible — the background reconciler will retry.
        app.log.error(
          { err: error, url: request.url, method: request.method },
          "automatic policy reapply failed after policy-affecting write"
        );
      }
    });
  },
  { name: "policy-auto-apply", dependencies: [] }
);
