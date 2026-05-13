import type { FastifyInstance } from "fastify";
import { createUserSchema, updateUserSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";
import { hashSecret } from "../../utils/secrets.js";

export async function usersRoutes(app: FastifyInstance) {
  app.get("/users", async (request) => {
    const actor = await app.requireUserOrScope(request, "users:read");
    if (actor.type === "user" && actor.role !== "admin") {
      return app.prisma.user.findMany({
        where: { disabledAt: null },
        select: { id: true, username: true },
        orderBy: { username: "asc" }
      });
    }

    return app.prisma.user.findMany({
      select: { id: true, username: true, role: true, headscaleUserName: true, disabledAt: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" }
    });
  });

  app.post("/users", async (request) => {
    const actor = await app.requireScope(request, "users:write");
    const input = createUserSchema.parse(request.body);
    await app.headscale.createUser({ name: input.username });
    const user = await app.prisma.user.create({
      data: {
        username: input.username,
        passwordHash: await hashSecret(input.password),
        role: input.role,
        headscaleUserName: input.username
      },
      select: { id: true, username: true, role: true, headscaleUserName: true, disabledAt: true, createdAt: true }
    });
    await audit(app.prisma, actor, "user.created", "user", user.id);
    return user;
  });

  app.get("/users/:id", async (request) => {
    await app.requireScope(request, "users:read");
    const { id } = request.params as { id: string };
    return app.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { id: true, username: true, role: true, headscaleUserName: true, disabledAt: true, createdAt: true, updatedAt: true }
    });
  });

  app.patch("/users/:id", async (request) => {
    const actor = await app.requireScope(request, "users:write");
    const { id } = request.params as { id: string };
    const input = updateUserSchema.parse(request.body);
    const user = await app.prisma.user.update({
      where: { id },
      data: {
        role: input.role,
        passwordHash: input.password ? await hashSecret(input.password) : undefined,
        disabledAt: input.disabled === undefined ? undefined : input.disabled ? new Date() : null
      },
      select: { id: true, username: true, role: true, disabledAt: true, updatedAt: true }
    });
    await audit(app.prisma, actor, "user.updated", "user", id);
    return user;
  });

  app.delete("/users/:id", async (request) => {
    const actor = await app.requireScope(request, "users:write");
    const { id } = request.params as { id: string };
    const user = await app.prisma.user.update({ where: { id }, data: { disabledAt: new Date() } });
    await audit(app.prisma, actor, "user.disabled", "user", id);
    return { ok: true, id: user.id };
  });
}
