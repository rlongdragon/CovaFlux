import type { FastifyInstance, FastifyReply } from "fastify";
import { changePasswordSchema, loginSchema } from "@covaflux/shared";
import { env } from "../../config/env.js";
import { runSuppressed } from "../../plugins/policyTracking.js";
import { audit } from "../../utils/audit.js";
import { FailureLimiter } from "../../utils/rateLimit.js";
import { hashSecret, verifyAgainstDummy, verifySecret } from "../../utils/secrets.js";

export async function signUserToken(reply: FastifyReply, user: { id: string; username: string; role: string; tokenVersion: number }) {
  return reply.jwtSign(
    { sub: user.id, username: user.username, role: user.role, tv: user.tokenVersion },
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

export async function authRoutes(app: FastifyInstance) {
  // Per client+username, and a looser per-client cap across usernames. Keys do
  // not include username alone so a third party cannot lock a user out.
  const pairLimiter = new FailureLimiter(env.LOGIN_MAX_FAILURES, env.LOGIN_WINDOW_MS);
  const ipLimiter = new FailureLimiter(env.LOGIN_MAX_FAILURES * 5, env.LOGIN_WINDOW_MS);

  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const pairKey = `${request.ip}|${input.username.toLowerCase()}`;
    const retryAfterMs = Math.max(pairLimiter.retryAfterMs(pairKey), ipLimiter.retryAfterMs(request.ip));
    if (retryAfterMs > 0) {
      return reply
        .status(429)
        .header("retry-after", String(Math.ceil(retryAfterMs / 1000)))
        .send({ error: "too_many_attempts" });
    }
    // Count the attempt before the (slow) Argon2 check; this runs without an
    // await since the check above, so concurrent requests see each other.
    const pairAttempts = pairLimiter.recordFailure(pairKey);
    const ipAttempts = ipLimiter.recordFailure(request.ip);

    const user = await app.prisma.user.findUnique({ where: { username: input.username } });
    const valid = user
      ? await verifySecret(user.passwordHash, input.password)
      : await verifyAgainstDummy(input.password);
    if (!user || user.disabledAt || !valid) {
      // Audit the first failure and the moment a limit trips, not every
      // attempt, so a brute-force run cannot flood the audit log.
      if (pairAttempts === 1) {
        await audit(app.prisma, undefined, "auth.login_failed", "user", null, { username: input.username, ip: request.ip });
      }
      if (pairAttempts === env.LOGIN_MAX_FAILURES || ipAttempts === env.LOGIN_MAX_FAILURES * 5) {
        await audit(app.prisma, undefined, "auth.login_throttled", "user", null, { username: input.username, ip: request.ip });
      }
      return reply.status(401).send({ error: "invalid_credentials" });
    }

    pairLimiter.reset(pairKey);
    ipLimiter.release(request.ip);
    const token = await signUserToken(reply, user);
    await audit(app.prisma, { type: "user", id: user.id, username: user.username, role: user.role as "admin" | "user" }, "auth.login_success", "user", user.id);
    return { token };
  });

  app.post("/auth/logout", async (request) => {
    const actor = await app.requireAuth(request);
    if (actor.type === "user") {
      // Session revocation only; does not change policy inputs.
      await runSuppressed(() => app.prisma.user.update({ where: { id: actor.id }, data: { tokenVersion: { increment: 1 } } }));
      await audit(app.prisma, actor, "auth.logout", "user", actor.id);
    }
    return { ok: true };
  });

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
    const passwordHash = await hashSecret(input.newPassword);
    const updated = await runSuppressed(() =>
      app.prisma.user.update({ where: { id: actor.id }, data: { passwordHash, tokenVersion: { increment: 1 } } })
    );
    await audit(app.prisma, actor, "auth.password_changed", "user", actor.id);
    // Every older session is now invalid; hand the caller a fresh one.
    return { ok: true, token: await signUserToken(reply, updated) };
  });
}
