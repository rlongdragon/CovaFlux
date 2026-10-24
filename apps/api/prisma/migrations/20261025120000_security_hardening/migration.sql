-- AlterTable
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- API tokens are now looked up by SHA-256 instead of scanning every row with
-- Argon2 (CF-06), and every token must expire (CF-15). Legacy Argon2-hashed
-- tokens cannot be looked up that way, so revoke them; re-issue as needed.
UPDATE "ApiToken" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "revokedAt" IS NULL AND ("tokenHash" LIKE '$argon2%' OR "expiresAt" IS NULL);
