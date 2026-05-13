import type { PrismaClient } from "@prisma/client";
import type { CreateUserInput } from "@covaflux/shared";
import { env } from "../../config/env.js";
import type { HeadscaleClient } from "../../services/headscale/HeadscaleClient.js";
import { audit } from "../../utils/audit.js";
import { hashSecret } from "../../utils/secrets.js";

export async function bootstrapAdmin(prisma: PrismaClient, headscale: HeadscaleClient) {
  const admin = await prisma.user.findFirst({ where: { role: "admin" } });
  if (admin) return;

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

