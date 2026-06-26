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
  it("marks dirty inside a context", () => {
    enterPolicyContext(createPolicyStore());
    expect(isPolicyDirty()).toBe(false);
    markPolicyDirty();
    expect(isPolicyDirty()).toBe(true);
  });

  it("suppresses marking inside runSuppressed", async () => {
    enterPolicyContext(createPolicyStore());
    await runSuppressed(async () => {
      markPolicyDirty();
    });
    expect(isPolicyDirty()).toBe(false);
  });

  it("restores marking after runSuppressed completes", async () => {
    enterPolicyContext(createPolicyStore());
    await runSuppressed(async () => {
      markPolicyDirty();
    });
    markPolicyDirty();
    expect(isPolicyDirty()).toBe(true);
  });
});
