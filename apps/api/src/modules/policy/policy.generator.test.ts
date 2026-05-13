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
            name: "alice-node",
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

    await expect(generatePolicy(prisma)).resolves.toEqual({
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

