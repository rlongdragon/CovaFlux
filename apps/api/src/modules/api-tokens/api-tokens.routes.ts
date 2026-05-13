import type { FastifyInstance } from "fastify";
import { createApiTokenSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { createOpaqueToken, hashSecret } from "../../utils/secrets.js";

export async function apiTokensRoutes(app: FastifyInstance) {
  app.get("/api-tokens", async (request) => {
    const actor = await app.requireScope(request, "tokens:write");
    const where = actor.type === "user" && actor.role !== "admin" ? { ownerUserId: actor.id } : {};
    return app.prisma.apiToken.findMany({
      where,
      select: { id: true, name: true, ownerUserId: true, scopesJson: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/api-tokens", async (request) => {
    const actor = await app.requireScope(request, "tokens:write");
    const input = createApiTokenSchema.parse(request.body);
    const token = createOpaqueToken("cft");
    const record = await app.prisma.apiToken.create({
      data: {
        name: input.name,
        tokenHash: await hashSecret(token),
        ownerUserId: actor.type === "user" ? actor.id : actor.ownerUserId,
        scopesJson: JSON.stringify(input.scopes),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
      },
      select: { id: true, name: true, ownerUserId: true, scopesJson: true, expiresAt: true, createdAt: true }
    });
    await audit(app.prisma, actor, "api_token.created", "api_token", record.id, { scopes: input.scopes });
    return { ...record, token };
  });

  app.delete("/api-tokens/:id", async (request, reply) => {
    const actor = await app.requireScope(request, "tokens:write");
    const { id } = request.params as { id: string };
    const token = await app.prisma.apiToken.findUniqueOrThrow({ where: { id } });
    if (actor.type === "user" && actor.role !== "admin" && token.ownerUserId !== actor.id) return reply.status(403).send({ error: "permission_denied" });
    await app.prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(app.prisma, actor, "api_token.revoked", "api_token", id);
    return { ok: true };
  });
}

