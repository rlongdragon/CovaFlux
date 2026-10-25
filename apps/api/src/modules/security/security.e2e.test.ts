import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MockHeadscaleClient } from "../../services/headscale/MockHeadscaleClient.js";

/**
 * Regression tests for the 2026-10-24 security audit (CF-xx ids).
 */

let app: FastifyInstance;
let tmpDir: string;
let adminAuth: string;
const ids: Record<string, string> = {};

const ADMIN_PASS = "security-admin-pass";
const PASS = (label: string) => `${label}-pass-12345`;

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function login(username: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().token as string;
}

async function createUser(username: string, role: "admin" | "user" = "user") {
  const res = await app.inject({ method: "POST", url: "/users", headers: bearer(adminAuth), payload: { username, password: PASS(username), role } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

async function createToken(auth: Record<string, string>, scopes: string[], extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api-tokens", headers: auth, payload: { name: "t", scopes, ...extra } });
}

async function registerNode(ownerAuth: string, nodeName: string) {
  const key = await app.inject({ method: "POST", url: "/nodes/register-key", headers: bearer(ownerAuth), payload: { nodeName } });
  expect(key.statusCode, key.body).toBe(200);
  const sync = await app.inject({ method: "POST", url: "/nodes/sync", headers: bearer(adminAuth) });
  expect(sync.statusCode, sync.body).toBe(200);
  const node = await app.prisma.node.findFirstOrThrow({ where: { name: nodeName } });
  return node;
}

function decodeJwt(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "covaflux-security-e2e-"));
  process.env.DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  process.env.HEADSCALE_CLIENT_MODE = "mock";
  process.env.POLICY_RECONCILE_INTERVAL_MS = "0";
  process.env.JWT_SECRET = "security-test-secret-at-least-32-chars";
  process.env.BOOTSTRAP_ADMIN_USERNAME = "admin";
  process.env.BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASS;
  process.env.CORS_ORIGINS = "https://covaflux.example";
  process.env.LOGIN_MAX_FAILURES = "5";
  execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: process.env, stdio: "ignore" });

  const { buildApp } = await import("../../app.js");
  app = await buildApp();
  await app.ready();
  adminAuth = await login("admin", ADMIN_PASS);
}, 60000);

