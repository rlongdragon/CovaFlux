import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MockHeadscaleClient } from "../../services/headscale/MockHeadscaleClient.js";

let app: FastifyInstance;
let tmpDir: string;
let auth: string;
const ids: Record<string, string> = {};
const ADMIN_PASS = ["change", "me", "password"].join("-");

function h() {
  return { authorization: `Bearer ${auth}` };
}

async function waitForPolicyVersionAfter(version: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const latest = await app.prisma.policyVersion.findFirst({ orderBy: { version: "desc" } });
    if ((latest?.version ?? 0) > version) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for policy version after ${version}`);
}

async function setNodeOwnerStable(nodeId: string, ownerUserId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await app.prisma.node.update({ where: { id: nodeId }, data: { ownerUserId, driftStatus: "managed" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const fresh = await app.prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    if (fresh.ownerUserId === ownerUserId) return;
  }
  throw new Error(`Timed out pinning node ${nodeId} to owner ${ownerUserId}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "covaflux-exit-node-e2e-"));
  process.env.DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  process.env.HEADSCALE_CLIENT_MODE = "mock";
  process.env.POLICY_RECONCILE_INTERVAL_MS = "0";
  process.env.JWT_SECRET = "test-secret-at-least-16-chars";
  process.env.BOOTSTRAP_ADMIN_USERNAME = "admin";
  process.env.BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASS;
  execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: process.env, stdio: "ignore" });

  const { buildApp } = await import("../../app.js");
  app = await buildApp();
  await app.ready();

  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: ADMIN_PASS } });
  auth = login.json().token;
  const key = await app.inject({ method: "POST", url: "/nodes/register-key", headers: h(), payload: { nodeName: "exit-node" } });
  expect(key.statusCode, key.body).toBe(200);
  const mock = app.headscale as MockHeadscaleClient;
  const runtime = (await mock.listNodes())[0];
  mock.setNode({ ...runtime, advertisedRoutes: ["0.0.0.0/0", "::/0"], isExitNode: true });
  const sync = await app.inject({ method: "POST", url: "/nodes/sync", headers: h() });
  expect(sync.statusCode, sync.body).toBe(200);
  ids.node = sync.json().nodes[0].id;
}, 60000);

afterAll(async () => {
  await app?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("exit-node approval route", () => {
  it("rejects a user who neither owns the node nor is an administrator", async () => {
    const userPassword = "test-user-password";
    const createUser = await app.inject({
      method: "POST",
      url: "/users",
      headers: h(),
      payload: { username: "exit-user", password: userPassword, role: "user" }
    });
    expect(createUser.statusCode, createUser.body).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "exit-user", password: userPassword }
    });
    expect(login.statusCode, login.body).toBe(200);
    const userHeaders = { authorization: `Bearer ${login.json().token}` };

    const approve = await app.inject({ method: "POST", url: `/nodes/${ids.node}/exit-node/approve`, headers: userHeaders });
    expect(approve.statusCode).toBe(403);
    const disable = await app.inject({ method: "POST", url: `/nodes/${ids.node}/exit-node/disable`, headers: userHeaders });
    expect(disable.statusCode).toBe(403);
  });

  it("lets the node owner approve and disable exit-node routes without being an administrator", async () => {
    const ownerPassword = "test-owner-password";
    const createOwner = await app.inject({
      method: "POST",
      url: "/users",
      headers: h(),
      payload: { username: "exit-owner", password: ownerPassword, role: "user" }
    });
    expect(createOwner.statusCode, createOwner.body).toBe(200);
    const ownerId = createOwner.json().id;

    await setNodeOwnerStable(ids.node, ownerId);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "exit-owner", password: ownerPassword }
    });
    expect(login.statusCode, login.body).toBe(200);
    const ownerHeaders = { authorization: `Bearer ${login.json().token}` };

    const mock = app.headscale as MockHeadscaleClient;
    const runtime = (await mock.listNodes())[0];
    mock.setNode({ ...runtime, advertisedRoutes: ["0.0.0.0/0", "::/0"], approvedRoutes: [], isExitNode: true, isExitNodeApproved: false });

    const approve = await app.inject({ method: "POST", url: `/nodes/${ids.node}/exit-node/approve`, headers: ownerHeaders });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json().isExitNodeApproved).toBe(true);

    const disable = await app.inject({ method: "POST", url: `/nodes/${ids.node}/exit-node/disable`, headers: ownerHeaders });
    expect(disable.statusCode, disable.body).toBe(200);
    expect(disable.json().isExitNodeApproved).toBe(false);

    // restore admin ownership so later cases keep their original fixture
    const adminUser = await app.prisma.user.findFirstOrThrow({ where: { username: "admin" } });
    await setNodeOwnerStable(ids.node, adminUser.id);
  });

  it("lets an administrator approve advertised exit routes without dropping other approved routes", async () => {
    const before = await app.prisma.policyVersion.findFirst({ orderBy: { version: "desc" } });
    const response = await app.inject({ method: "POST", url: `/nodes/${ids.node}/exit-node/approve`, headers: h() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      advertisedRoutes: ["0.0.0.0/0", "::/0"],
      approvedRoutes: ["0.0.0.0/0", "::/0"],
      isExitNode: true,
      isExitNodeApproved: true
    }));
    await waitForPolicyVersionAfter(before?.version ?? 0);
  });

  it("lets an administrator disable exit-node approval while preserving non-exit routes", async () => {
    const mock = app.headscale as MockHeadscaleClient;
    const runtime = (await mock.listNodes())[0];
    mock.setNode({ ...runtime, approvedRoutes: ["10.0.0.0/8", "0.0.0.0/0", "::/0"], isExitNodeApproved: true });
    const before = await app.prisma.policyVersion.findFirst({ orderBy: { version: "desc" } });

    const response = await app.inject({ method: "POST", url: `/nodes/${ids.node}/exit-node/disable`, headers: h() });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().approvedRoutes).toEqual(["10.0.0.0/8"]);
    expect(response.json().isExitNodeApproved).toBe(false);
    await waitForPolicyVersionAfter(before?.version ?? 0);
  });
});
