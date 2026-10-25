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
 * onSend:     read the dirty flag from request.policyStore and reapply BEFORE
 *             the response is sent. If the apply fails the client gets a 503
 *             instead of a success that Headscale does not enforce (e.g. a
 *             revoked share that still grants access). The write itself is
 *             kept; the reconciler (and startup reconcile) keep retrying.
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

    app.addHook("onSend", async (request, reply, payload) => {
      // Only reapply for successful, mutating responses.
      if (reply.statusCode >= 400) return payload;
      if (!request.policyStore?.dirty) return payload;
      // Apply once per request even if onSend runs again for an error reply.
      request.policyStore.dirty = false;

      // The mechanism decided this request touched policy state. Count it even
      // if onlyIfChanged later dedups to a no-op — this is the signal that the
      // route correctly triggered an automatic reapply.
      app.policyAutoApplyCount += 1;

      try {
        await applyCurrentPolicy(app.prisma, app.headscale, request.actor, {
          onlyIfChanged: true
        });
        return payload;
      } catch (error) {
        app.log.error(
          { err: error, url: request.url, method: request.method },
          "automatic policy reapply failed after policy-affecting write"
        );
        reply.code(503).header("content-type", "application/json; charset=utf-8");
        return JSON.stringify({
          error: "policy_apply_failed",
          message: "The change was saved but could not be enforced in Headscale yet; it will be retried automatically."
        });
      }
    });
  },
  { name: "policy-auto-apply", dependencies: [] }
);
