import crypto from "node:crypto";
import argon2 from "argon2";

export async function hashSecret(secret: string) {
  return argon2.hash(secret);
}

export async function verifySecret(hash: string, secret: string) {
  return argon2.verify(hash, secret);
}

export function createOpaqueToken(prefix: string) {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashLookupToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

