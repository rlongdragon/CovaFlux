# CovaFlux API Reference

This document describes the current CovaFlux HTTP API.

## Base URL

Development default:

```text
http://localhost:12145
```

Remote development example:

```text
http://23.146.248.110:12145
```

All request and response bodies are JSON unless noted otherwise.

## Authentication

CovaFlux supports two authentication methods.

### User JWT

Log in with username and password:

```http
POST /auth/login
```

Then send the returned JWT in the `Authorization` header:

```http
Authorization: Bearer <jwt>
```

### System API Token

API tokens are created with `/api-tokens`. Send them with the `Token` auth scheme:

```http
Authorization: Token <api-token>
```

API tokens must include the required scope for each endpoint.

## Roles And Scopes

Admin users can access all scoped endpoints. Non-admin users can access user-facing endpoints through `requireUserOrScope`, subject to ownership checks.

Available API token scopes:

```text
users:read
users:write
nodes:read
nodes:write
groups:read
groups:write
shares:read
shares:write
invites:write
policy:read
policy:write
tokens:write
```

## Common Errors

Validation errors return HTTP `400` with Zod issue details:

```json
{
  "error": "validation_error",
  "issues": []
}
```

Authentication failures return HTTP `401`:

```json
{
  "error": "invalid_credentials"
}
```

Permission failures return HTTP `403`:

```json
{
  "error": "permission_denied"
}
```

Unhandled server errors return HTTP `500`:

```json
{
  "error": "internal_server_error",
  "message": "..."
}
```

## Health

### `GET /health`

Public health check.

Response:

```json
{
  "ok": true
}
```

## Auth

### `POST /auth/login`

Logs in a user and returns a JWT.

Body:

```json
{
  "username": "admin",
  "password": "change-me-password"
}
```

Response:

```json
{
  "token": "<jwt>"
}
```

### `POST /auth/logout`

Stateless logout endpoint. The client should discard the JWT.

Response:

```json
{
  "ok": true
}
```

### `GET /me`

Returns the authenticated actor.

Auth: required.

Response:

```json
{
  "actor": {
    "type": "user",
    "id": "user_id",
    "username": "admin",
    "role": "admin"
  }
}
```

For API tokens, `actor.type` is `api_token`.

## Users

### `GET /users`

Lists users.

Auth: user or `users:read`.

Behavior:

- Admin users receive full user records.
- Non-admin users receive active user IDs and usernames only.

### `POST /users`

Creates a CovaFlux user and creates the matching Headscale user.

Auth: `users:write`.

Body:

```json
{
  "username": "alice",
  "password": "minimum-8-chars",
  "role": "user"
}
```

Rules:

- `username`: 2-64 chars, letters, numbers, `_`, `.`, `-`.
- `password`: minimum 8 chars.
- `role`: `admin` or `user`, defaults to `user`.

Response: created user without password hash.

### `GET /users/:id`

Returns one user.

Auth: `users:read`.

### `PATCH /users/:id`

Updates a user.

Auth: `users:write`.

Body:

```json
{
  "password": "new-password",
  "role": "admin",
  "disabled": false
}
```

All fields are optional.

### `DELETE /users/:id`

Disables a user by setting `disabledAt`.

Auth: `users:write`.

Response:

```json
{
  "ok": true,
  "id": "user_id"
}
```

## Nodes

### `GET /nodes`

Lists synchronized nodes.

Auth: user or `nodes:read`.

Behavior:

- Admin users receive all non-deleted local nodes.
- Non-admin users receive owned non-deleted local nodes.
- The response is enriched with live Headscale runtime state: `ipAddresses`, `online`, `expired`, and `expiresAt`.

### `GET /nodes/:id`

Returns one node.

Auth: user or `nodes:read`.

Non-admin users can only read their own nodes.

### `POST /nodes/register-key`

Creates a Headscale pre-auth key for node registration.

Auth: user or `nodes:write`.

Body:

