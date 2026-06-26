import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request policy-dirty tracking.
 *
 * The ACL/policy output produced by generatePolicy() is a pure function of a
 * closed set of Prisma models (see POLICY_MODELS). Instead of asking every route
 * to remember to call applyCurrentPolicy() after mutating one of those models,
 * a Prisma client extension (see plugins/db.ts) marks the current request dirty
 * whenever a write hits a policy model. An onResponse hook then reapplies policy
 * exactly once per successful request. This makes "forgot to reapply ACL" a
 * structurally impossible class of bug for DB-driven changes.
 *
 * Runtime-only changes that do NOT touch a tracked model (e.g. expiring a node
 * directly in Headscale) must still call markPolicyDirty() explicitly.
 */

export interface PolicyTrackingStore {
  dirty: boolean;
  /** When > 0, writes do not mark the request dirty (used to wrap node sync). */
  suppressDepth: number;
}

const storage = new AsyncLocalStorage<PolicyTrackingStore>();

export function createPolicyStore(): PolicyTrackingStore {
  return { dirty: false, suppressDepth: 0 };
}

/**
 * Bind a store to the current async context for the rest of the request.
 * enterWith (not run) is required: Fastify invokes the route handler as a
 * continuation of the onRequest async context, so enterWith makes getStore()
 * resolve to this request's store throughout the handler. Each request calls
 * enterWith with a FRESH store, so suppressDepth never carries over.
 */
export function enterPolicyContext(store: PolicyTrackingStore): void {
  storage.enterWith(store);
}

/** Mark the current request as needing a policy reapply (no-op outside a request). */
export function markPolicyDirty(): void {
  const store = storage.getStore();
  if (store && store.suppressDepth === 0) store.dirty = true;
}

export function isPolicyDirty(): boolean {
  return storage.getStore()?.dirty ?? false;
}

/**
 * Run fn with policy-dirty tracking suppressed. Writes performed inside fn do
 * not mark the request dirty — used to wrap Headscale->DB reconciliation so that
 * read endpoints (e.g. GET /nodes) don't trigger a reapply loop.
 */
export async function runSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store) return fn();
  store.suppressDepth += 1;
  try {
    return await fn();
  } finally {
    store.suppressDepth -= 1;
  }
}

/**
 * The single source of truth for which Prisma models feed generatePolicy().
 * A write to any of these must cause a policy reapply. The guard test in
 * policy.generator.guard.test.ts fails if generatePolicy reads a top-level
 * model that is not listed here.
 */
export const POLICY_MODELS = new Set<string>([
  "User",
  "Node",
  "NodeShare",
  "Group",
  "GroupMember"
]);

const WRITE_OPERATIONS = new Set<string>([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany"
]);

export function isPolicyWrite(model: string | undefined, operation: string): boolean {
  return Boolean(model) && POLICY_MODELS.has(model as string) && WRITE_OPERATIONS.has(operation);
}
