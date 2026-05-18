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
docker compose -f deploy/docker-compose.yml up -d headscale
docker compose -f deploy/docker-compose.yml exec headscale headscale apikeys create --expiration 365d
HEADSCALE_CLIENT_MODE=rest HEADSCALE_API_KEY=<API_KEY> npm run dev:api:local
```

Default bootstrap admin:

```text
username: admin
password: change-me-password
```

## Docker Compose

```bash
docker compose -f deploy/docker-compose.yml up --build
```

The Docker Compose Headscale runtime automatically creates a Headscale API key and stores it in the `covaflux-secrets` volume. The API service reads it through `HEADSCALE_API_KEY_FILE`, so no manual token copy is required.

Services:

- Web: http://localhost:12146
- API: http://localhost:12145
- Headscale client login server: http://localhost
- Headscale development API: http://localhost:12147

## Documentation

The full planning document is in [docs/management-plan.md](docs/management-plan.md).

The development guide is in [docs/development.md](docs/development.md).
