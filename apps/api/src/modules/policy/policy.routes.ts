import type { FastifyInstance } from "fastify";
import { policyLock } from "../../utils/lock.js";
import { syncHeadscaleNodes } from "../nodes/nodeSync.service.js";
import { generatePolicy } from "./policy.generator.js";
import { applyCurrentPolicy, recordPolicyVersion } from "./policy.service.js";

export async function policyRoutes(app: FastifyInstance) {
  app.get("/policy/preview", async (request) => {
    const actor = await app.requireScope(request, "policy:read");
    const syncResult = await syncHeadscaleNodes(app.prisma, app.headscale, actor);
    return generatePolicy(app.prisma, syncResult.runtimeNodes);
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
    const record = await policyLock.runExclusive(async () => {
      await app.headscale.applyPolicy(JSON.parse(source.policyJson));
      return recordPolicyVersion(app.prisma, actor, source.policyJson, source.id);
    });
    return record;
  });
}
