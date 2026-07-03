import { describe, expect, it } from "vitest";
import { generatePolicy } from "./policy.generator.js";
import { POLICY_MODELS } from "../../plugins/policyTracking.js";

/**
 * Structural guard: every Prisma model that generatePolicy() reads must be in
 * POLICY_MODELS, because POLICY_MODELS is what the Prisma extension watches to
 * trigger an automatic policy reapply. If someone extends the policy to read a
 * new model (e.g. a future "Tag" table) but forgets to add it here, writes to
 * that model would silently NOT reapply policy — exactly the bug class this
 * whole mechanism exists to prevent. This test fails loudly in that case.
 *
 * We drive generatePolicy with a recording Prisma proxy that captures which
 * model delegates were touched, mapping Prisma's camelCase delegate names back
 * to PascalCase model names.
 */

const DELEGATE_TO_MODEL: Record<string, string | null> = {
  user: "User",
  node: "Node",
  nodeShare: "NodeShare",
  group: "Group",
  groupMember: "GroupMember",
  systemSetting: "SystemSetting"
};

function createRecordingPrisma(touched: Set<string>) {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        // Each delegate (prisma.user, prisma.node, ...) records itself and
        // returns no-op query methods that resolve to empty results.
        touched.add(prop);
        return new Proxy(
          {},
          {
            get() {
              return async () => [];
            }
          }
        );
      }
    }
  );
}

describe("generatePolicy model coverage guard", () => {
  it("only reads models declared in POLICY_MODELS", async () => {
    const touched = new Set<string>();
    const prisma = createRecordingPrisma(touched) as never;

    await generatePolicy(prisma, []);

    const readModels = [...touched]
      .map((delegate) => DELEGATE_TO_MODEL[delegate])
      .filter((model): model is string => Boolean(model));

    // Sanity: the proxy actually observed reads.
    expect(touched.size).toBeGreaterThan(0);

    for (const model of readModels) {
      expect(
        POLICY_MODELS.has(model),
        `generatePolicy reads "${model}" but it is missing from POLICY_MODELS. ` +
          `Add it so writes to that model trigger an automatic policy reapply.`
      ).toBe(true);
    }

    // Also flag any delegate the test doesn't know how to map yet, so the
    // mapping table is kept in sync with the generator.
    const unmapped = [...touched].filter((delegate) => !(delegate in DELEGATE_TO_MODEL));
    expect(
      unmapped,
      `generatePolicy touched unmapped Prisma delegate(s): ${unmapped.join(", ")}. ` +
        `Update DELEGATE_TO_MODEL and POLICY_MODELS if these feed the policy.`
    ).toEqual([]);
  });
});
