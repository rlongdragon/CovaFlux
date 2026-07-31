import type { FastifyInstance } from "fastify";
import { registerKeySchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { hashLookupToken } from "../../utils/secrets.js";
import { applyCurrentPolicy } from "../policy/policy.service.js";
import { markPolicyDirty } from "../../plugins/policyTracking.js";
import { syncHeadscaleNodes } from "./nodeSync.service.js";

function canManageNode(actor: Awaited<ReturnType<FastifyInstance["requireAuth"]>>, nodeOwnerUserId?: string | null) {
  return actor.type === "user" && (actor.role === "admin" || actor.id === nodeOwnerUserId);
}

export async function nodesRoutes(app: FastifyInstance) {
  app.get("/nodes", async (request) => {
    const actor = await app.requireUserOrScope(request, "nodes:read");
    const syncResult = await syncHeadscaleNodes(app.prisma, app.headscale, actor);
    await applyCurrentPolicy(app.prisma, app.headscale, actor, { runtimeNodes: syncResult.runtimeNodes, skipSync: true, onlyIfChanged: true });
    const where = actor.type === "user" && actor.role !== "admin" ? { ownerUserId: actor.id, deletedAt: null } : { deletedAt: null };
    const nodes = await app.prisma.node.findMany({ where, include: { owner: { select: { id: true, username: true } } }, orderBy: { createdAt: "desc" } });
    const runtimeById = new Map(syncResult.runtimeNodes.map((node) => [node.id, node]));
    return nodes.map((node) => {
      const runtime = runtimeById.get(node.headscaleNodeId);
      return {
        ...node,
        ipAddresses: runtime?.ipAddresses ?? [],
        advertisedRoutes: runtime?.advertisedRoutes ?? JSON.parse(node.advertisedRoutesJson),
        approvedRoutes: runtime?.approvedRoutes ?? [],
        isExitNode: runtime?.isExitNode ?? node.isExitNode,
        isExitNodeApproved: runtime?.isExitNodeApproved ?? false,
        online: runtime?.online ?? false,
        expired: runtime?.expired ?? false,
        expiresAt: runtime?.expiresAt ?? null
      };
    });
  });

  app.get("/nodes/:id", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "nodes:read");
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({
      where: { id },
      include: {
        owner: { select: { id: true, username: true } },
        shares: {
          where: { revokedAt: null },
          include: {
            sharedBy: { select: { id: true, username: true } },
            targetUser: { select: { id: true, username: true } },
            targetGroup: { include: { members: { include: { user: { select: { id: true, username: true } } } } } }
          },
          orderBy: { createdAt: "desc" }
        }
      }
    });
    if (actor.type === "user" && actor.role !== "admin" && node.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    const runtime = (await app.headscale.listNodes()).find((candidate) => candidate.id === node.headscaleNodeId);
    return {
      ...node,
      ipAddresses: runtime?.ipAddresses ?? [],
      advertisedRoutes: runtime?.advertisedRoutes ?? JSON.parse(node.advertisedRoutesJson),
      approvedRoutes: runtime?.approvedRoutes ?? [],
      isExitNode: runtime?.isExitNode ?? node.isExitNode,
      isExitNodeApproved: runtime?.isExitNodeApproved ?? false,
      online: runtime?.online ?? false,
      expired: runtime?.expired ?? false,
      expiresAt: runtime?.expiresAt ?? null
    };
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
    const result = await syncHeadscaleNodes(app.prisma, app.headscale, actor, { auditAction: true });
    const policyVersion = await applyCurrentPolicy(app.prisma, app.headscale, actor, { runtimeNodes: result.runtimeNodes, skipSync: true, onlyIfChanged: true });
    return { count: result.count, staleDeleted: result.staleDeleted, policyApplied: Boolean(policyVersion), nodes: result.nodes };
  });

  app.post("/nodes/:id/exit-node/approve", async (request, reply) => {
    const actor = await app.requireScope(request, "nodes:write");
    if (actor.type !== "user" || actor.role !== "admin") return reply.status(403).send({ error: "permission_denied" });
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
    if (!canManageNode(actor, node.ownerUserId)) return reply.status(403).send({ error: "permission_denied" });
    const runtime = (await app.headscale.listNodes()).find((candidate) => candidate.id === node.headscaleNodeId);
    if (!runtime) return reply.status(404).send({ error: "headscale_node_not_found" });
    const exitRoutes = runtime.advertisedRoutes.filter((route) => route === "0.0.0.0/0" || route === "::/0");
    if (exitRoutes.length === 0) return reply.status(400).send({ error: "exit_node_not_advertised" });
    const approvedRoutes = [...new Set([...runtime.approvedRoutes, ...exitRoutes])];
    const updated = await app.headscale.setApprovedRoutes(runtime.id, approvedRoutes);
    await audit(app.prisma, actor, "node.exit_node_approved", "node", id, { routes: exitRoutes });
    markPolicyDirty();
    return updated;
  });

  app.post("/nodes/:id/exit-node/disable", async (request, reply) => {
    const actor = await app.requireScope(request, "nodes:write");
    if (actor.type !== "user" || actor.role !== "admin") return reply.status(403).send({ error: "permission_denied" });
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
    if (!canManageNode(actor, node.ownerUserId)) return reply.status(403).send({ error: "permission_denied" });
    const runtime = (await app.headscale.listNodes()).find((candidate) => candidate.id === node.headscaleNodeId);
    if (!runtime) return reply.status(404).send({ error: "headscale_node_not_found" });
    const approvedRoutes = runtime.approvedRoutes.filter((route) => route !== "0.0.0.0/0" && route !== "::/0");
    const updated = await app.headscale.setApprovedRoutes(runtime.id, approvedRoutes);
    await audit(app.prisma, actor, "node.exit_node_disabled", "node", id);
    markPolicyDirty();
    return updated;
  });

  app.post("/nodes/:id/expire", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "nodes:write");
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
    if (!canManageNode(actor, node.ownerUserId)) return reply.status(403).send({ error: "permission_denied" });
    await app.headscale.expireNode(node.headscaleNodeId);
    await audit(app.prisma, actor, "node.expired", "node", id);
    // Headscale-only change (no tracked DB write) — mark dirty so the
    // onResponse hook reapplies policy and drops the expired node from peers.
    markPolicyDirty();
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
