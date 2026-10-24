import type { FastifyInstance } from "fastify";
import { createInviteSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { httpError } from "../../utils/httpError.js";
import { nodeLock } from "../../utils/lock.js";
import { createOpaqueToken, hashLookupToken } from "../../utils/secrets.js";

export async function invitesRoutes(app: FastifyInstance) {
  app.post("/nodes/:id/invites", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "invites:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { id } = request.params as { id: string };
    const input = createInviteSchema.parse(request.body);
    return nodeLock.runExclusive(async () => {
      const node = await app.prisma.node.findUniqueOrThrow({ where: { id } });
      if (actor.role !== "admin" && node.ownerUserId !== actor.id) throw httpError(403, "permission_denied");
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
  });

  app.get("/invites/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const invite = await app.prisma.inviteLink.findUnique({
      where: { tokenHash: hashLookupToken(token) },
      include: { node: { select: { id: true, name: true, givenName: true, deletedAt: true } }, createdBy: { select: { id: true, username: true } } }
    });
    if (!invite || invite.revokedAt || invite.node.deletedAt || invite.expiresAt < new Date() || invite.usedCount >= invite.maxUses) return reply.status(404).send({ error: "invite_not_found" });
    // Unauthenticated endpoint: expose only what the invitee needs to decide.
    return {
      id: invite.id,
      node: { id: invite.node.id, name: invite.node.givenName ?? invite.node.name },
      createdBy: invite.createdBy,
      allowExitNode: invite.allowExitNode,
      expiresAt: invite.expiresAt
    };
  });

  app.post("/invites/:token/accept", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "shares:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { token } = request.params as { token: string };
    // nodeLock: the creator's authority over the node is checked against the
    // same ownership state the share is created under.
    const { inviteId, share } = await nodeLock.runExclusive(async () => {
      const invite = await app.prisma.inviteLink.findUnique({
        where: { tokenHash: hashLookupToken(token) },
        include: { node: { select: { deletedAt: true, ownerUserId: true } }, createdBy: { select: { role: true, disabledAt: true } } }
      });
      if (!invite || invite.node.deletedAt) throw httpError(404, "invite_not_found");
      // Invites only carry the authority their creator still has.
      const creatorStillAllowed = !invite.createdBy.disabledAt && (invite.createdBy.role === "admin" || invite.node.ownerUserId === invite.createdByUserId);
      if (!creatorStillAllowed) throw httpError(404, "invite_not_found");
      // Claim a use with a single conditional increment: concurrent accepts
      // cannot both pass the usedCount < maxUses check.
      const claimed = await app.prisma.inviteLink.updateMany({
        where: { id: invite.id, revokedAt: null, expiresAt: { gt: new Date() }, usedCount: { lt: invite.maxUses } },
        data: { usedCount: { increment: 1 } }
      });
      if (claimed.count === 0) throw httpError(404, "invite_not_found");
      try {
        const created = await app.prisma.nodeShare.create({
          data: {
            nodeId: invite.nodeId,
            sharedByUserId: invite.createdByUserId,
            targetUserId: actor.id,
            allowExitNode: invite.allowExitNode
          }
        });
        return { inviteId: invite.id, share: created };
      } catch (error) {
        await app.prisma.inviteLink.update({ where: { id: invite.id }, data: { usedCount: { decrement: 1 } } });
        throw error;
      }
    });
    await audit(app.prisma, actor, "invite.accepted", "invite", inviteId, { shareId: share.id });
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
