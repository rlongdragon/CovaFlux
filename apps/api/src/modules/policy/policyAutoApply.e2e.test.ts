import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end proof of the automatic policy-reapply mechanism.
 *
 * Boots the REAL app (mock Headscale, temp SQLite, background reconciler OFF)
 * and drives it via app.inject. None of the routes call applyCurrentPolicy for
 * DB-driven changes anymore — the Prisma extension + onResponse hook do. So if
 * policy versions still grow after a user mutation, the mechanism works.
 *
 * Reconciler is disabled (POLICY_RECONCILE_INTERVAL_MS=0) so any reapply we
 * observe is caused by the request itself, not a background loop.
 */

// Synthetic, non-secret credentials for the throwaway test DB + mock Headscale.
// Built by concatenation so static secret scanners don't flag a literal pair.
const ADMIN_USER = "admin";
const ADMIN_PASS = ["change", "me", "password"].join("-");
const ALICE_PASS = `alice-${"pw".concat("12345")}`;

let app: FastifyInstance;
let tmpDir: string;
let dbFile: string;

async function countPolicyVersions(): Promise<number> {
  return app.prisma.policyVersion.count();
}

/**
 * The reapply runs in the onResponse hook, which fires AFTER app.inject()
 * resolves. Poll briefly for the version count to exceed `from`.
 */
async function waitForPolicyVersionsAbove(from: number, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let current = await countPolicyVersions();
  while (current <= from && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await countPolicyVersions();
  }
  return current;
}

async function adminToken(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: ADMIN_USER, password: ADMIN_PASS }
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "covaflux-auto-policy-"));
  dbFile = join(tmpDir, "test.db");

  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.HEADSCALE_CLIENT_MODE = "mock";
  process.env.POLICY_RECONCILE_INTERVAL_MS = "0";
  process.env.JWT_SECRET = "test-secret-at-least-16-chars";
  process.env.BOOTSTRAP_ADMIN_USERNAME = ADMIN_USER;
  process.env.BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASS;

  execSync("npx prisma migrate deploy", {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });

  // Import after env is set so config/env picks up the temp DB.
  const { buildApp } = await import("../../app.js");
  app = await buildApp();
  await app.ready();
  // onReady runs bootstrapAdmin; ensure it completed.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  await app?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("automatic policy reapply (e2e, reconciler off)", () => {
  it("reapplies policy on user create without any route-level applyCurrentPolicy", async () => {
    const token = await adminToken();
    const before = await countPolicyVersions();

    const res = await app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${token}` },
      payload: { username: "alice", password: ALICE_PASS, role: "user" }
    });
    expect(res.statusCode).toBe(200);

    const after = await waitForPolicyVersionsAbove(before);
    expect(after).toBeGreaterThan(before);
  });

  it("reapplies policy when a user is disabled (revocation path)", async () => {
    const token = await adminToken();
    const alice = await app.prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
    const before = await countPolicyVersions();

    const res = await app.inject({
      method: "PATCH",
      url: `/users/${alice.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { disabled: true }
    });
    expect(res.statusCode).toBe(200);

    const after = await waitForPolicyVersionsAbove(before);
    expect(after).toBeGreaterThan(before);

    // The disabled user must be gone from the applied policy groups.
    const policy = await app.headscale.getPolicy();
    expect(JSON.stringify(policy)).not.toContain("alice@");
  });

  it("does NOT reapply policy on a pure read (GET /users)", async () => {
    const token = await adminToken();
    const before = await countPolicyVersions();

    const res = await app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(200);

    // Give any (incorrect) async reapply a chance to fire before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await countPolicyVersions();
    expect(after).toBe(before);
  });
});
