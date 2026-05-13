import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("file:./dev.db"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me"),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default("change-me-password"),
  HEADSCALE_CLIENT_MODE: z.enum(["mock", "grpc"]).default("mock"),
  HEADSCALE_BASE_URL: z.string().default("http://headscale:8080")
});

export const env = envSchema.parse(process.env);

