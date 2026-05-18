import type { FastifyInstance } from "fastify";
import { registerKeySchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { hashLookupToken } from "../../utils/secrets.js";

function canManageNode(actor: Awaited<ReturnType<FastifyInstance["requireAuth"]>>, nodeOwnerUserId?: string | null) {
  return actor.type === "user" && (actor.role === "admin" || actor.id === nodeOwnerUserId);
}

export async function nodesRoutes(app: FastifyInstance) {
  app.get("/nodes", async (request) => {
    const actor = await app.requireUserOrScope(request, "nodes:read");
    const where = actor.type === "user" && actor.role !== "admin" ? { ownerUserId: actor.id, deletedAt: null } : { deletedAt: null };
    const nodes = await app.prisma.node.findMany({ where, include: { owner: { select: { id: true, username: true } } }, orderBy: { createdAt: "desc" } });
    const runtimeById = new Map((await app.headscale.listNodes()).map((node) => [node.id, node]));
    return nodes.map((node) => {
      const runtime = runtimeById.get(node.headscaleNodeId);
      return {
        ...node,
        ipAddresses: runtime?.ipAddresses ?? [],
        online: runtime?.online ?? false,
        expired: runtime?.expired ?? false,
        expiresAt: runtime?.expiresAt ?? null
      };
    });
  });

  app.get("/nodes/:id", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "nodes:read");
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id }, include: { owner: { select: { id: true, username: true } } } });
    if (actor.type === "user" && actor.role !== "admin" && node.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    return node;
  });

  app.post("/nodes/register-key", async (request) => {
    const actor = await app.requireUserOrScope(request, "nodes:write");
    const input = registerKeySchema.parse(request.body);
    const targetUserId = actor.type === "user" && actor.role !== "admin" ? actor.id : input.userId ?? (actor.type === "user" ? actor.id : undefined);
    if (!targetUserId) {
      const error = new Error("userId is required for API token registration key creation");
      Object.assign(error, { statusCode: 400 });
      throw error;
    }
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
    const key = await app.headscale.createPreAuthKey({
      userName: user.headscaleUserName,
      nodeName: input.nodeName,
      reusable: input.reusable,
      ephemeral: input.ephemeral,
      expiresAt
    });
    const record = await app.prisma.preAuthKey.create({
      data: {
        headscaleKeyId: key.id,
        userId: user.id,
        keyHash: hashLookupToken(key.key),
        reusable: input.reusable,
        ephemeral: input.ephemeral,
        expiresAt
      }
    });
    await audit(app.prisma, actor, "node.registration_key_created", "preauth_key", record.id, { userId: user.id });
    return { id: record.id, key: key.key, expiresAt };
  });

  app.post("/nodes/sync", async (request) => {
    const actor = await app.requireUserOrScope(request, "nodes:write");
    const hsNodes = await app.headscale.listNodes();
    const headscaleNodeIds = hsNodes.map((node) => node.id);
    const results = [];
    for (const hsNode of hsNodes) {
      const owner = await app.prisma.user.findUnique({ where: { headscaleUserName: hsNode.userName } });
      const node = await app.prisma.node.upsert({
        where: { headscaleNodeId: hsNode.id },
        create: {
          headscaleNodeId: hsNode.id,
          ownerUserId: owner?.id,
          name: hsNode.name,
          givenName: hsNode.givenName,
          machineKey: hsNode.machineKey,
          nodeKey: hsNode.nodeKey,
          advertisedRoutesJson: JSON.stringify(hsNode.advertisedRoutes),
          isExitNode: hsNode.isExitNode,
          lastSeenAt: hsNode.lastSeenAt,
          driftStatus: owner ? "managed" : "unassigned"
        },
        update: {
          ownerUserId: owner?.id,
          name: hsNode.name,
          givenName: hsNode.givenName,
          machineKey: hsNode.machineKey,
          nodeKey: hsNode.nodeKey,
          advertisedRoutesJson: JSON.stringify(hsNode.advertisedRoutes),
          isExitNode: hsNode.isExitNode,
          lastSeenAt: hsNode.lastSeenAt,
          driftStatus: owner ? "managed" : "unassigned"
        }
      });
      results.push(node);
    }
    const staleNodes = await app.prisma.node.updateMany({
      where: {
        deletedAt: null,
        ...(headscaleNodeIds.length > 0 ? { headscaleNodeId: { notIn: headscaleNodeIds } } : {})
      },
      data: { deletedAt: new Date(), driftStatus: "deleted" }
    });
    await audit(app.prisma, actor, "node.synced", "node", null, { count: results.length, staleDeleted: staleNodes.count });
    return { count: results.length, staleDeleted: staleNodes.count, nodes: results };
  });

  app.post("/nodes/:id/expire", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "nodes:write");
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
    if (!canManageNode(actor, node.ownerUserId)) return reply.status(403).send({ error: "permission_denied" });
    await app.headscale.expireNode(node.headscaleNodeId);
    await audit(app.prisma, actor, "node.expired", "node", id);
    return { ok: true };
  });

  app.delete("/nodes/:id", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "nodes:write");
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
    if (!canManageNode(actor, node.ownerUserId)) return reply.status(403).send({ error: "permission_denied" });
    await app.headscale.deleteNode(node.headscaleNodeId);
    await app.prisma.node.update({ where: { id }, data: { deletedAt: new Date() } });
    await audit(app.prisma, actor, "node.deleted", "node", id);
    return { ok: true };
  });

  app.patch("/nodes/:id/owner", async (request) => {
    const actor = await app.requireScope(request, "nodes:write");
    if (actor.type !== "user" || actor.role !== "admin") {
      const error = new Error("Admin role required");
      Object.assign(error, { statusCode: 403 });
      throw error;
    }
    const { id } = request.params as { id: string };
    const body = request.body as { ownerUserId: string };
    const node = await app.prisma.node.update({ where: { id }, data: { ownerUserId: body.ownerUserId, driftStatus: "managed" } });
    await audit(app.prisma, actor, "node.owner_changed", "node", id, { ownerUserId: body.ownerUserId });
    return node;
  });
}
