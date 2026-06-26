import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuthActor } from "../../plugins/auth.js";
import type { HeadscaleClient, HeadscaleNode } from "../../services/headscale/HeadscaleClient.js";
import { runSuppressed } from "../../plugins/policyTracking.js";
import { audit } from "../../utils/audit.js";

export interface NodeSyncResult {
  count: number;
  staleDeleted: number;
  nodes: Array<Prisma.NodeGetPayload<{ include: { owner: { select: { id: true; username: true } } } }>>;
  runtimeNodes: HeadscaleNode[];
}

async function findPendingRegistrationIntent(prisma: PrismaClient, hsNode: HeadscaleNode) {
  const now = new Date();
  return prisma.preAuthKey.findFirst({
    where: {
      reusable: false,
      usedAt: null,
      expiresAt: { gt: now },
      user: { headscaleUserName: hsNode.userName }
    },
    include: { user: true },
    orderBy: { createdAt: "asc" }
  });
}

export async function syncHeadscaleNodes(
  prisma: PrismaClient,
  headscale: HeadscaleClient,
  actor?: AuthActor,
  options: { auditAction?: boolean } = {}
): Promise<NodeSyncResult> {
  return runSuppressed(async () => {
    const hsNodes = await headscale.listNodes();
    const headscaleNodeIds = hsNodes.map((node) => node.id);
    const results: NodeSyncResult["nodes"] = [];

    for (const hsNode of hsNodes) {
      const existing = await prisma.node.findUnique({ where: { headscaleNodeId: hsNode.id } });
      const owner = await prisma.user.findUnique({ where: { headscaleUserName: hsNode.userName } });
      const pendingIntent = existing ? null : await findPendingRegistrationIntent(prisma, hsNode);
      const ownerUserId = existing?.ownerUserId ?? pendingIntent?.userId ?? owner?.id ?? null;
      const driftStatus = ownerUserId ? "managed" : "unassigned";

      const node = await prisma.node.upsert({
        where: { headscaleNodeId: hsNode.id },
        create: {
          headscaleNodeId: hsNode.id,
          ownerUserId,
          name: hsNode.name,
          givenName: hsNode.givenName,
          machineKey: hsNode.machineKey,
          nodeKey: hsNode.nodeKey,
          advertisedRoutesJson: JSON.stringify(hsNode.advertisedRoutes),
          isExitNode: hsNode.isExitNode,
          lastSeenAt: hsNode.lastSeenAt,
          driftStatus
        },
        update: {
          ownerUserId,
          name: hsNode.name,
          givenName: hsNode.givenName,
          machineKey: hsNode.machineKey,
          nodeKey: hsNode.nodeKey,
          advertisedRoutesJson: JSON.stringify(hsNode.advertisedRoutes),
          isExitNode: hsNode.isExitNode,
          lastSeenAt: hsNode.lastSeenAt,
          deletedAt: null,
          driftStatus
        },
        include: { owner: { select: { id: true, username: true } } }
      });

      if (pendingIntent) {
        await prisma.preAuthKey.update({
          where: { id: pendingIntent.id },
          data: { usedAt: new Date(), nodeId: node.id }
        });
      }

      results.push(node);
    }

    const staleNodes = await prisma.node.updateMany({
      where: {
        deletedAt: null,
        ...(headscaleNodeIds.length > 0 ? { headscaleNodeId: { notIn: headscaleNodeIds } } : {})
      },
      data: { deletedAt: new Date(), driftStatus: "deleted" }
    });

    if (options.auditAction) {
      await audit(prisma, actor, "node.synced", "node", null, { count: results.length, staleDeleted: staleNodes.count });
    }

    return { count: results.length, staleDeleted: staleNodes.count, nodes: results, runtimeNodes: hsNodes };
  });
}
