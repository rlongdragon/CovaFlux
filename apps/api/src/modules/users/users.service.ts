import type { PrismaClient } from "@prisma/client";
import type { CreateUserInput } from "@covaflux/shared";
import { env, KNOWN_DEFAULT_SECRETS } from "../../config/env.js";
import type { HeadscaleClient } from "../../services/headscale/HeadscaleClient.js";
import { audit } from "../../utils/audit.js";
import { hashSecret, verifySecret } from "../../utils/secrets.js";

/**
 * Deployments that started with a published default password keep it in the
 * database even after the env var is fixed. In production, replace any admin
 * password that still matches a known default with BOOTSTRAP_ADMIN_PASSWORD
 * (which validateProductionEnv guarantees is not a default).
 */
async function rotateDefaultAdminPasswords(prisma: PrismaClient) {
  const admins = await prisma.user.findMany({ where: { role: "admin", disabledAt: null } });
  for (const admin of admins) {
    for (const candidate of KNOWN_DEFAULT_SECRETS) {
      if (!(await verifySecret(admin.passwordHash, candidate))) continue;
      await prisma.user.update({
        where: { id: admin.id },
        data: { passwordHash: await hashSecret(env.BOOTSTRAP_ADMIN_PASSWORD), tokenVersion: { increment: 1 } }
      });
      await audit(prisma, { type: "system" }, "user.default_password_rotated", "user", admin.id);
      break;
    }
  }
}

export async function bootstrapAdmin(prisma: PrismaClient, headscale: HeadscaleClient) {
  const admin = await prisma.user.findFirst({ where: { role: "admin" } });
  if (admin) {
    if (env.NODE_ENV === "production") await rotateDefaultAdminPasswords(prisma);
    return;
  }

  const input: CreateUserInput = {
    username: env.BOOTSTRAP_ADMIN_USERNAME,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
    role: "admin"
  };

  await headscale.createUser({ name: input.username });
  const user = await prisma.user.create({
    data: {
      username: input.username,
      passwordHash: await hashSecret(input.password),
      role: input.role,
      headscaleUserName: input.username
    }
  });
  await audit(prisma, { type: "system" }, "user.bootstrap_admin_created", "user", user.id);
}

