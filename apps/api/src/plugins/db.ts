import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import { isPolicyWrite, markPolicyDirty } from "./policyTracking.js";

/**
 * The extended client preserves the PrismaClient surface used across the app.
 * We keep the FastifyInstance type as PrismaClient so existing call sites and
 * mocks are unaffected; the policy-tracking extension only adds a side effect.
 */
declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export function withPolicyTracking(prisma: PrismaClient): PrismaClient {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const result = await query(args);
          if (isPolicyWrite(model, operation)) {
            // Marking after the write succeeds keeps failed writes from
            // triggering a spurious reapply. suppressDepth (node sync) is
            // honoured inside markPolicyDirty.
            markPolicyDirty();
          }
          return result;
        }
      }
    }
  }) as unknown as PrismaClient;
}

export const registerDbPlugin = fp(async (app) => {
  const prisma = withPolicyTracking(new PrismaClient());
  await prisma.$connect();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
