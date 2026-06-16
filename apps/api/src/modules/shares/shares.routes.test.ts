import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthActor } from "../../plugins/auth.js";
import { sharesRoutes } from "./shares.routes.js";

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

function buildRouteApp(prisma: Record<string, unknown>, routeActor: AuthActor = actor) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma);
  app.decorate("headscale", {});
  app.decorate("requireUserOrScope", vi.fn(async () => routeActor));
  app.decorate("requireAuth", vi.fn(async () => routeActor));
  app.decorate("requireScope", vi.fn(async () => routeActor));
  return app;
}

describe("sharesRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not return shares for deleted nodes", async () => {
    const prisma = {
      nodeShare: {
        findMany: vi.fn(async () => [])
      }
    };
    const app = buildRouteApp(prisma);
    await app.register(sharesRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/shares"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(prisma.nodeShare.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        node: { deletedAt: null },
        OR: [
          { sharedByUserId: "user-1" },
          { targetUserId: "user-1" },
          { targetGroup: { members: { some: { userId: "user-1" } } } }
        ]
      }
    }));

    await app.close();
  });
});
