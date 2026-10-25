import type { FastifyInstance } from "fastify";
import { API_TOKEN_DEFAULT_TTL_DAYS, API_TOKEN_MAX_TTL_DAYS, createApiTokenSchema } from "@covaflux/shared";
import { API_TOKEN_PREFIX, type AuthActor } from "../../plugins/auth.js";
import { audit } from "../../utils/audit.js";
import { createOpaqueToken, hashLookupToken } from "../../utils/secrets.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Tokens visible to / revocable by an actor. Admin users manage all tokens. */
function tokenScopeFilter(actor: AuthActor) {
  if (actor.type === "user") return actor.role === "admin" ? {} : { ownerUserId: actor.id };
  return { ownerUserId: actor.ownerUserId };
}

export async function apiTokensRoutes(app: FastifyInstance) {
  app.get("/api-tokens", async (request) => {
    const actor = await app.requireScope(request, "tokens:write");
    return app.prisma.apiToken.findMany({
      where: tokenScopeFilter(actor),
      select: { id: true, name: true, ownerUserId: true, scopesJson: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/api-tokens", async (request, reply) => {
    const actor = await app.requireScope(request, "tokens:write");
    const input = createApiTokenSchema.parse(request.body);
    const scopes = [...new Set(input.scopes)];

    // A token can only delegate authority it already holds.
    if (actor.type === "api_token") {
      const missing = scopes.filter((scope) => !actor.scopes.includes(scope));
      if (missing.length > 0) {
        return reply.status(403).send({ error: "scope_escalation_denied", message: `Token lacks scopes: ${missing.join(", ")}` });
      }
    }

    const now = Date.now();
    const defaultExpiry = new Date(now + API_TOKEN_DEFAULT_TTL_DAYS * DAY_MS);
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : actor.type === "api_token" && actor.expiresAt < defaultExpiry ? actor.expiresAt : defaultExpiry;
    if (expiresAt.getTime() <= now) throw badRequest("expiresAt must be in the future");
    if (expiresAt.getTime() > now + API_TOKEN_MAX_TTL_DAYS * DAY_MS) {
      throw badRequest(`expiresAt must be within ${API_TOKEN_MAX_TTL_DAYS} days`);
    }
    if (actor.type === "api_token" && expiresAt > actor.expiresAt) {
      throw badRequest("expiresAt cannot outlive the token creating it");
    }

    const token = createOpaqueToken(API_TOKEN_PREFIX);
    const record = await app.prisma.apiToken.create({
      data: {
        name: input.name,
        tokenHash: hashLookupToken(token),
        ownerUserId: actor.type === "user" ? actor.id : actor.ownerUserId,
        scopesJson: JSON.stringify(scopes),
        expiresAt
      },
      select: { id: true, name: true, ownerUserId: true, scopesJson: true, expiresAt: true, createdAt: true }
    });
    await audit(app.prisma, actor, "api_token.created", "api_token", record.id, { scopes });
    return { ...record, token };
  });

  app.delete("/api-tokens/:id", async (request, reply) => {
    const actor = await app.requireScope(request, "tokens:write");
    const { id } = request.params as { id: string };
    const token = await app.prisma.apiToken.findFirst({ where: { id, ...tokenScopeFilter(actor) } });
    if (!token) return reply.status(404).send({ error: "not_found" });
    await app.prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(app.prisma, actor, "api_token.revoked", "api_token", id);
    return { ok: true };
  });
}
