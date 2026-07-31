import type { FastifyInstance } from "fastify";
import { changePasswordSchema, loginSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { hashSecret, verifySecret } from "../../utils/secrets.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await app.prisma.user.findUnique({ where: { username: input.username } });
    if (!user || user.disabledAt || !(await verifySecret(user.passwordHash, input.password))) {
      await audit(app.prisma, undefined, "auth.login_failed", "user", null, { username: input.username });
      return reply.status(401).send({ error: "invalid_credentials" });
    }

    const token = await reply.jwtSign({
      sub: user.id,
      username: user.username,
      role: user.role
    });
    await audit(app.prisma, { type: "user", id: user.id, username: user.username, role: user.role as "admin" | "user" }, "auth.login_success", "user", user.id);
    return { token };
  });

  app.post("/auth/logout", async () => ({ ok: true }));

  app.get("/me", async (request) => {
    const actor = await app.requireAuth(request);
    return { actor };
  });

  app.patch("/me/password", async (request, reply) => {
    const actor = await app.requireAuth(request);
    if (actor.type !== "user") return reply.status(403).send({ error: "permission_denied" });
    const input = changePasswordSchema.parse(request.body);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!(await verifySecret(user.passwordHash, input.currentPassword))) {
      await audit(app.prisma, actor, "auth.password_change_failed", "user", actor.id);
      return reply.status(401).send({ error: "invalid_current_password" });
    }
    await app.prisma.user.update({ where: { id: actor.id }, data: { passwordHash: await hashSecret(input.newPassword) } });
    await audit(app.prisma, actor, "auth.password_changed", "user", actor.id);
    return { ok: true };
  });
}

