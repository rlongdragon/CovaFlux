import type { FastifyInstance } from "fastify";
import { derpSettingsSchema } from "@covaflux/shared";
import { audit } from "../../utils/audit.js";

const DERP_SETTING_KEY = "derpMap";

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/settings/derp", async (request) => {
    await app.requireScope(request, "policy:read");
    const setting = await app.prisma.systemSetting.findUnique({ where: { key: DERP_SETTING_KEY } });
    return setting ? JSON.parse(setting.valueJson) : { derpMap: null };
  });

  app.put("/settings/derp", async (request) => {
    const actor = await app.requireScope(request, "policy:write");
    const input = derpSettingsSchema.parse(request.body);
    const setting = await app.prisma.systemSetting.upsert({
      where: { key: DERP_SETTING_KEY },
      create: { key: DERP_SETTING_KEY, valueJson: JSON.stringify(input) },
      update: { valueJson: JSON.stringify(input) }
    });
    await audit(app.prisma, actor, "settings.derp_updated", "system_setting", setting.id);
    return input;
  });
}
