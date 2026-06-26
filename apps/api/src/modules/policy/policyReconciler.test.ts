import { describe, expect, it, vi } from "vitest";
import type { HeadscaleClient, HeadscalePolicy } from "../../services/headscale/HeadscaleClient.js";
import { reconcilePolicyOnce, startPolicyReconciler } from "./policyReconciler.js";

function createPrismaMock() {
  return {
    user: {
      findMany: vi.fn(async () => [{ id: "u1", username: "alice", disabledAt: null }]),
      findUnique: vi.fn(async () => ({ id: "u1", username: "alice", headscaleUserName: "alice" }))
    },
    node: {
      findMany: vi.fn(async () => [
        {
          headscaleNodeId: "1",
          name: "alice-node",
          givenName: "alice-node",
          owner: { username: "alice" },
          shares: []
        }
      ]),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "n1",
        ...create,
        owner: { id: "u1", username: "alice" }
      })),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    preAuthKey: {
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({}))
    },
    policyVersion: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "pv1", ...data }))
    },
    auditLog: {
      create: vi.fn(async () => ({}))
    }
  } as never;
}

function createHeadscaleMock(currentPolicy: HeadscalePolicy) {
  return {
    listNodes: vi.fn(async () => [
      {
        id: "1",
        userName: "alice",
        name: "alice-node",
        givenName: "alice-node",
        ipAddresses: ["100.64.0.10"],
        advertisedRoutes: [],
        isExitNode: false,
        online: true,
        expired: false
      }
    ]),
    getPolicy: vi.fn(async () => currentPolicy),
    applyPolicy: vi.fn(async () => undefined)
  } as unknown as HeadscaleClient & { applyPolicy: ReturnType<typeof vi.fn> };
}

describe("reconcilePolicyOnce", () => {
  it("applies an updated policy when the live policy is stale", async () => {
    const prisma = createPrismaMock();
    const headscale = createHeadscaleMock({ acls: [] });

    const result = await reconcilePolicyOnce(prisma, headscale);

    expect(headscale.applyPolicy).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.version).toBe(1);
  });

  it("does not reapply when the generated policy already matches", async () => {
    const prisma = createPrismaMock();
    // Matches what generatePolicy will produce for the mocked alice node:
    // owner ACL + self-access baseline.
    const headscale = createHeadscaleMock({
      hosts: { "alice-node": "100.64.0.10" },
      groups: { "group:alice": ["alice@"] },
      acls: [{ action: "accept", src: ["alice@"], dst: ["alice-node:*", "alice@:*"] }]
    });

    const result = await reconcilePolicyOnce(prisma, headscale);

    expect(headscale.applyPolicy).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("returns an error result instead of throwing when Headscale fails", async () => {
    const prisma = createPrismaMock();
    const headscale = createHeadscaleMock({ acls: [] });
    (headscale.getPolicy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    const result = await reconcilePolicyOnce(prisma, headscale);

    expect(result.applied).toBe(false);
    expect(result.error).toContain("boom");
  });
});

describe("startPolicyReconciler", () => {
  it("runs reconcile on the configured interval and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock();
      const headscale = createHeadscaleMock({ acls: [] });

      const handle = startPolicyReconciler(prisma, headscale, { intervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      expect((headscale.listNodes as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

      handle.stop();
      const callsAfterStop = (headscale.listNodes as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect((headscale.listNodes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
