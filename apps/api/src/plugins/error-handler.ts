import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

function prismaStatus(error: unknown): { statusCode: number; error: string } | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") return { statusCode: 404, error: "not_found" };
    if (error.code === "P2002") return { statusCode: 409, error: "conflict" };
    if (error.code === "P2003") return { statusCode: 400, error: "invalid_reference" };
  }
  // findUniqueOrThrow / findFirstOrThrow raise NotFoundError on Prisma 5.
  if (error instanceof Error && error.name === "NotFoundError") return { statusCode: 404, error: "not_found" };
  return undefined;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: Error & { statusCode?: number; errorCode?: string; publicMessage?: string }, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "validation_error",
        issues: error.issues.map(({ code, path, message }) => ({ code, path, message }))
      });
    }

    const mapped = prismaStatus(error);
    if (mapped) {
      request.log.info({ err: error }, "mapped database error");
      return reply.status(mapped.statusCode).send({ error: mapped.error });
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      // Never leak internal messages (SQL, Prisma, Headscale responses).
      request.log.error({ err: error }, "unhandled error");
      return reply.status(statusCode).send({ error: "internal_server_error" });
    }
    if (error.errorCode) {
      return reply.status(statusCode).send({
        error: error.errorCode,
        ...(error.publicMessage ? { message: error.publicMessage } : {})
      });
    }
    return reply.status(statusCode).send({
      error: "request_error",
      message: error.message
    });
  });
}
