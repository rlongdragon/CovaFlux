import { describe, expect, it } from "vitest";
import {
  createPolicyStore,
  enterPolicyContext,
  isPolicyDirty,
  isPolicyWrite,
  markPolicyDirty,
  runSuppressed
} from "./policyTracking.js";

describe("isPolicyWrite", () => {
  it("flags writes to policy models", () => {
    expect(isPolicyWrite("User", "update")).toBe(true);
    expect(isPolicyWrite("Node", "delete")).toBe(true);
    expect(isPolicyWrite("NodeShare", "create")).toBe(true);
    expect(isPolicyWrite("Group", "upsert")).toBe(true);
    expect(isPolicyWrite("GroupMember", "deleteMany")).toBe(true);
  });

  it("ignores reads and non-policy models", () => {
    expect(isPolicyWrite("User", "findMany")).toBe(false);
    expect(isPolicyWrite("ApiToken", "update")).toBe(false);
    expect(isPolicyWrite("PreAuthKey", "create")).toBe(false);
    expect(isPolicyWrite(undefined, "update")).toBe(false);
  });
});

describe("policy dirty tracking", () => {
  // Each test runs in its own async task; enterPolicyContext(enterWith) binds a
  // fresh store to that task's context, so state does not bleed between tests.

  it("marks dirty inside a context", async () => {
    await new Promise<void>((resolve) => {
      const store = createPolicyStore();
      enterPolicyContext(store);
      expect(isPolicyDirty()).toBe(false);
      markPolicyDirty();
      expect(isPolicyDirty()).toBe(true);
      expect(store.dirty).toBe(true);
      resolve();
    });
  });

  it("suppresses marking inside runSuppressed", async () => {
    const store = createPolicyStore();
    enterPolicyContext(store);
    await runSuppressed(async () => {
      markPolicyDirty();
    });
    expect(store.dirty).toBe(false);
  });

  it("restores marking after runSuppressed completes", async () => {
    const store = createPolicyStore();
    enterPolicyContext(store);
    await runSuppressed(async () => {
      markPolicyDirty();
    });
    markPolicyDirty();
    expect(store.dirty).toBe(true);
  });

  it("a fresh store starts clean even after a prior suppressed run", async () => {
    const first = createPolicyStore();
    enterPolicyContext(first);
    await runSuppressed(async () => {
      markPolicyDirty();
    });
    expect(first.dirty).toBe(false);

    // Binding a new store resets suppression state for subsequent marks.
    const second = createPolicyStore();
    enterPolicyContext(second);
    markPolicyDirty();
    expect(second.dirty).toBe(true);
    expect(first.dirty).toBe(false);
  });
});
