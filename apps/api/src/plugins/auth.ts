import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import type { ApiScope, UserRole } from "@covaflux/shared";
import { hashLookupToken } from "../utils/secrets.js";

export const API_TOKEN_PREFIX = "cft";

export type AuthActor =
  | {
      type: "user";
      id: string;
      username: string;
      role: UserRole;
    }
  | {
      type: "api_token";
      id: string;
      name: string;
      scopes: ApiScope[];
      ownerUserId: string | null;
      expiresAt: Date;
    };

declare module "fastify" {
  interface FastifyRequest {
    actor?: AuthActor;
  }

  interface FastifyInstance {
    requireAuth(request: FastifyRequest): Promise<AuthActor>;
    requireScope(request: FastifyRequest, scope: ApiScope): Promise<AuthActor>;
    requireUserOrScope(request: FastifyRequest, scope: ApiScope): Promise<AuthActor>;
  }
}

export const registerAuthPlugin = fp(async (app) => {
  async function authenticate(request: FastifyRequest): Promise<AuthActor | undefined> {
    if (request.actor) return request.actor;

    const authorization = request.headers.authorization;
    if (!authorization) return undefined;

    const [scheme, token] = authorization.split(" ");
    if (!token) return undefined;

    if (scheme.toLowerCase() === "bearer") {
      let payload: { sub: string; tv?: number };
      try {
        payload = await request.jwtVerify<{ sub: string; tv?: number }>();
      } catch {
        return undefined;
      }
      const user = await app.prisma.user.findUnique({ where: { id: payload.sub } });
      // tv mismatch = the token was issued before a logout, password change
      // or disable, so it is no longer valid.
      if (!user || user.disabledAt || payload.tv !== user.tokenVersion) return undefined;
      request.actor = {
        type: "user",
        id: user.id,
        username: user.username,
        role: user.role as UserRole
      };
      return request.actor;
    }

    if (scheme.toLowerCase() === "token") {
      // Tokens are 256-bit random values, so a single SHA-256 lookup is safe
      // and keeps invalid tokens from costing any Argon2 work.
      if (!token.startsWith(`${API_TOKEN_PREFIX}_`)) return undefined;
      const apiToken = await app.prisma.apiToken.findUnique({
        where: { tokenHash: hashLookupToken(token) },
        include: { owner: true }
      });
      const now = new Date();
      if (!apiToken || apiToken.revokedAt || !apiToken.expiresAt || apiToken.expiresAt <= now) return undefined;
      // A token only carries the authority of its owner: once the owner is
      // disabled, deleted or no longer an admin, the token stops working.
      if (!apiToken.owner || apiToken.owner.disabledAt || apiToken.owner.role !== "admin") return undefined;
      await app.prisma.apiToken.update({
        where: { id: apiToken.id },
        data: { lastUsedAt: now }
      });
      request.actor = {
        type: "api_token",
        id: apiToken.id,
        name: apiToken.name,
        scopes: JSON.parse(apiToken.scopesJson),
        ownerUserId: apiToken.ownerUserId,
        expiresAt: apiToken.expiresAt
      };
      return request.actor;
    }

    return undefined;
  }

  app.decorate("requireAuth", async (request: FastifyRequest) => {
    const actor = await authenticate(request);
    if (!actor) {
      const error = new Error("Authentication required");
      Object.assign(error, { statusCode: 401 });
      throw error;
    }
    return actor;
  });

  app.decorate("requireScope", async (request: FastifyRequest, scope: ApiScope) => {
    const actor = await app.requireAuth(request);
    if (actor.type === "user" && actor.role === "admin") return actor;
    if (actor.type === "api_token" && actor.scopes.includes(scope)) return actor;
    const error = new Error("Permission denied");
    Object.assign(error, { statusCode: 403 });
    throw error;
  });

  app.decorate("requireUserOrScope", async (request: FastifyRequest, scope: ApiScope) => {
    const actor = await app.requireAuth(request);
    if (actor.type === "user") return actor;
    if (actor.type === "api_token" && actor.scopes.includes(scope)) return actor;
    const error = new Error("Permission denied");
    Object.assign(error, { statusCode: 403 });
    throw error;
  });
});
