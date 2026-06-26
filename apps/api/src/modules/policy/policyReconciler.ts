import type { PrismaClient } from "@prisma/client";
import type { HeadscaleClient } from "../../services/headscale/HeadscaleClient.js";
import { applyCurrentPolicy } from "./policy.service.js";

export interface ReconcileLogger {
  info(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

export interface ReconcileResult {
  applied: boolean;
  version?: number;
  error?: string;
}

/**
 * Sync Headscale runtime nodes into the database and re-apply the generated
 * policy when it changed. This is the safety net for nodes that join via a
 * pre-auth key: Headscale does not push a join event to CovaFlux, so without a
 * periodic reconcile the policy stays stale until an unrelated action (reading
 * /nodes, sharing a node, editing a group) happens to trigger applyCurrentPolicy.
 *
 * A stale policy is especially harmful for userspace-networking nodes, whose
 * tailscaled drops inbound TCP with "no rules matched" until the filter is
 * refreshed.
 */
export async function reconcilePolicyOnce(
  prisma: PrismaClient,
  headscale: HeadscaleClient,
  logger?: ReconcileLogger
): Promise<ReconcileResult> {
  try {
    // Pass no actor: audit() records this as a "system" actor automatically.
    const version = await applyCurrentPolicy(prisma, headscale, undefined, { onlyIfChanged: true });
    const result: ReconcileResult = { applied: Boolean(version), version: version?.version };
    if (result.applied) {
      logger?.info({ version: result.version }, "policy reconcile applied updated policy");
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error({ error: message }, "policy reconcile failed");
    return { applied: false, error: message };
  }
}

export interface PolicyReconcilerHandle {
  stop(): void;
}

/**
 * Start a periodic reconcile loop. Runs are serialized (no overlap) and the
 * timer is unref'd so it never keeps the process alive on its own.
 */
export function startPolicyReconciler(
  prisma: PrismaClient,
  headscale: HeadscaleClient,
  options: { intervalMs: number; logger?: ReconcileLogger }
): PolicyReconcilerHandle {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await reconcilePolicyOnce(prisma, headscale, options.logger);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);

  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
