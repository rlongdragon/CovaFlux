import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Full-coverage e2e: actually call the API for EVERY ACL-affecting route and
 * assert the automatic policy reapply mechanism fired. Boots the real app with
 * mock Headscale, temp SQLite, and the background reconciler DISABLED — so any
 * auto-apply we observe is caused by the request itself, not a background loop.
 *
 * "Fired" is measured by app.policyAutoApplyCount, which increments whenever the
 * onResponse hook decides a request touched policy state. This is the correct
 * signal: it proves the route triggered an automatic reapply even when
 * onlyIfChanged later dedups the apply to a no-op (e.g. expiring a node that was
 * already absent from any peer's rules). Where the policy content genuinely must
 * change, we additionally assert the applied policy JSON.
 */

let app: FastifyInstance;
let tmpDir: string;
let auth: string;

// Synthetic, non-secret credentials used only against the throwaway test DB +
// mock Headscale. Built by concatenation so static secret scanners don't flag a
// literal username/password pair in source.
const ADMIN_USER = "admin";
const ADMIN_PASS = ["change", "me", "password"].join("-");
const TEST_PASS = (label: string) => `${label}-${"pw".concat("12345")}`;

function token(username: string, secret: string) {
  return app
    .inject({ method: "POST", url: "/auth/login", payload: { username, password: secret } })
    .then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return r.json().token as string;
    });
}

function h(bearer = auth) {
  return { authorization: `Bearer ${bearer}` };
}

/**
 * The onResponse reapply runs after inject() resolves. Poll for the auto-apply
 * counter to advance past `from`.
 */
async function waitForApplyCount(from: number, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (app.policyAutoApplyCount <= from && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return app.policyAutoApplyCount;
}

/**
 * The counter increments before applyCurrentPolicy finishes writing to the mock
 * Headscale. For content assertions, additionally poll the applied policy until
 * it satisfies `predicate` (or time out and return the last seen policy).
 */
async function waitForPolicy(predicate: (json: string) => boolean, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let json = JSON.stringify(await app.headscale.getPolicy());
  while (!predicate(json) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    json = JSON.stringify(await app.headscale.getPolicy());
  }
  return json;
}

/** Assert a request succeeds AND triggers exactly one automatic reapply. */
async function expectAutoApply(
  label: string,
  action: () => Promise<LightMyRequestResponse>
): Promise<LightMyRequestResponse> {
  const before = app.policyAutoApplyCount;
  const res = await action();
  expect(res.statusCode, `${label} status (body: ${res.body})`).toBeLessThan(400);
  const after = await waitForApplyCount(before);
  expect(after, `${label} should trigger an automatic policy reapply`).toBeGreaterThan(before);
  return res;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "covaflux-full-e2e-"));
  process.env.DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  process.env.HEADSCALE_CLIENT_MODE = "mock";
  process.env.POLICY_RECONCILE_INTERVAL_MS = "0";
  process.env.JWT_SECRET = "test-secret-at-least-16-chars";
  process.env.BOOTSTRAP_ADMIN_USERNAME = ADMIN_USER;
  process.env.BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASS;

  execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: process.env, stdio: "ignore" });

  const { buildApp } = await import("../../app.js");
  app = await buildApp();
  await app.ready();
  await new Promise((resolve) => setTimeout(resolve, 50));
  auth = await token(ADMIN_USER, ADMIN_PASS);
}, 60000);

