import { describe, expect, it } from "vitest";
import { generatePolicy } from "./policy.generator.js";

describe("generatePolicy", () => {
  it("generates deterministic whole-node ACL rules", async () => {
    const prisma = {
      user: {
        findMany: async () => [
          { id: "u1", username: "alice", disabledAt: null },
          { id: "u2", username: "bob", disabledAt: null }
        ]
      },
      node: {
        findMany: async () => [
          {
            headscaleNodeId: "1",
            name: "alice-node",
            givenName: "alice-node",
            owner: { username: "alice" },
            shares: [
              {
                targetUser: { username: "bob", disabledAt: null },
                targetGroup: null
              }
            ]
          }
        ]
      }
    } as never;

    await expect(generatePolicy(prisma, [{
      id: "1",
      userName: "alice",
      name: "alice-node",
      givenName: "alice-node",
      ipAddresses: ["100.64.0.10", "fd7a:115c:a1e0::10"],
      advertisedRoutes: [],
      isExitNode: false,
      online: true,
      expired: false
    }])).resolves.toEqual({
      hosts: {
        "alice-node": "100.64.0.10"
      },
      groups: {
        "group:alice": ["alice@"],
        "group:bob": ["bob@"]
      },
      acls: [
        { action: "accept", src: ["alice@"], dst: ["alice-node:*", "alice@:*"] },
        { action: "accept", src: ["bob@"], dst: ["alice-node:*", "bob@:*"] }
      ]
    });
  });

  it("emits a self-access ACL for users whose joined node is not yet in the DB", async () => {
    // Simulates the race the issue describes: a node has joined Headscale
    // (present in runtimeNodes) but CovaFlux has not yet recorded it (node table
    // empty). The user must still be able to reach their own new device.
    const prisma = {
      user: {
        findMany: async () => [{ id: "u1", username: "alice", disabledAt: null }]
      },
      node: {
        findMany: async () => []
      }
    } as never;

    const policy = await generatePolicy(prisma, [{
      id: "99",
      userName: "alice",
      name: "alice-colab",
      givenName: "alice-colab",
      ipAddresses: ["100.64.0.21"],
      advertisedRoutes: [],
      isExitNode: false,
      online: true,
      expired: false
    }]);

    expect(policy.acls).toContainEqual({
      action: "accept",
      src: ["alice@"],
      dst: ["alice@:*"]
    });
  });
});
