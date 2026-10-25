# CovaFlux

[English](README.md) | [中文](README-zhtw.md)

CovaFlux is a lightweight management API and development web console for Headscale.

It supports both a mock Headscale client and a real Headscale REST API client. The development default is the mock client. When `HEADSCALE_CLIENT_MODE=rest` and `HEADSCALE_API_KEY` are configured, user management, pre-auth key creation, node synchronization, and policy application are performed against a real Headscale instance.

## Development

```bash
npm install
npm run prisma:generate
DATABASE_URL=file:$PWD/data/covaflux.dev.db npm -w @covaflux/api exec prisma migrate deploy
npm run dev:api:local
npm run dev:web:local
```

Connect to the Docker-managed local Headscale instance:

```bash
cp deploy/.env.example deploy/.env   # fill in the required values
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up -d headscale
HEADSCALE_CLIENT_MODE=rest \
HEADSCALE_API_KEY=$(docker compose -f deploy/docker-compose.yml exec -u headscale headscale cat /secrets/headscale_api_key) \
npm run dev:api:local
```

Development bootstrap admin (`npm run dev:api:local` only):

```text
username: admin
password: change-me-password
```

Production (`NODE_ENV=production`) refuses to start with this password, a published `JWT_SECRET`, or `CORS_ORIGINS=*`. An existing admin that still uses a published default password is switched to `BOOTSTRAP_ADMIN_PASSWORD` at startup.

## Exit Nodes

A node must first advertise `0.0.0.0/0` and/or `::/0` (for example with `tailscale up --advertise-exit-node`). A CovaFlux administrator can then approve or disable those default routes from the web console or through:

```text
POST /nodes/:id/exit-node/approve
POST /nodes/:id/exit-node/disable
```

Disabling exit-node access removes only the default routes and preserves other approved subnet routes. CovaFlux adds `autogroup:internet:*` ACL access only after the exit routes are approved; shared users or groups additionally require `allowExitNode` on the share.

## Docker Compose

```bash
cp deploy/.env.example deploy/.env   # set domains, JWT_SECRET, BOOTSTRAP_ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml up -d --build
```

Only Caddy is published (80/443). It obtains TLS certificates and serves:

- Web console and API (`/api`): `https://$COVAFLUX_DOMAIN`
- Headscale client login server: `https://$HEADSCALE_DOMAIN` (the Headscale management API, metrics and debug paths are not exposed)

The Headscale runtime creates the API key CovaFlux uses, stores it in the `covaflux-secrets` volume (readable only by the two services), and rotates it after `HEADSCALE_API_KEY_ROTATE_AFTER_DAYS`; the API re-reads the file automatically. All containers run with a read-only root filesystem, `no-new-privileges`, dropped capabilities and memory/PID limits; application processes run as non-root users.
