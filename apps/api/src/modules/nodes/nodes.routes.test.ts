import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthActor } from "../../plugins/auth.js";
import { registerErrorHandler } from "../../plugins/error-handler.js";
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

function buildRouteApp(prisma: Record<string, unknown>, headscale: Partial<HeadscaleClient>, routeActor: AuthActor = actor) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate("prisma", prisma);
  app.decorate("headscale", headscale);
  app.decorate("requireUserOrScope", vi.fn(async () => routeActor));
  app.decorate("requireAuth", vi.fn(async () => routeActor));
  app.decorate("requireScope", vi.fn(async () => routeActor));
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
        findFirst: vi.fn(async () => node),
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

  it("returns a clear 404 when renaming a missing node", async () => {
    const prisma = {
      node: {
        findFirst: vi.fn(async () => null),
        update: vi.fn()
      }
    };
    const headscale = {
      renameNode: vi.fn(async () => undefined)
    };
    const app = buildRouteApp(prisma, headscale);
    await app.register(nodesRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/nodes/missing-node/name",
      payload: { name: "new-name" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "request_error", message: "Node not found" });
    expect(headscale.renameNode).not.toHaveBeenCalled();
    expect(prisma.node.update).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns a clear 403 when renaming someone else's node", async () => {
    const node = {
      id: "node-1",
      headscaleNodeId: "hs-1",
      ownerUserId: "user-2"
    };
    const prisma = {
      node: {
        findFirst: vi.fn(async () => node),
        update: vi.fn()
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

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "request_error", message: "You do not have permission to manage this node" });
    expect(headscale.renameNode).not.toHaveBeenCalled();
    expect(prisma.node.update).not.toHaveBeenCalled();

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
        findFirst: vi.fn(async () => node),
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
