import type { PrismaClient } from "@prisma/client";
import type { AuthActor } from "../../plugins/auth.js";
import type { HeadscaleClient } from "../../services/headscale/HeadscaleClient.js";
import { audit } from "../../utils/audit.js";
import { generatePolicy } from "./policy.generator.js";

export async function applyCurrentPolicy(prisma: PrismaClient, headscale: HeadscaleClient, actor?: AuthActor) {
  const policy = await generatePolicy(prisma, await headscale.listNodes());
  await headscale.applyPolicy(policy);
  const latest = await prisma.policyVersion.findFirst({ orderBy: { version: "desc" } });
  const version = (latest?.version ?? 0) + 1;
  const record = await prisma.policyVersion.create({
    data: {
      version,
      policyJson: JSON.stringify(policy, null, 2),
      generatedByUserId: actor?.type === "user" ? actor.id : null,
      appliedAt: new Date()
    }
  });
  await audit(prisma, actor, "policy.applied", "policy_version", record.id, { version });
  return record;
}