afterAll(async () => {
  await app?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("CF-01/CF-02 production configuration", () => {
  it("refuses published default secrets and weak values in production", async () => {
    const { validateProductionEnv } = await import("../../config/env.js");
    const strong = { NODE_ENV: "production" as const, JWT_SECRET: "x".repeat(48), BOOTSTRAP_ADMIN_PASSWORD: "a-strong-admin-password", CORS_ORIGINS: "" };
    expect(() => validateProductionEnv(strong)).not.toThrow();
    expect(() => validateProductionEnv({ ...strong, JWT_SECRET: "change-this-jwt-secret-before-production" })).toThrow(/JWT_SECRET/);
    expect(() => validateProductionEnv({ ...strong, JWT_SECRET: "too-short-secret-1234" })).toThrow(/JWT_SECRET/);
    expect(() => validateProductionEnv({ ...strong, BOOTSTRAP_ADMIN_PASSWORD: "change-me-password" })).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
    expect(() => validateProductionEnv({ ...strong, CORS_ORIGINS: "*" })).toThrow(/CORS_ORIGINS/);
    expect(() => validateProductionEnv({ ...strong, NODE_ENV: "development", JWT_SECRET: "dev-secret-change-me" })).not.toThrow();
  });
});

describe("CF-03/CF-05/CF-06/CF-15 API tokens", () => {
  it("does not let a token mint scopes it does not hold", async () => {
    const limited = await createToken(bearer(adminAuth), ["tokens:write"]);
    expect(limited.statusCode, limited.body).toBe(200);
    const tokenAuth = { authorization: `Token ${limited.json().token}` };

    const escalate = await createToken(tokenAuth, ["users:write"]);
    expect(escalate.statusCode).toBe(403);
    const same = await createToken(tokenAuth, ["tokens:write"]);
    expect(same.statusCode, same.body).toBe(200);
  });

  it("stores a SHA-256 lookup hash and rejects malformed or unknown tokens", async () => {
    const created = await createToken(bearer(adminAuth), ["users:read"]);
    const row = await app.prisma.apiToken.findUniqueOrThrow({ where: { id: created.json().id } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    for (const value of ["garbage", "cft_does-not-exist"]) {
      const res = await app.inject({ method: "GET", url: "/users", headers: { authorization: `Token ${value}` } });
      expect(res.statusCode).toBe(401);
    }
    const ok = await app.inject({ method: "GET", url: "/users", headers: { authorization: `Token ${created.json().token}` } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("always sets an expiry and bounds it", async () => {
    const created = await createToken(bearer(adminAuth), ["users:read"]);
    const days = (new Date(created.json().expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    const tooLong = await createToken(bearer(adminAuth), ["users:read"], { expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() });
    expect(tooLong.statusCode).toBe(400);
    const past = await createToken(bearer(adminAuth), ["users:read"], { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.statusCode).toBe(400);
  });

  it("stops a token once its owner is disabled or demoted", async () => {
    const ownerId = await createUser("token-owner", "admin");
    const ownerAuth = await login("token-owner", PASS("token-owner"));
    const created = await createToken(bearer(ownerAuth), ["users:read"]);
    const tokenAuth = { authorization: `Token ${created.json().token}` };
    expect((await app.inject({ method: "GET", url: "/users", headers: tokenAuth })).statusCode).toBe(200);

    await app.inject({ method: "PATCH", url: `/users/${ownerId}`, headers: bearer(adminAuth), payload: { role: "user" } });
    expect((await app.inject({ method: "GET", url: "/users", headers: tokenAuth })).statusCode).toBe(401);

    await app.inject({ method: "PATCH", url: `/users/${ownerId}`, headers: bearer(adminAuth), payload: { role: "admin", disabled: true } });
    expect((await app.inject({ method: "GET", url: "/users", headers: tokenAuth })).statusCode).toBe(401);
  });
});

describe("CF-04 group detail", () => {
  it("never returns password hashes of members", async () => {
    const ownerId = await createUser("group-owner");
    const memberId = await createUser("group-member");
    const ownerAuth = await login("group-owner", PASS("group-owner"));
    const group = await app.inject({ method: "POST", url: "/groups", headers: bearer(ownerAuth), payload: { name: "g" } });
    await app.inject({ method: "POST", url: `/groups/${group.json().id}/members`, headers: bearer(ownerAuth), payload: { userId: memberId } });

    const detail = await app.inject({ method: "GET", url: `/groups/${group.json().id}`, headers: bearer(ownerAuth) });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain("passwordHash");
    expect(detail.body).not.toContain("$argon2");
    expect(detail.json().members[0].user).toEqual({ id: memberId, username: "group-member" });
    expect(ownerId).toBeTruthy();
  });
});

describe("CF-11 JWT lifetime and revocation", () => {
  it("issues expiring JWTs and revokes them on logout and password change", async () => {
    await createUser("session-user");
    const first = await login("session-user", PASS("session-user"));
    const claims = decodeJwt(first);
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(12 * 3600);

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: bearer(first) });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(first) })).statusCode).toBe(401);

    const second = await login("session-user", PASS("session-user"));
    const change = await app.inject({
      method: "PATCH",
      url: "/me/password",
      headers: bearer(second),
      payload: { currentPassword: PASS("session-user"), newPassword: "a-brand-new-password" }
    });
    expect(change.statusCode, change.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(second) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(change.json().token) })).statusCode).toBe(200);
  });
});

describe("CF-12/CF-23 login throttling", () => {
  it("returns 429 after repeated failures and does not audit every attempt", async () => {
    await createUser("brute-target");
    const before = await app.prisma.auditLog.count({ where: { action: "auth.login_failed" } });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "brute-target", password: `wrong-${i}` } });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    const after = await app.prisma.auditLog.count({ where: { action: "auth.login_failed" } });
    expect(after - before).toBe(1);

    // Correct password is also refused while throttled.
    const blocked = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "brute-target", password: PASS("brute-target") } });
    expect(blocked.statusCode).toBe(429);
  });

  it("cannot be bypassed with concurrent attempts", async () => {
    await createUser("burst-target");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => app.inject({ method: "POST", url: "/auth/login", payload: { username: "burst-target", password: `wrong-${i}` } }))
    );
    const unauthorized = results.filter((res) => res.statusCode === 401).length;
    expect(unauthorized).toBeLessThanOrEqual(5);
    expect(results.filter((res) => res.statusCode === 429).length).toBe(12 - unauthorized);
  });

  it("takes about as long for unknown usernames as for wrong passwords", async () => {
    await createUser("timing-user");
    const time = async (username: string) => {
      const started = performance.now();
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: "wrong-password" } });
      expect(res.statusCode).toBe(401);
      return performance.now() - started;
    };
    const known = await time("timing-user");
    const unknown = await time("timing-nobody");
    expect(unknown).toBeGreaterThan(known * 0.5);
  });
});

