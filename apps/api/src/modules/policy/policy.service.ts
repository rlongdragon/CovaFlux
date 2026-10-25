import type { PrismaClient } from "@prisma/client";
import type { AuthActor } from "../../plugins/auth.js";
import type { HeadscaleClient, HeadscaleNode, HeadscalePolicy } from "../../services/headscale/HeadscaleClient.js";
import { audit } from "../../utils/audit.js";
import { policyLock } from "../../utils/lock.js";
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
  // Generate from the database and apply under one lock: the policy that lands
  // in Headscale last is always generated from the newest database state.
  return policyLock.runExclusive(async () => {
    const policy = await generatePolicy(prisma, runtimeNodes);
    if (options.onlyIfChanged) {
      const currentPolicy = await headscale.getPolicy();
      if (stablePolicyJson(currentPolicy) === stablePolicyJson(policy)) return null;
    }

    await headscale.applyPolicy(policy);
    return recordPolicyVersion(prisma, actor, JSON.stringify(policy, null, 2));
  });
}

/** Must be called while holding policyLock. */
export async function recordPolicyVersion(prisma: PrismaClient, actor: AuthActor | undefined, policyJson: string, rollbackFromVersionId?: string) {
  const latest = await prisma.policyVersion.findFirst({ orderBy: { version: "desc" } });
  const version = (latest?.version ?? 0) + 1;
  const record = await prisma.policyVersion.create({
    data: {
      version,
      policyJson,
      generatedByUserId: actor?.type === "user" ? actor.id : null,
      appliedAt: new Date(),
      rollbackFromVersionId
    }
  });
  await audit(
    prisma,
    actor,
    rollbackFromVersionId ? "policy.rollback_applied" : "policy.applied",
    "policy_version",
    record.id,
    rollbackFromVersionId ? { version, rollbackFromVersionId } : { version }
  );
  return record;
}
