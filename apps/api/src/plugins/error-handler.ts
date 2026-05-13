import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "validation_error",
        issues: error.issues
      });
    }

    const statusCode = error.statusCode ?? 500;
    app.log.error(error);
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal_server_error" : "request_error",
      message: error.message
    });
  });
}
