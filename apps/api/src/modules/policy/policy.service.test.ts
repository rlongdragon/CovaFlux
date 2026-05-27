import { describe, expect, it, vi } from "vitest";
import type { HeadscaleClient, HeadscalePolicy } from "../../services/headscale/HeadscaleClient.js";
import { applyCurrentPolicy } from "./policy.service.js";

function createPrismaMock() {
  return {
    user: {
      findMany: vi.fn(async () => [{ id: "u1", username: "alice", disabledAt: null }])
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
      ])
    },
    policyVersion: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({ id: "pv1", ...data }))
    },
    auditLog: {
      create: vi.fn(async () => ({}))
    }
  } as never;
}

function createHeadscaleMock(currentPolicy: HeadscalePolicy) {
  return {
    listNodes: vi.fn(async () => []),
    getPolicy: vi.fn(async () => currentPolicy),
    applyPolicy: vi.fn(async () => undefined)
  } as unknown as HeadscaleClient & {
    applyPolicy: ReturnType<typeof vi.fn>;
  };
}

const runtimeNodes = [
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
];

describe("applyCurrentPolicy", () => {
  it("skips applying when onlyIfChanged sees the same policy", async () => {
    const prisma = createPrismaMock();
    const headscale = createHeadscaleMock({
      acls: [{ action: "accept", src: ["alice@"], dst: ["alice-node:*"] }],
      groups: { "group:alice": ["alice@"] },
      hosts: { "alice-node": "100.64.0.10" }
    });

    await expect(applyCurrentPolicy(prisma, headscale, undefined, { runtimeNodes, skipSync: true, onlyIfChanged: true })).resolves.toBeNull();
    expect(headscale.applyPolicy).not.toHaveBeenCalled();
  });

  it("applies when onlyIfChanged detects a changed policy", async () => {
    const prisma = createPrismaMock();
    const headscale = createHeadscaleMock({ acls: [] });

    await expect(applyCurrentPolicy(prisma, headscale, undefined, { runtimeNodes, skipSync: true, onlyIfChanged: true })).resolves.toMatchObject({
      id: "pv1",
      version: 1
    });
    expect(headscale.applyPolicy).toHaveBeenCalledWith({
      acls: [{ action: "accept", src: ["alice@"], dst: ["alice-node:*"] }],
      groups: { "group:alice": ["alice@"] },
      hosts: { "alice-node": "100.64.0.10" }
    });
  });
});
