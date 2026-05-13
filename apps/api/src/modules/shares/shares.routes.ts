import type { FastifyInstance } from "fastify";
import { shareToGroupSchema, shareToUserSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { applyCurrentPolicy } from "../policy/policy.service.js";

async function requireNodeOwner(app: FastifyInstance, actor: Awaited<ReturnType<FastifyInstance["requireAuth"]>>, nodeId: string) {
  const node = await app.prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
  if (actor.type !== "user" || (actor.role !== "admin" && node.ownerUserId !== actor.id)) {
    throw Object.assign(new Error("Permission denied"), { statusCode: 403 });
  }
  return node;
}

export async function sharesRoutes(app: FastifyInstance) {
  app.get("/shares", async (request) => {
    const actor = await app.requireUserOrScope(request, "shares:read");
    const where = actor.type === "user" && actor.role !== "admin"
      ? {
          OR: [
            { sharedByUserId: actor.id },
            { targetUserId: actor.id },
            { targetGroup: { members: { some: { userId: actor.id } } } }
          ]
        }
      : {};
    return app.prisma.nodeShare.findMany({
      where,
      include: {
        node: true,
        sharedBy: { select: { id: true, username: true } },
        targetUser: { select: { id: true, username: true } },
        targetGroup: true
      },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/nodes/:id/shares/users", async (request) => {
    const actor = await app.requireUserOrScope(request, "shares:write");
    const { id } = request.params as { id: string };
    await requireNodeOwner(app, actor, id);
    const input = shareToUserSchema.parse(request.body);
    const share = await app.prisma.nodeShare.create({
      data: {
        nodeId: id,
        sharedByUserId: actor.id,
        targetUserId: input.targetUserId,
        allowExitNode: input.allowExitNode,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
      }
    });
    await audit(app.prisma, actor, "share.created_user", "share", share.id);
    await applyCurrentPolicy(app.prisma, app.headscale, actor);
    return share;
  });

  app.post("/nodes/:id/shares/groups", async (request) => {
    const actor = await app.requireUserOrScope(request, "shares:write");
    const { id } = request.params as { id: string };
    await requireNodeOwner(app, actor, id);
    const input = shareToGroupSchema.parse(request.body);
    const share = await app.prisma.nodeShare.create({
      data: {
        nodeId: id,
        sharedByUserId: actor.id,
        targetGroupId: input.targetGroupId,
        allowExitNode: input.allowExitNode,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
      }
    });
    await audit(app.prisma, actor, "share.created_group", "share", share.id);
    await applyCurrentPolicy(app.prisma, app.headscale, actor);
    return share;
  });

  app.delete("/shares/:id", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "shares:write");
    const { id } = request.params as { id: string };
    const share = await app.prisma.nodeShare.findUniqueOrThrow({ where: { id }, include: { node: true } });
    if (actor.type !== "user" || (actor.role !== "admin" && share.sharedByUserId !== actor.id && share.node.ownerUserId !== actor.id)) {
      return reply.status(403).send({ error: "permission_denied" });
    }
    await app.prisma.nodeShare.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(app.prisma, actor, "share.revoked", "share", id);
    await applyCurrentPolicy(app.prisma, app.headscale, actor);
    return { ok: true };
  });
}