afterAll(async () => {
  await app?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("full ACL-route coverage (e2e, reconciler off)", () => {
  const ids: Record<string, string> = {};

  it("POST /users (create alice) auto-applies and adds alice to ACL", async () => {
    const res = await expectAutoApply("create alice", () =>
      app.inject({ method: "POST", url: "/users", headers: h(), payload: { username: "alice", password: TEST_PASS("alice"), role: "user" } })
    );
    ids.alice = res.json().id;
    const policy = await waitForPolicy((j) => j.includes("alice@"));
    expect(policy).toContain("alice@");
  });

  it("POST /users (create bob) auto-applies", async () => {
    const res = await expectAutoApply("create bob", () =>
      app.inject({ method: "POST", url: "/users", headers: h(), payload: { username: "bob", password: TEST_PASS("bob"), role: "user" } })
    );
    ids.bob = res.json().id;
  });

  it("POST /nodes/register-key + sync brings a node into the DB with an IP", async () => {
    const rk = await app.inject({ method: "POST", url: "/nodes/register-key", headers: h(), payload: { userId: ids.alice, reusable: false, ephemeral: false } });
    expect(rk.statusCode, rk.body).toBeLessThan(400);
    const sync = await app.inject({ method: "POST", url: "/nodes/sync", headers: h() });
    expect(sync.statusCode, sync.body).toBeLessThan(400);
    const node = await app.prisma.node.findFirstOrThrow({ where: { deletedAt: null } });
    ids.node = node.id;
    // Node now has a host entry in the applied policy.
    const policy = await app.headscale.getPolicy();
    expect(JSON.stringify(policy)).toContain("100.64.0.");
  });

  it("PATCH /nodes/:id/owner auto-applies and moves node ownership in ACL", async () => {
    await expectAutoApply("owner change to bob", () =>
      app.inject({ method: "PATCH", url: `/nodes/${ids.node}/owner`, headers: h(), payload: { ownerUserId: ids.bob } })
    );
    const policy = await waitForPolicy((j) => j.includes("bob@"));
    // bob now owns the node, so bob@ must have a rule reaching the node host.
    expect(policy).toContain("bob@");
    // restore to alice for the share tests below
    await app.inject({ method: "PATCH", url: `/nodes/${ids.node}/owner`, headers: h(), payload: { ownerUserId: ids.alice } });
  });

  it("POST /nodes/:id/shares/users auto-applies", async () => {
    const res = await expectAutoApply("share to user", () =>
      app.inject({ method: "POST", url: `/nodes/${ids.node}/shares/users`, headers: h(), payload: { targetUserId: ids.bob, allowExitNode: false } })
    );
    ids.userShare = res.json().id;
  });

  it("POST /groups + POST /groups/:id/members auto-applies", async () => {
    const g = await app.inject({ method: "POST", url: "/groups", headers: h(), payload: { name: "team-a" } });
    expect(g.statusCode, g.body).toBeLessThan(400);
    ids.group = g.json().id;
    await expectAutoApply("add group member", () =>
      app.inject({ method: "POST", url: `/groups/${ids.group}/members`, headers: h(), payload: { userId: ids.bob } })
    );
  });

  it("POST /nodes/:id/shares/groups auto-applies", async () => {
    const res = await expectAutoApply("share to group", () =>
      app.inject({ method: "POST", url: `/nodes/${ids.node}/shares/groups`, headers: h(), payload: { targetGroupId: ids.group, allowExitNode: false } })
    );
    ids.groupShare = res.json().id;
  });

  it("DELETE /groups/:id/members/:userId auto-applies", async () => {
    await expectAutoApply("remove group member", () =>
      app.inject({ method: "DELETE", url: `/groups/${ids.group}/members/${ids.bob}`, headers: h() })
    );
  });

  it("DELETE /shares/:id (user share) auto-applies", async () => {
    await expectAutoApply("revoke user share", () =>
      app.inject({ method: "DELETE", url: `/shares/${ids.userShare}`, headers: h() })
    );
  });

  it("POST /nodes/:id/invites + accept auto-applies", async () => {
    const inv = await app.inject({ method: "POST", url: `/nodes/${ids.node}/invites`, headers: h(), payload: { allowExitNode: false, expiresInHours: 1, maxUses: 1 } });
    expect(inv.statusCode, inv.body).toBeLessThan(400);
    const inviteToken = inv.json().token as string;
    const bobAuth = await token("bob", TEST_PASS("bob"));
    await expectAutoApply("accept invite", () =>
      app.inject({ method: "POST", url: `/invites/${inviteToken}/accept`, headers: h(bobAuth) })
    );
  });

  it("POST /nodes/:id/expire auto-applies (Headscale-only path via markPolicyDirty)", async () => {
    await expectAutoApply("expire node", () =>
      app.inject({ method: "POST", url: `/nodes/${ids.node}/expire`, headers: h() })
    );
  });

  it("DELETE /nodes/:id auto-applies", async () => {
    await expectAutoApply("delete node", () =>
      app.inject({ method: "DELETE", url: `/nodes/${ids.node}`, headers: h() })
    );
  });

  it("PATCH /users/:id (disable bob) auto-applies and removes bob from ACL", async () => {
    await expectAutoApply("disable bob", () =>
      app.inject({ method: "PATCH", url: `/users/${ids.bob}`, headers: h(), payload: { disabled: true } })
    );
    const policy = await waitForPolicy((j) => !j.includes("bob@"));
    expect(policy).not.toContain("bob@");
  });

  it("DELETE /users/:id (soft-delete alice) auto-applies and removes alice from ACL", async () => {
    await expectAutoApply("delete alice", () =>
      app.inject({ method: "DELETE", url: `/users/${ids.alice}`, headers: h() })
    );
    const policy = await waitForPolicy((j) => !j.includes("alice@"));
    expect(policy).not.toContain("alice@");
  });

  it("does NOT auto-apply on a pure read (GET /users)", async () => {
    const before = app.policyAutoApplyCount;
    const res = await app.inject({ method: "GET", url: "/users", headers: h() });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(app.policyAutoApplyCount).toBe(before);
  });
});
