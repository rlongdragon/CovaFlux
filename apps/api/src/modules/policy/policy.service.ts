import type { PrismaClient } from "@prisma/client";
import type { AuthActor } from "../../plugins/auth.js";
import type { HeadscaleClient, HeadscaleNode, HeadscalePolicy } from "../../services/headscale/HeadscaleClient.js";
import { audit } from "../../utils/audit.js";
import { syncHeadscaleNodes } from "../nodes/nodeSync.service.js";
import { generatePolicy } from "./policy.generator.js";

interface ApplyCurrentPolicyOptions {
  runtimeNodes?: HeadscaleNode[];
  skipSync?: boolean;
  onlyIfChanged?: boolean;
}

function stablePolicyJson(policy: HeadscalePolicy) {
  return JSON.stringify(sortPolicyValue(policy));
}

function sortPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPolicyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortPolicyValue(nestedValue)])
  );
}

export async function applyCurrentPolicy(
  prisma: PrismaClient,
  headscale: HeadscaleClient,
  actor?: AuthActor,
  options: ApplyCurrentPolicyOptions = {}
) {
  const runtimeNodes = options.runtimeNodes ?? (options.skipSync ? [] : (await syncHeadscaleNodes(prisma, headscale, actor)).runtimeNodes);
  const policy = await generatePolicy(prisma, runtimeNodes);
  if (options.onlyIfChanged) {
    const currentPolicy = await headscale.getPolicy();
    if (stablePolicyJson(currentPolicy) === stablePolicyJson(policy)) return null;
  }

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
