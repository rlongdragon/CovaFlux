import fp from "fastify-plugin";
import { applyCurrentPolicy } from "../modules/policy/policy.service.js";
import {
  createPolicyStore,
  enterPolicyContext,
  type PolicyTrackingStore
} from "./policyTracking.js";

declare module "fastify" {
  interface FastifyRequest {
    policyStore?: PolicyTrackingStore;
  }
}

/**
 * Automatic policy reapply.
 *
 * onRequest:  create a per-request policy-dirty store, bind it to the async
 *             context (so the Prisma extension's markPolicyDirty finds it during
 *             the handler) AND stash it on the request.
 * onResponse: read the dirty flag from request.policyStore — NOT via the async
 *             store. onResponse runs in a detached async context where
 *             AsyncLocalStorage.getStore() is undefined, so we must read the
 *             concrete store object we kept a reference to on the request.
 *
 * Routes no longer call applyCurrentPolicy() for DB-driven ACL changes — the
 * data layer drives it. The background reconciler remains the safety net for
 * changes that never pass through an HTTP request.
 */
export const registerPolicyAutoApply = fp(
  async (app) => {
    app.addHook("onRequest", async (request) => {
      const store = createPolicyStore();
      request.policyStore = store;
      enterPolicyContext(store);
    });

    app.addHook("onResponse", async (request, reply) => {
      // Only reapply for successful, mutating responses.
      if (reply.statusCode >= 400) return;
      if (!request.policyStore?.dirty) return;

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