```json
{
  "userId": "target_user_id",
  "nodeName": "optional-node-name",
  "reusable": false,
  "ephemeral": false,
  "expiresInHours": 24
}
```

Rules:

- Non-admin users can only create keys for themselves.
- API token callers must provide `userId`.
- `nodeName`: optional, 1-63 chars, letters, numbers, `_`, `.`, `-`.
- `expiresInHours`: positive integer, max 720.

Response:

```json
{
  "id": "local_preauth_key_id",
  "key": "hskey-auth-...",
  "expiresAt": "2026-05-19T00:00:00.000Z"
}
```

Example Tailscale command:

```bash
sudo tailscale up --reset --login-server=http://<headscale-host> --auth-key=hskey-auth-...
```

### `POST /nodes/sync`

Synchronizes nodes from Headscale into the local database.

Auth: user or `nodes:write`.

Behavior:

- Upserts live Headscale nodes.
- Assigns owner by matching Headscale username to CovaFlux `headscaleUserName`.
- Marks local nodes missing from Headscale as deleted with `driftStatus: "deleted"`.

Response:

```json
{
  "count": 3,
  "staleDeleted": 0,
  "nodes": []
}
```

### `POST /nodes/:id/expire`

Expires a Headscale node.

Auth: user or `nodes:write`.

Permission:

- Admin users can expire any node.
- Non-admin users can expire their own nodes only.

Response:

```json
{
  "ok": true
}
```

### `DELETE /nodes/:id`

Deletes a node from Headscale and marks it deleted locally.

Auth: user or `nodes:write`.

Permission:

- Admin users can delete any node.
- Non-admin users can delete their own nodes only.

Response:

```json
{
  "ok": true
}
```

### `PATCH /nodes/:id/owner`

Changes local node ownership.

Auth: `nodes:write`.

Permission: admin user only.

Body:

```json
{
  "ownerUserId": "user_id"
}
```

Response: updated node.

## Shares

### `GET /shares`

Lists node shares.

Auth: user or `shares:read`.

Behavior:

- Admin users receive all shares.
- Non-admin users receive shares they created, shares targeting them, and shares targeting groups they belong to.

### `POST /nodes/:id/shares/users`

Shares a node with a user and applies the current Headscale policy.

Auth: user or `shares:write`.

Permission:

- Admin users can share any node.
- Non-admin users can share owned nodes only.

Body:

```json
{
  "targetUserId": "user_id",
  "allowExitNode": false,
  "expiresAt": "2026-05-19T00:00:00.000Z"
}
```

`expiresAt` is optional.

Response: created share.

### `POST /nodes/:id/shares/groups`

Shares a node with a group and applies the current Headscale policy.

Auth: user or `shares:write`.

Permission:

- Admin users can share any node.
- Non-admin users can share owned nodes only.

Body:

```json
{
  "targetGroupId": "group_id",
  "allowExitNode": false,
  "expiresAt": "2026-05-19T00:00:00.000Z"
}
```

`expiresAt` is optional.

Response: created share.

### `DELETE /shares/:id`

Revokes a share and applies the current Headscale policy.

Auth: user or `shares:write`.

Permission:

- Admin users can revoke any share.
- Non-admin users can revoke shares they created or shares for nodes they own.

Response:

```json
{
  "ok": true
}
```

## Groups

### `GET /groups`

Lists groups.

Auth: user or `groups:read`.

Behavior:

- Admin users receive all groups.
- Non-admin users receive groups they own.

### `POST /groups`

Creates a group owned by the authenticated user.

Auth: user or `groups:write`.

Body:

```json
{
  "name": "team-a"
}
```

Response: created group.

### `GET /groups/:id`

Returns one group with members.

Auth: user or `groups:read`.

Non-admin users can only read groups they own.

### `POST /groups/:id/members`

Adds a user to a group and applies the current Headscale policy.

Auth: user or `groups:write`.

Permission:

- Admin users can modify any group.
- Non-admin users can modify owned groups only.

Body:

```json
{
  "userId": "user_id"
}
```

Response: created group member.

