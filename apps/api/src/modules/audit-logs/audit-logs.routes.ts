import type { FastifyInstance } from "fastify";

export async function auditLogsRoutes(app: FastifyInstance) {
  app.get("/audit-logs", async (request) => {
    await app.requireScope(request, "policy:read");
    return app.prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  });
}

