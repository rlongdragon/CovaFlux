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
  "tokens:write"
]);

export type ApiScope = z.infer<typeof apiScopeSchema>;

export const allApiScopes: ApiScope[] = apiScopeSchema.options;

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export const createUserSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(8),
  role: userRoleSchema.default("user")
});

export const updateUserSchema = z.object({
  password: z.string().min(8).optional(),
  role: userRoleSchema.optional(),
  disabled: z.boolean().optional()
});

export const createGroupSchema = z.object({
  name: z.string().min(1).max(80)
});

export const addGroupMemberSchema = z.object({
  userId: z.string().min(1)
});

export const registerKeySchema = z.object({
  userId: z.string().optional(),
  nodeName: z.string().min(1).max(63).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  reusable: z.boolean().default(false),
  ephemeral: z.boolean().default(false),
  expiresInHours: z.number().int().positive().max(24 * 30).default(24)
});

export const shareToUserSchema = z.object({
  targetUserId: z.string().min(1),
  allowExitNode: z.boolean().default(false),
  expiresAt: z.string().datetime().optional()
});

export const shareToGroupSchema = z.object({
  targetGroupId: z.string().min(1),
  allowExitNode: z.boolean().default(false),
  expiresAt: z.string().datetime().optional()
});

export const createInviteSchema = z.object({
  allowExitNode: z.boolean().default(false),
  expiresInHours: z.number().int().positive().max(24 * 30).default(24),
  maxUses: z.number().int().positive().max(100).default(1)
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(apiScopeSchema).min(1),
  expiresAt: z.string().datetime().optional()
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type RegisterKeyInput = z.infer<typeof registerKeySchema>;
export type ShareToUserInput = z.infer<typeof shareToUserSchema>;
export type ShareToGroupInput = z.infer<typeof shareToGroupSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
