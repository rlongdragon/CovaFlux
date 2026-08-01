import { describe, expect, it, vi } from "vitest";
import { downloadMachinesCsv, exportMachinesCsv, filterMachines, type MachineFilter, type NodeItem } from "./machines.js";

const nodes: NodeItem[] = [
  {
    id: "node-1",
    name: "black-server",
    owner: { id: "user-1", username: "alice" },
    ipAddresses: ["100.64.0.10"],
    online: true,
    expired: false,
    isExitNode: true,
    isExitNodeApproved: true,
    approvedRoutes: ["0.0.0.0/0", "::/0"]
  },
  {
    id: "node-2",
    name: "studio-pc",
    owner: { id: "user-2", username: "bob" },
    ipAddresses: ["100.64.0.20"],
    online: false,
    expired: false,
    advertisedRoutes: ["10.20.0.0/16"]
  },
  {
    id: "node-3",
    name: "retired-laptop",
    owner: { id: "user-1", username: "alice" },
    ipAddresses: ["100.64.0.30"],
    online: false,
    expired: true
  }
];

const all: MachineFilter = {
  status: "all",
  capability: "all"
};

describe("filterMachines", () => {
  it("searches across machine name, owner, address, and route", () => {
    expect(filterMachines(nodes, { ...all, query: "ALICE" }).map((node) => node.id)).toEqual(["node-1", "node-3"]);
    expect(filterMachines(nodes, { ...all, query: "100.64.0.20" }).map((node) => node.id)).toEqual(["node-2"]);
    expect(filterMachines(nodes, { ...all, query: "10.20" }).map((node) => node.id)).toEqual(["node-2"]);
  });

  it("filters by connectivity and capability without treating expired nodes as offline", () => {
    expect(filterMachines(nodes, { ...all, status: "online" }).map((node) => node.id)).toEqual(["node-1"]);
    expect(filterMachines(nodes, { ...all, status: "offline" }).map((node) => node.id)).toEqual(["node-2"]);
    expect(filterMachines(nodes, { ...all, status: "expired" }).map((node) => node.id)).toEqual(["node-3"]);
    expect(filterMachines(nodes, { ...all, capability: "exit-node" }).map((node) => node.id)).toEqual(["node-1"]);
    expect(filterMachines(nodes, { ...all, capability: "subnet" }).map((node) => node.id)).toEqual(["node-2"]);
  });

});

describe("exportMachinesCsv", () => {
  it("exports visible machine data with CSV escaping", () => {
    const csv = exportMachinesCsv([{ ...nodes[0], name: "black,server" }]);
    expect(csv).toContain("machine,owner,addresses,status,last_seen,expires_at,exit_node,subnet_routes");
    expect(csv).toContain('"black,server",alice,100.64.0.10,online');
    expect(csv).toContain(",yes,");
  });

  it("neutralizes spreadsheet formula prefixes", () => {
    const csv = exportMachinesCsv([{ ...nodes[0], name: "=HYPERLINK(\"https://example.invalid\")" }]);
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
  });
});

describe("downloadMachinesCsv", () => {
  it("keeps the object URL alive for the lifetime of the page", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:machines"), revokeObjectURL });
    vi.stubGlobal("document", { body: { appendChild }, createElement: vi.fn(() => ({ href: "", download: "", click, remove })) });

    downloadMachinesCsv("name\nnode-a", new Date("2026-07-31T00:00:00Z"));

    expect(click).toHaveBeenCalledOnce();
    expect(appendChild).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
