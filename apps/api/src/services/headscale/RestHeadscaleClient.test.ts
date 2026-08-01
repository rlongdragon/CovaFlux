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
