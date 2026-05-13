import type { FastifyInstance } from "fastify";
import { createInviteSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { createOpaqueToken, hashLookupToken } from "../../utils/secrets.js";
import { applyCurrentPolicy } from "../policy/policy.service.js";

export async function invitesRoutes(app: FastifyInstance) {
  app.post("/nodes/:id/invites", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "invites:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { id } = request.params as { id: string };
    const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
    if (actor.role !== "admin" && node.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    const input = createInviteSchema.parse(request.body);
    const token = createOpaqueToken("cfi");
    const invite = await app.prisma.inviteLink.create({
      data: {
        tokenHash: hashLookupToken(token),
        nodeId: id,
        createdByUserId: actor.id,
        allowExitNode: input.allowExitNode,
        expiresAt: new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000),
        maxUses: input.maxUses
      }
    });
    await audit(app.prisma, actor, "invite.created", "invite", invite.id);
    return { ...invite, token };
  });

  app.get("/invites/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const invite = await app.prisma.inviteLink.findUnique({ where: { tokenHash: hashLookupToken(token) }, include: { node: true, createdBy: true } });
    if (!invite || invite.revokedAt || invite.expiresAt < new Date() || invite.usedCount >= invite.maxUses) return reply.status(404).send({ error: "invite_not_found" });
    return { id: invite.id, node: invite.node, createdBy: { id: invite.createdBy.id, username: invite.createdBy.username }, allowExitNode: invite.allowExitNode, expiresAt: invite.expiresAt };
  });

  app.post("/invites/:token/accept", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "shares:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { token } = request.params as { token: string };
    const invite = await app.prisma.inviteLink.findUnique({ where: { tokenHash: hashLookupToken(token) } });
    if (!invite || invite.revokedAt || invite.expiresAt < new Date() || invite.usedCount >= invite.maxUses) return reply.status(404).send({ error: "invite_not_found" });
    const share = await app.prisma.nodeShare.create({
      data: {
        nodeId: invite.nodeId,
        sharedByUserId: invite.createdByUserId,
        targetUserId: actor.id,
        allowExitNode: invite.allowExitNode
      }
    });
    await app.prisma.inviteLink.update({ where: { id: invite.id }, data: { usedCount: { increment: 1 } } });
    await audit(app.prisma, actor, "invite.accepted", "invite", invite.id, { shareId: share.id });
    await applyCurrentPolicy(app.prisma, app.headscale, actor);
    return share;
  });

  app.delete("/invites/:id", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "invites:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { id } = request.params as { id: string };
    const invite = await app.prisma.inviteLink.findUniqueOrThrow({ where: { id } });
    if (actor.role !== "admin" && invite.createdByUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    await app.prisma.inviteLink.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(app.prisma, actor, "invite.revoked", "invite", id);
    return { ok: true };
  });
}