### `DELETE /groups/:id/members/:userId`

Removes a user from a group and applies the current Headscale policy.

Auth: user or `groups:write`.

Permission:

- Admin users can modify any group.
- Non-admin users can modify owned groups only.

Response:

```json
{
  "ok": true
}
```

## Invites

### `POST /nodes/:id/invites`

Creates an invite link token for a node.

Auth: user or `invites:write`.

Permission:

- Admin users can create invites for any node.
- Non-admin users can create invites for owned nodes only.

Body:

```json
{
  "allowExitNode": false,
  "expiresInHours": 24,
  "maxUses": 1
}
```

Rules:

- `expiresInHours`: positive integer, max 720.
- `maxUses`: positive integer, max 100.

Response includes the raw invite token once:

```json
{
  "id": "invite_id",
  "token": "cfi_..."
}
```

### `GET /invites/:token`

Reads a public invite by raw token.

Auth: none.

Returns `404` if the invite is missing, revoked, expired, or fully used.

### `POST /invites/:token/accept`

Accepts an invite as the authenticated user, creates a node share, increments invite usage, and applies policy.

Auth: user or `shares:write`.

Response: created share.

### `DELETE /invites/:id`

Revokes an invite.

Auth: user or `invites:write`.

Permission:

- Admin users can revoke any invite.
- Non-admin users can revoke invites they created.

Response:

```json
{
  "ok": true
}
```

## Policy

### `GET /policy/preview`

Generates the current policy preview without applying it.

Auth: `policy:read`.

The generated policy includes:

- `hosts`: Headscale node names mapped to live Tailscale IPs.
- `groups`: one per active CovaFlux user.
- `acls`: node owner access and active share-based access.

### `POST /policy/apply`

Generates and applies the current policy to Headscale, then records a policy version.

Auth: `policy:write`.

Response: created `PolicyVersion`.

### `GET /policy/versions`

Lists policy versions, newest first.

Auth: `policy:read`.

### `GET /policy/versions/:id`

Returns one policy version.

Auth: `policy:read`.

### `POST /policy/versions/:id/rollback`

Applies a previous policy version and records a new policy version with `rollbackFromVersionId`.

Auth: `policy:write`.

Response: created rollback `PolicyVersion`.

## API Tokens

### `GET /api-tokens`

Lists API tokens.

Auth: `tokens:write`.

Behavior:

- Admin users receive all tokens.
- Non-admin users receive their own tokens.
- Raw token secrets are never returned after creation.

### `POST /api-tokens`

Creates a system API token.

Auth: `tokens:write`.

Body:

```json
{
  "name": "discord-bot",
  "scopes": ["nodes:read", "nodes:write"],
  "expiresAt": "2026-05-19T00:00:00.000Z"
}
```

`expiresAt` is optional.

Response includes the raw token once:

```json
{
  "id": "token_id",
  "name": "discord-bot",
  "token": "cft_..."
}
```

### `DELETE /api-tokens/:id`

Revokes an API token by setting `revokedAt`.

Auth: `tokens:write`.

Permission:

- Admin users can revoke any token.
- Non-admin users can revoke their own tokens.

Response:

```json
{
  "ok": true
}
```

## Audit Logs

### `GET /audit-logs`

Returns the latest 200 audit logs, newest first.

Auth: `policy:read`.

Response: array of audit log records.

## Operational Notes

### Headscale Policy Application

Policy updates do not require restarting Headscale when `policy.mode` is `database`. CovaFlux applies policies through the Headscale REST API.

### Tailscale Client Registration

For this development setup, use the Headscale login server on standard HTTP port 80:

```bash
sudo tailscale up --reset --login-server=http://<headscale-host> --auth-key=hskey-auth-...
```

Do not use the internal development API port `12147` as the client login server unless the client explicitly supports that setup.

### Node Visibility And ACL Testing

Tailscale ACLs are best validated with TCP/UDP service access tests, not only ICMP ping. ICMP behavior can be less strict as a directional ACL test.