describe("CF-07 policy fail-open", () => {
  it("does not report success when a revocation cannot be enforced", async () => {
    const targetId = await createUser("revoke-target");
    const node = await registerNode(adminAuth, "revoke-node");
    const share = await app.inject({ method: "POST", url: `/nodes/${node.id}/shares/users`, headers: bearer(adminAuth), payload: { targetUserId: targetId } });
    expect(share.statusCode, share.body).toBe(200);

    const mock = app.headscale as MockHeadscaleClient;
    const applySpy = vi.spyOn(mock, "applyPolicy").mockRejectedValueOnce(new Error("headscale down"));
    const revoke = await app.inject({ method: "DELETE", url: `/shares/${share.json().id}`, headers: bearer(adminAuth) });
    expect(revoke.statusCode).toBe(503);
    expect(revoke.json().error).toBe("policy_apply_failed");
    applySpy.mockRestore();

    const { reconcilePolicyOnce } = await import("../policy/policyReconciler.js");
    await reconcilePolicyOnce(app.prisma, app.headscale);
    const live = await mock.getPolicy();
    const targetAcl = live.acls.find((acl) => acl.src.includes("revoke-target@"));
    expect(targetAcl?.dst ?? []).not.toContain("revoke-node:*");
  });
});

describe("CF-08 node ownership", () => {
  it("keeps Headscale as the only ownership authority", async () => {
    const aliceId = await createUser("alice-own");
    const bobId = await createUser("bob-own");
    const aliceAuth = await login("alice-own", PASS("alice-own"));
    const node = await registerNode(aliceAuth, "owned-node");
    expect(node.ownerUserId).toBe(aliceId);

    // A database-only transfer would leave Alice's device identity and
    // "alice-own@" ACL expansion in Headscale, so it is refused.
    const transfer = await app.inject({ method: "PATCH", url: `/nodes/${node.id}/owner`, headers: bearer(adminAuth), payload: { ownerUserId: bobId } });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json().error).toBe("owner_transfer_unsupported");

    // A diverged row (e.g. from an older release) is corrected by sync.
    await app.prisma.node.update({ where: { id: node.id }, data: { ownerUserId: bobId } });
    const sync = await app.inject({ method: "POST", url: "/nodes/sync", headers: bearer(adminAuth) });
    expect(sync.statusCode, sync.body).toBe(200);
    expect((await app.prisma.node.findUniqueOrThrow({ where: { id: node.id } })).ownerUserId).toBe(aliceId);
    expect(await app.prisma.auditLog.count({ where: { action: "node.owner_reconciled", resourceId: node.id } })).toBe(1);
  });

  it("serializes syncs so a slow stale snapshot cannot overwrite a newer one", async () => {
    const node = await registerNode(adminAuth, "sync-race-node");
    const mock = app.headscale as MockHeadscaleClient;
    const stale = await mock.listNodes();
    const listSpy = vi.spyOn(mock, "listNodes").mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return stale;
    });
    const first = app.inject({ method: "POST", url: "/nodes/sync", headers: bearer(adminAuth) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await mock.expireNode(node.headscaleNodeId);
    const second = app.inject({ method: "POST", url: "/nodes/sync", headers: bearer(adminAuth) });
    const [firstRes, secondRes] = await Promise.all([first, second]);
    listSpy.mockRestore();
    expect(firstRes.statusCode, firstRes.body).toBe(200);
    expect(secondRes.statusCode, secondRes.body).toBe(200);
    // The policy applied last was generated after the stale sync finished.
    const live = await mock.getPolicy();
    expect(live.hosts ?? {}).not.toHaveProperty("sync-race-node");
  });
});

