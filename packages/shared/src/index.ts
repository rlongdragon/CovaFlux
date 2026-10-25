import { z } from "zod";

export const userRoleSchema = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const apiScopeSchema = z.enum([
  "users:read",
  "users:write",
  "nodes:read",
  "nodes:write",
  "groups:read",
  "groups:write",
  "shares:read",
  "shares:write",
  "invites:write",
  "policy:read",
  "policy:write",
  "tokens:write",
  "settings:read",
  "settings:write"
]);

export type ApiScope = z.infer<typeof apiScopeSchema>;

export const allApiScopes: ApiScope[] = apiScopeSchema.options;

// Upper bounds keep request parsing and Argon2 hashing cost bounded.
const idSchema = z.string().min(1).max(64);
const passwordSchema = z.string().min(8).max(256);
const MAX_DERP_MAP_BYTES = 64 * 1024;

export const API_TOKEN_DEFAULT_TTL_DAYS = 90;
export const API_TOKEN_MAX_TTL_DAYS = 365;

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256)
});

export const createUserSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: passwordSchema,
  role: userRoleSchema.default("user")
});

export const updateUserSchema = z.object({
  password: passwordSchema.optional(),
  role: userRoleSchema.optional(),
  disabled: z.boolean().optional()
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema
});

export const derpSettingsSchema = z.object({
  derpMap: z
    .record(z.string(), z.unknown())
    .nullable()
    .refine((value) => JSON.stringify(value).length <= MAX_DERP_MAP_BYTES, "derpMap is too large")
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(80)
});

export const addGroupMemberSchema = z.object({
  userId: idSchema
});

export const registerKeySchema = z.object({
  userId: idSchema.optional(),
  nodeName: z.string().min(1).max(63).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  reusable: z.boolean().default(false),
  ephemeral: z.boolean().default(false),
  expiresInHours: z.number().int().positive().max(24 * 30).default(24)
});

export const shareToUserSchema = z.object({
  targetUserId: idSchema,
  allowExitNode: z.boolean().default(false),
  expiresAt: z.iso.datetime().optional()
});

export const shareToGroupSchema = z.object({
  targetGroupId: idSchema,
  allowExitNode: z.boolean().default(false),
  expiresAt: z.iso.datetime().optional()
});

export const createInviteSchema = z.object({
  allowExitNode: z.boolean().default(false),
  expiresInHours: z.number().int().positive().max(24 * 30).default(24),
  maxUses: z.number().int().positive().max(100).default(1)
});

export const changeNodeOwnerSchema = z.object({
  ownerUserId: idSchema
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(apiScopeSchema).min(1).max(apiScopeSchema.options.length),
  // Tokens always expire. Omitted -> API_TOKEN_DEFAULT_TTL_DAYS; the server
  // rejects anything in the past or beyond API_TOKEN_MAX_TTL_DAYS.
  expiresAt: z.iso.datetime().optional()
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type DerpSettingsInput = z.infer<typeof derpSettingsSchema>;
export type RegisterKeyInput = z.infer<typeof registerKeySchema>;
export type ShareToUserInput = z.infer<typeof shareToUserSchema>;
export type ShareToGroupInput = z.infer<typeof shareToGroupSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
export type ChangeNodeOwnerInput = z.infer<typeof changeNodeOwnerSchema>;
