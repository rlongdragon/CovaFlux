import type { PrismaClient } from "@prisma/client";
import type { AuthActor } from "../plugins/auth.js";

export async function audit(
  prisma: PrismaClient,
  actor: AuthActor | { type: "system"; id?: string } | undefined,
  action: string,
  resourceType: string,
  resourceId?: string | null,
  metadata?: unknown
) {
  await prisma.auditLog.create({
    data: {
      actorType: actor?.type ?? "system",
      actorId: "id" in (actor ?? {}) ? actor?.id ?? null : null,
      action,
      resourceType,
      resourceId: resourceId ?? null,
      metadataJson: JSON.stringify(metadata ?? {})
    }
  });
}

