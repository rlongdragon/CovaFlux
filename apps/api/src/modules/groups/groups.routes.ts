import type { FastifyInstance } from "fastify";
import { addGroupMemberSchema, createGroupSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { applyCurrentPolicy } from "../policy/policy.service.js";

export async function groupsRoutes(app: FastifyInstance) {
  app.get("/groups", async (request) => {
    const actor = await app.requireUserOrScope(request, "groups:read");
    const where = actor.type === "user" && actor.role !== "admin" ? { ownerUserId: actor.id } : {};
    return app.prisma.group.findMany({ where, include: { members: { include: { user: { select: { id: true, username: true } } } } } });
  });

  app.post("/groups", async (request) => {
    const actor = await app.requireUserOrScope(request, "groups:write");
    if (actor.type !== "user") throw Object.assign(new Error("User actor required"), { statusCode: 403 });
    const input = createGroupSchema.parse(request.body);
    const group = await app.prisma.group.create({ data: { name: input.name, ownerUserId: actor.id } });
    await audit(app.prisma, actor, "group.created", "group", group.id);
    return group;
  });

  app.get("/groups/:id", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "groups:read");
    const { id } = request.params as { id: string };
    const group = await app.prisma.group.findUniqueOrThrow({ where: { id }, include: { members: { include: { user: true } } } });
    if (actor.type === "user" && actor.role !== "admin" && group.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    return group;
  });

  app.post("/groups/:id/members", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "groups:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { id } = request.params as { id: string };
    const input = addGroupMemberSchema.parse(request.body);
    const group = await app.prisma.group.findUniqueOrThrow({ where: { id } });
    if (actor.role !== "admin" && group.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    const member = await app.prisma.groupMember.create({ data: { groupId: id, userId: input.userId, addedByUserId: actor.id } });
    await audit(app.prisma, actor, "group.member_added", "group", id, { userId: input.userId });
    await applyCurrentPolicy(app.prisma, app.headscale, actor);
    return member;
  });

  app.delete("/groups/:id/members/:userId", async (request, reply) => {
    const actor = await app.requireUserOrScope(request, "groups:write");
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const { id, userId } = request.params as { id: string; userId: string };
    const group = await app.prisma.group.findUniqueOrThrow({ where: { id } });
    if (actor.role !== "admin" && group.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    await app.prisma.groupMember.delete({ where: { groupId_userId: { groupId: id, userId } } });
    await audit(app.prisma, actor, "group.member_removed", "group", id, { userId });
    await applyCurrentPolicy(app.prisma, app.headscale, actor);
    return { ok: true };
  });
}
