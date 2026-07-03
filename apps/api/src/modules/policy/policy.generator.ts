import type { PrismaClient } from "@prisma/client";
import type { HeadscaleNode, HeadscalePolicy } from "../../services/headscale/HeadscaleClient.js";

export async function generatePolicy(prisma: PrismaClient, runtimeNodes: HeadscaleNode[] = []): Promise<HeadscalePolicy> {
  const now = new Date();
  const users = await prisma.user.findMany({ where: { disabledAt: null }, orderBy: { username: "asc" } });
  const activeUsernames = new Set(users.map((user) => user.username));
  const nodes = await prisma.node.findMany({
    where: { deletedAt: null },
    include: {
      owner: true,
      shares: {
        where: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
        },
        include: {
          targetUser: true,
          targetGroup: { include: { members: { include: { user: true } } } }
        }
      }
    },
    orderBy: { name: "asc" }
  });

  const groups: Record<string, string[]> = {};
  for (const user of users) {
    groups[`group:${user.username}`] = [`${user.username}@`];
  }

  const runtimeById = new Map(runtimeNodes.map((node) => [node.id, node]));
  const hosts: Record<string, string> = {};
  const aclMap = new Map<string, Set<string>>();
  const addAcl = (src: string, dst: string) => {
    if (!aclMap.has(src)) aclMap.set(src, new Set());
    aclMap.get(src)?.add(dst);
  };

  for (const node of nodes) {
    const runtime = runtimeById.get(node.headscaleNodeId);
    const policyHost = node.givenName ?? node.name;
    const hostAddress = runtime?.ipAddresses.find((address) => address.includes(".")) ?? runtime?.ipAddresses[0];
    if (!hostAddress) continue;

    hosts[policyHost] = hostAddress;
    const dst = `${policyHost}:*`;
    if (node.owner && activeUsernames.has(node.owner.username)) addAcl(`${node.owner.username}@`, dst);

    for (const share of node.shares) {
      if (share.targetUser && !share.targetUser.disabledAt) {
        addAcl(`${share.targetUser.username}@`, dst);
      }
      if (share.targetGroup) {
        for (const member of share.targetGroup.members) {
          if (!member.user.disabledAt) addAcl(`${member.user.username}@`, dst);
        }
      }
    }
  }

  // Baseline self-access: allow every active user's devices to reach their own
  // devices. Headscale expands "user@" against live node ownership, so this
  // covers a freshly-joined node immediately — before CovaFlux has synced it
  // into its own database. Without this, a new userspace-networking node drops
  // inbound TCP ("no rules matched") until an unrelated action reapplies policy.
  for (const user of users) {
    addAcl(`${user.username}@`, `${user.username}@:*`);
  }

  const acls = [...aclMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([src, dstSet]) => ({
      action: "accept" as const,
      src: [src],
      dst: [...dstSet].sort()
    }));

  const derpSetting = prisma.systemSetting ? await prisma.systemSetting.findUnique({ where: { key: "derpMap" } }) : null;
  const parsedDerpSetting = derpSetting && typeof derpSetting.valueJson === "string"
    ? JSON.parse(derpSetting.valueJson) as { derpMap?: Record<string, unknown> | null }
    : null;
  const derpMap = parsedDerpSetting?.derpMap ?? null;

  return {
    hosts,
    groups,
    ...(derpMap ? { derpMap } : {}),
    acls
  };
}