describe("CF-10/CF-25 invites", () => {
  it("enforces maxUses under concurrent accepts", async () => {
    const node = await registerNode(adminAuth, "invite-node");
    const invite = await app.inject({ method: "POST", url: `/nodes/${node.id}/invites`, headers: bearer(adminAuth), payload: { maxUses: 1 } });
    expect(invite.statusCode, invite.body).toBe(200);
    await createUser("invitee");
    const inviteeAuth = await login("invitee", PASS("invitee"));

    const results = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: "POST", url: `/invites/${invite.json().token}/accept`, headers: bearer(inviteeAuth) }))
    );
    expect(results.filter((res) => res.statusCode === 200)).toHaveLength(1);
    expect(await app.prisma.nodeShare.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it("stops working once the creator no longer controls the node", async () => {
    await createUser("inviter");
    const inviterAuth = await login("inviter", PASS("inviter"));
    const node = await registerNode(inviterAuth, "inviter-node");
    const invite = await app.inject({ method: "POST", url: `/nodes/${node.id}/invites`, headers: bearer(inviterAuth), payload: { maxUses: 5 } });
    expect(invite.statusCode, invite.body).toBe(200);
    await createUser("late-invitee");
    const inviteeAuth = await login("late-invitee", PASS("late-invitee"));

    const adminUser = await app.prisma.user.findFirstOrThrow({ where: { username: "admin" } });
    await app.prisma.node.update({ where: { id: node.id }, data: { ownerUserId: adminUser.id } });
    const accept = await app.inject({ method: "POST", url: `/invites/${invite.json().token}/accept`, headers: bearer(inviteeAuth) });
    expect(accept.statusCode).toBe(404);
    expect(await app.prisma.nodeShare.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it("exposes only minimal node data to unauthenticated viewers", async () => {
    const node = await registerNode(adminAuth, "preview-node");
    const invite = await app.inject({ method: "POST", url: `/nodes/${node.id}/invites`, headers: bearer(adminAuth), payload: {} });
    const preview = await app.inject({ method: "GET", url: `/invites/${invite.json().token}` });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().node).toEqual({ id: node.id, name: "preview-node" });
  });
});

describe("share listings", () => {
  it("do not expose node keys to share recipients", async () => {
    const recipientId = await createUser("share-recipient");
    const node = await registerNode(adminAuth, "listed-node");
    await app.inject({ method: "POST", url: `/nodes/${node.id}/shares/users`, headers: bearer(adminAuth), payload: { targetUserId: recipientId } });
    const recipientAuth = await login("share-recipient", PASS("share-recipient"));
    const shares = await app.inject({ method: "GET", url: "/shares", headers: bearer(recipientAuth) });
    expect(shares.statusCode, shares.body).toBe(200);
    expect(Object.keys(shares.json()[0].node).sort()).toEqual(["deletedAt", "givenName", "id", "isExitNode", "name", "ownerUserId"]);
    expect(shares.body).not.toContain("machineKey");
    expect(shares.body).not.toContain("nodeKey");
  });
});

describe("CF-13 expired nodes", () => {
  it("drops an expired node from generated hosts and ACLs", async () => {
    const node = await registerNode(adminAuth, "expiring-node");
    const expire = await app.inject({ method: "POST", url: `/nodes/${node.id}/expire`, headers: bearer(adminAuth) });
    expect(expire.statusCode, expire.body).toBe(200);
    const live = await (app.headscale as MockHeadscaleClient).getPolicy();
    expect(live.hosts ?? {}).not.toHaveProperty("expiring-node");
    expect(JSON.stringify(live.acls)).not.toContain("expiring-node:*");
  });
});

describe("CF-16 settings scopes", () => {
  it("requires settings:* for DERP settings", async () => {
    const policyToken = await createToken(bearer(adminAuth), ["policy:write", "policy:read"]);
    const settingsToken = await createToken(bearer(adminAuth), ["settings:write", "settings:read"]);
    const body = { derpMap: null };
    const denied = await app.inject({ method: "PUT", url: "/settings/derp", headers: { authorization: `Token ${policyToken.json().token}` }, payload: body });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "PUT", url: "/settings/derp", headers: { authorization: `Token ${settingsToken.json().token}` }, payload: body });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });
});

describe("CF-21/CF-22 HTTP surface", () => {
  it("only allows configured CORS origins, without credentials", async () => {
    const evil = await app.inject({ method: "OPTIONS", url: "/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const good = await app.inject({ method: "OPTIONS", url: "/me", headers: { origin: "https://covaflux.example", "access-control-request-method": "GET" } });
    expect(good.headers["access-control-allow-origin"]).toBe("https://covaflux.example");
    expect(good.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("maps missing records to 404 without internal details", async () => {
    const res = await app.inject({ method: "GET", url: "/nodes/does-not-exist", headers: bearer(adminAuth) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});
