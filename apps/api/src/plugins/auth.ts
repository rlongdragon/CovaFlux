import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import type { ApiScope, UserRole } from "@covaflux/shared";
import { verifySecret } from "../utils/secrets.js";

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
      try {
        const payload = await request.jwtVerify<{ sub: string; username: string; role: UserRole }>();
        const user = await app.prisma.user.findUnique({ where: { id: payload.sub } });
        if (!user || user.disabledAt) return undefined;
        request.actor = {
          type: "user",
          id: user.id,
          username: user.username,
          role: user.role as UserRole
        };
        return request.actor;
      } catch {
        return undefined;
      }
    }

    if (scheme.toLowerCase() === "token") {
      const tokens = await app.prisma.apiToken.findMany({ where: { revokedAt: null } });
      const now = new Date();
      for (const apiToken of tokens) {
        if (apiToken.expiresAt && apiToken.expiresAt < now) continue;
        if (await verifySecret(apiToken.tokenHash, token)) {
          await app.prisma.apiToken.update({
            where: { id: apiToken.id },
            data: { lastUsedAt: now }
          });
          request.actor = {
            type: "api_token",
            id: apiToken.id,
            name: apiToken.name,
            scopes: JSON.parse(apiToken.scopesJson),
            ownerUserId: apiToken.ownerUserId
          };
          return request.actor;
        }
      }
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
