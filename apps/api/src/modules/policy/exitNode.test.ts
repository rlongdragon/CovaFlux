import { describe, expect, it } from "vitest";
import type { HeadscaleNode } from "../../services/headscale/HeadscaleClient.js";
import { MockHeadscaleClient } from "../../services/headscale/MockHeadscaleClient.js";
import { generatePolicy } from "./policy.generator.js";

const EXIT_ROUTES = ["0.0.0.0/0", "::/0"];

function runtimeExitNode(overrides: Partial<HeadscaleNode> = {}): HeadscaleNode {
  return {
    id: "exit-1",
    userName: "alice",
    name: "alice-exit",
    givenName: "alice-exit",
    ipAddresses: ["100.64.0.10"],
    advertisedRoutes: EXIT_ROUTES,
    approvedRoutes: [],
    isExitNode: true,
    online: true,
    expired: false,
    ...overrides
  };
}

describe("exit-node support", () => {
  it("approves only routes that the node currently advertises and preserves other approvals", async () => {
    const headscale = new MockHeadscaleClient();
    headscale.setNode(runtimeExitNode({ approvedRoutes: ["10.0.0.0/8"] }));

    const updated = await headscale.setApprovedRoutes("exit-1", ["10.0.0.0/8", ...EXIT_ROUTES]);

    expect(updated.approvedRoutes).toEqual(["10.0.0.0/8", ...EXIT_ROUTES]);
    expect(updated.isExitNodeApproved).toBe(true);
    await expect(headscale.setApprovedRoutes("exit-1", ["192.168.0.0/16"])).rejects.toThrow("not advertised");
  });

  it("grants internet access only to the owner and shares with allowExitNode enabled", async () => {
    const prisma = {
      user: {
        findMany: async () => [
          { id: "u1", username: "alice", disabledAt: null },
          { id: "u2", username: "bob", disabledAt: null },
          { id: "u3", username: "carol", disabledAt: null }
        ]
      },
      node: {
        findMany: async () => [{
          headscaleNodeId: "exit-1",
          name: "alice-exit",
          givenName: "alice-exit",
          isExitNode: true,
          owner: { username: "alice" },
          shares: [
            {
              allowExitNode: true,
              targetUser: { username: "bob", disabledAt: null },
              targetGroup: null
            },
            {
              allowExitNode: false,
              targetUser: { username: "carol", disabledAt: null },
              targetGroup: null
            }
          ]
        }]
      }
    } as never;

    const policy = await generatePolicy(prisma, [runtimeExitNode({ approvedRoutes: EXIT_ROUTES, isExitNodeApproved: true })]);

    expect(policy.acls).toContainEqual(expect.objectContaining({
      src: ["alice@"],
      dst: expect.arrayContaining(["autogroup:internet:*"])
    }));
    expect(policy.acls).toContainEqual(expect.objectContaining({
      src: ["bob@"],
      dst: expect.arrayContaining(["autogroup:internet:*"])
    }));
    expect(policy.acls.find((acl) => acl.src[0] === "carol@")?.dst).not.toContain("autogroup:internet:*");
  });
});
