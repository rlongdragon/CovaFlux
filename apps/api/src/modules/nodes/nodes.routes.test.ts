import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthActor } from "../../plugins/auth.js";
import type { HeadscaleClient } from "../../services/headscale/HeadscaleClient.js";
import { nodesRoutes } from "./nodes.routes.js";

vi.mock("../policy/policy.service.js", () => ({
  applyCurrentPolicy: vi.fn(async () => null)
}));

vi.mock("../../utils/audit.js", () => ({
  audit: vi.fn(async () => undefined)
}));

const actor: AuthActor = {
  type: "user",
  id: "user-1",
  username: "alice",
  role: "user"
};

function buildRouteApp(prisma: Record<string, unknown>, headscale: Partial<HeadscaleClient>) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma);
  app.decorate("headscale", headscale);
  app.decorate("requireUserOrScope", vi.fn(async () => actor));
  app.decorate("requireAuth", vi.fn(async () => actor));
  app.decorate("requireScope", vi.fn(async () => actor));
  return app;
}

describe("nodesRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renames an owned node in Headscale and updates the local record", async () => {
    const node = {
      id: "node-1",
      headscaleNodeId: "hs-1",
      ownerUserId: "user-1",
      name: "old-name",
      givenName: "old-name"
    };
    const updatedNode = { ...node, name: "new-name", givenName: "new-name" };
    const prisma = {
      node: {
        findUniqueOrThrow: vi.fn(async () => node),
        update: vi.fn(async () => updatedNode)
      }
    };
    const headscale = {
      renameNode: vi.fn(async () => undefined)
    };
    const app = buildRouteApp(prisma, headscale);
    await app.register(nodesRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/nodes/node-1/name",
      payload: { name: "new-name" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "node-1", name: "new-name", givenName: "new-name" });
    expect(headscale.renameNode).toHaveBeenCalledWith("hs-1", "new-name");
    expect(prisma.node.update).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: { name: "new-name", givenName: "new-name", driftStatus: "managed" },
      include: { owner: { select: { id: true, username: true } } }
    });

    await app.close();
  });

  it("revokes active shares when deleting a node", async () => {
    const node = {
      id: "node-1",
      headscaleNodeId: "hs-1",
      ownerUserId: "user-1"
    };
    const prisma = {
      node: {
        findUniqueOrThrow: vi.fn(async () => node),
        update: vi.fn(async () => ({ ...node, deletedAt: new Date() }))
      },
      nodeShare: {
        updateMany: vi.fn(async () => ({ count: 2 }))
      }
    };
    const headscale = {
      deleteNode: vi.fn(async () => undefined)
    };
    const app = buildRouteApp(prisma, headscale);
    await app.register(nodesRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/nodes/node-1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(headscale.deleteNode).toHaveBeenCalledWith("hs-1");
    expect(prisma.node.update).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: { deletedAt: expect.any(Date) }
    });
    expect(prisma.nodeShare.updateMany).toHaveBeenCalledWith({
      where: { nodeId: "node-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });

    await app.close();
  });
});
