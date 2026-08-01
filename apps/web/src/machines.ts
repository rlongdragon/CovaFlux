export type UserItem = {
  id: string;
  username: string;
  role?: string;
};

export type NodeItem = {
  id: string;
  headscaleNodeId?: string;
  name: string;
  givenName?: string | null;
  advertisedRoutes?: string[];
  approvedRoutes?: string[];
  isExitNode?: boolean;
  isExitNodeApproved?: boolean;
  ownerUserId?: string | null;
  owner?: UserItem | null;
  ipAddresses?: string[];
  online?: boolean;
  expired?: boolean;
  lastSeenAt?: string | null;
  expiresAt?: string | null;
  driftStatus?: string;
};

export type MachineFilter = {
  query?: string;
  status: "all" | "online" | "offline" | "expired";
  capability: "all" | "exit-node" | "subnet";
};

function machineStatus(node: NodeItem) {
  if (node.expired) return "expired";
  return node.online ? "online" : "offline";
}

function subnetRoutes(node: NodeItem) {
  return (node.advertisedRoutes ?? []).filter((route) => route !== "0.0.0.0/0" && route !== "::/0");
}

export function filterMachines(nodes: NodeItem[], filter: MachineFilter) {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  return nodes.filter((node) => {
    if (filter.status !== "all" && machineStatus(node) !== filter.status) return false;
    if (filter.capability === "exit-node" && !(node.isExitNode || node.isExitNodeApproved)) return false;
    if (filter.capability === "subnet" && subnetRoutes(node).length === 0) return false;
    if (!query) return true;
    const haystack = [
      node.givenName,
      node.name,
      node.owner?.username,
      node.ownerUserId,
      ...(node.ipAddresses ?? []),
      ...(node.advertisedRoutes ?? []),
      ...(node.approvedRoutes ?? [])
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });
}

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportMachinesCsv(nodes: NodeItem[]) {
  const header = ["machine", "owner", "addresses", "status", "last_seen", "expires_at", "exit_node", "subnet_routes"];
  const rows = nodes.map((node) => [
    node.givenName ?? node.name,
    node.owner?.username ?? node.ownerUserId ?? "",
    (node.ipAddresses ?? []).join(" "),
    machineStatus(node),
    node.lastSeenAt ?? "",
    node.expiresAt ?? "",
    node.isExitNode || node.isExitNodeApproved ? "yes" : "no",
    subnetRoutes(node).join(" ")
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function downloadMachinesCsv(csv: string, now = new Date()) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `covaflux-machines-${now.toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export { machineStatus, subnetRoutes };
