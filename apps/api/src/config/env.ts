import { z } from "zod";
import { readFileSync } from "node:fs";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("file:./dev.db"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me"),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default("change-me-password"),
  HEADSCALE_CLIENT_MODE: z.enum(["mock", "rest"]).default("mock"),
  HEADSCALE_BASE_URL: z.string().default("http://headscale:8080"),
  HEADSCALE_API_KEY: z.string().optional(),
  HEADSCALE_API_KEY_FILE: z.string().optional()
});

const parsedEnv = envSchema.parse(process.env);

export const env = {
  ...parsedEnv,
  HEADSCALE_API_KEY:
    parsedEnv.HEADSCALE_API_KEY ??
    (parsedEnv.HEADSCALE_API_KEY_FILE ? readFileSync(parsedEnv.HEADSCALE_API_KEY_FILE, "utf8").trim() : undefined)
};
