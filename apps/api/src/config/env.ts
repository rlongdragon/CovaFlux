import { z } from "zod";
import { readFileSync, statSync } from "node:fs";

// Values that have ever shipped in this repository (compose files, README,
// dev scripts). They are public, so production must never run with them.
export const KNOWN_DEFAULT_SECRETS = new Set([
  "dev-secret-change-me",
  "dev-secret-change-me-at-least-16",
  "change-this-jwt-secret-before-production",
  "change-me-password"
]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("file:./dev.db"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me"),
  // Lifetime of login JWTs (fastify-jwt / fast-jwt duration syntax).
  JWT_EXPIRES_IN: z.string().default("12h"),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default("change-me-password"),
  // Comma-separated list of browser origins allowed to call the API. "*" is
  // accepted outside production only. Empty = same-origin only (no CORS).
  CORS_ORIGINS: z.string().default(""),
  // Set when the API sits behind a reverse proxy so request.ip (used by the
  // login rate limiter) is the client address instead of the proxy's.
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  HEADSCALE_CLIENT_MODE: z.enum(["mock", "rest"]).default("mock"),
  HEADSCALE_BASE_URL: z.string().default("http://headscale:8080"),
  HEADSCALE_API_KEY: z.string().optional(),
  HEADSCALE_API_KEY_FILE: z.string().optional(),
  // Background policy reconcile interval (ms). Set to 0 to disable the loop.
  // Default 30s: covers nodes that join via pre-auth key, since Headscale does
  // not notify CovaFlux when a node registers.
  POLICY_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(30000)
});

const parsedEnv = envSchema.parse(process.env);

export function validateProductionEnv(config: Pick<z.infer<typeof envSchema>, "NODE_ENV" | "JWT_SECRET" | "BOOTSTRAP_ADMIN_PASSWORD" | "CORS_ORIGINS">) {
  if (config.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (KNOWN_DEFAULT_SECRETS.has(config.JWT_SECRET) || config.JWT_SECRET.length < 32) {
    problems.push("JWT_SECRET must be a random value of at least 32 characters (e.g. `openssl rand -base64 48`)");
  }
  if (KNOWN_DEFAULT_SECRETS.has(config.BOOTSTRAP_ADMIN_PASSWORD) || config.BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
    problems.push("BOOTSTRAP_ADMIN_PASSWORD must be set to a non-default password of at least 12 characters");
  }
  if (config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).includes("*")) {
    problems.push("CORS_ORIGINS=* is not allowed in production");
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to start with insecure production configuration:\n- ${problems.join("\n- ")}`);
  }
}

validateProductionEnv(parsedEnv);

/**
 * Returns the current Headscale API key. When it comes from a file, the file is
 * re-read whenever its mtime changes so a rotated key is picked up without a
 * restart.
 */
function createHeadscaleApiKeyProvider(): (() => string | undefined) {
  if (parsedEnv.HEADSCALE_API_KEY) {
    const key = parsedEnv.HEADSCALE_API_KEY;
    return () => key;
  }
  const file = parsedEnv.HEADSCALE_API_KEY_FILE;
  if (!file) return () => undefined;

  let cachedMtimeMs = -1;
  let cachedKey: string | undefined;
  return () => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch (error) {
      // Headscale may not have written the key yet on first start.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (mtimeMs !== cachedMtimeMs) {
      cachedKey = readFileSync(file, "utf8").trim() || undefined;
      cachedMtimeMs = mtimeMs;
    }
    return cachedKey;
  };
}

const headscaleApiKeyProvider = createHeadscaleApiKeyProvider();

export const env = {
  ...parsedEnv,
  CORS_ORIGINS: parsedEnv.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  headscaleApiKey: headscaleApiKeyProvider
};
