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
        { action: "accept", src: ["alice@"], dst: ["alice-node:*"] },
        { action: "accept", src: ["bob@"], dst: ["alice-node:*"] }
      ]
    });
  });
});
