import type { FastifyInstance } from "fastify";
import { audit } from "../../utils/audit.js";
import { generatePolicy } from "./policy.generator.js";
import { applyCurrentPolicy } from "./policy.service.js";

export async function policyRoutes(app: FastifyInstance) {
  app.get("/policy/preview", async (request) => {
    await app.requireScope(request, "policy:read");
    return generatePolicy(app.prisma);
  });

  app.post("/policy/apply", async (request) => {
    const actor = await app.requireScope(request, "policy:write");
    return applyCurrentPolicy(app.prisma, app.headscale, actor);
  });

  app.get("/policy/versions", async (request) => {
    await app.requireScope(request, "policy:read");
    return app.prisma.policyVersion.findMany({ orderBy: { version: "desc" } });
  });

  app.get("/policy/versions/:id", async (request) => {
    await app.requireScope(request, "policy:read");
    const { id } = request.params as { id: string };
    return app.prisma.policyVersion.findUniqueOrThrow({ where: { id } });
  });

  app.post("/policy/versions/:id/rollback", async (request) => {
    const actor = await app.requireScope(request, "policy:write");
    const { id } = request.params as { id: string };
    const source = await app.prisma.policyVersion.findUniqueOrThrow({ where: { id } });
    await app.headscale.applyPolicy(JSON.parse(source.policyJson));
    const latest = await app.prisma.policyVersion.findFirst({ orderBy: { version: "desc" } });
    const record = await app.prisma.policyVersion.create({
      data: {
        version: (latest?.version ?? 0) + 1,
        policyJson: source.policyJson,
        generatedByUserId: actor.type === "user" ? actor.id : null,
        appliedAt: new Date(),
        rollbackFromVersionId: source.id
      }
    });
    await audit(app.prisma, actor, "policy.rollback_applied", "policy_version", record.id, { rollbackFromVersionId: source.id });
    return record;
  });
}

