import { afterEach, describe, expect, it, vi } from "vitest";
import { RestHeadscaleClient } from "./RestHeadscaleClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RestHeadscaleClient policy bootstrap", () => {
  it("treats Headscale's missing database policy as an empty policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: 2, message: "loading ACL from database: acl policy not found", details: [] }),
      { status: 500, headers: { "content-type": "application/json" } }
    )));

    const client = new RestHeadscaleClient("http://headscale:8080", "test-key");
    await expect(client.getPolicy()).resolves.toEqual({ acls: [] });
  });

  it("still surfaces unrelated Headscale policy errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("database unavailable", { status: 500 })));

    const client = new RestHeadscaleClient("http://headscale:8080", "test-key");
    await expect(client.getPolicy()).rejects.toThrow("database unavailable");
  });
});

describe("RestHeadscaleClient node inventory", () => {
  it("maps real client version and operating system metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      nodes: [{
        id: "7",
        name: "real-node",
        user: { name: "admin" },
        ipAddresses: ["100.64.0.7"],
        online: true,
        version: "1.82.5",
        os: "linux"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const client = new RestHeadscaleClient("http://headscale:8080", "test-key");
    const [node] = await client.listNodes();

    expect(node.version).toBe("1.82.5");
    expect(node.os).toBe("linux");
  });
});
