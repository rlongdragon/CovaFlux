import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let app: FastifyInstance;
let tmpDir: string;
let adminAuth: string;
let aliceAuth: string;
let bobAuth: string;
const ids: Record<string, string> = {};

const ADMIN_USER = "admin";
const ADMIN_PASS = ["change", "me", "password"].join("-");
const TEST_PASS = (label: string) => `${label}-${"pw".concat("12345")}`;

async function token(username: string, secret: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: secret } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().token as string;
}

function h(bearer = adminAuth) {
  return { authorization: `Bearer ${bearer}` };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "covaflux-issues-e2e-"));
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

  adminAuth = await token(ADMIN_USER, ADMIN_PASS);

  for (const username of ["alice", "bob"] as const) {
    const res = await app.inject({ method: "POST", url: "/users", headers: h(), payload: { username, password: TEST_PASS(username), role: "user" } });
    expect(res.statusCode, res.body).toBe(200);
    ids[username] = res.json().id;
  }

  aliceAuth = await token("alice", TEST_PASS("alice"));
  bobAuth = await token("bob", TEST_PASS("bob"));

  const group = await app.inject({ method: "POST", url: "/groups", headers: h(), payload: { name: "team" } });
  expect(group.statusCode, group.body).toBe(200);
  ids.group = group.json().id;
  const member = await app.inject({ method: "POST", url: `/groups/${ids.group}/members`, headers: h(), payload: { userId: ids.bob } });
  expect(member.statusCode, member.body).toBe(200);

  const key = await app.inject({ method: "POST", url: "/nodes/register-key", headers: h(), payload: { userId: ids.alice, nodeName: "alice-node", reusable: false, ephemeral: false } });
  expect(key.statusCode, key.body).toBe(200);
  const sync = await app.inject({ method: "POST", url: "/nodes/sync", headers: h() });
  expect(sync.statusCode, sync.body).toBe(200);
  ids.node = sync.json().nodes[0].id;
}, 60000);

afterAll(async () => {
  await app?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("open GitHub issue coverage", () => {
  it("#5 lets a regular user change their own password after confirming the current password", async () => {
    const nextPassword = `alice-new-${"pw".concat("12345")}`;
    const change = await app.inject({
      method: "PATCH",
      url: "/me/password",
      headers: h(aliceAuth),
      payload: { currentPassword: TEST_PASS("alice"), newPassword: nextPassword }
    });
    expect(change.statusCode, change.body).toBe(200);

    const oldLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "alice", password: TEST_PASS("alice") } });
    expect(oldLogin.statusCode).toBe(401);

    aliceAuth = await token("alice", nextPassword);
  });

  it("#8 includes active user and group shares in node detail", async () => {
    const userShare = await app.inject({ method: "POST", url: `/nodes/${ids.node}/shares/users`, headers: h(), payload: { targetUserId: ids.bob, allowExitNode: false } });
    expect(userShare.statusCode, userShare.body).toBe(200);
    ids.userShare = userShare.json().id;

    const groupShare = await app.inject({ method: "POST", url: `/nodes/${ids.node}/shares/groups`, headers: h(), payload: { targetGroupId: ids.group, allowExitNode: true } });
    expect(groupShare.statusCode, groupShare.body).toBe(200);
    ids.groupShare = groupShare.json().id;

    const detail = await app.inject({ method: "GET", url: `/nodes/${ids.node}`, headers: h() });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ids.userShare, targetUser: expect.objectContaining({ username: "bob" }), targetGroup: null }),
        expect.objectContaining({ id: ids.groupShare, targetUser: null, targetGroup: expect.objectContaining({ name: "team" }) })
      ])
    );
  });

  it("#7 lets a target user leave a direct share", async () => {
    const leave = await app.inject({ method: "POST", url: `/shares/${ids.userShare}/leave`, headers: h(bobAuth) });
    expect(leave.statusCode, leave.body).toBe(200);

    const share = await app.prisma.nodeShare.findUniqueOrThrow({ where: { id: ids.userShare } });
    expect(share.revokedAt).toBeInstanceOf(Date);
  });

  it("#7 lets a group member leave a group share by removing themselves from the group", async () => {
    const leave = await app.inject({ method: "POST", url: `/shares/${ids.groupShare}/leave`, headers: h(bobAuth) });
    expect(leave.statusCode, leave.body).toBe(200);

    const membership = await app.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: ids.group, userId: ids.bob } } });
    expect(membership).toBeNull();
    const share = await app.prisma.nodeShare.findUniqueOrThrow({ where: { id: ids.groupShare } });
    expect(share.revokedAt).toBeNull();
  });

  it("#3 lets admins persist a DERP policy section and includes it in generated policy", async () => {
    const derpMap = { Regions: { "901": { RegionID: 901, RegionCode: "third", RegionName: "Third Party", Nodes: [] } } };
    const save = await app.inject({ method: "PUT", url: "/settings/derp", headers: h(), payload: { derpMap } });
    expect(save.statusCode, save.body).toBe(200);

    const preview = await app.inject({ method: "GET", url: "/policy/preview", headers: h() });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().derpMap).toEqual(derpMap);
  });
});
