import type { FastifyInstance } from "fastify";
import { loginSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { verifySecret } from "../../utils/secrets.js";

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
}

