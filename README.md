# CovaFlux

CovaFlux 是 Headscale 的輕量管理 API 與開發測試前台。

系統支援 mock client 與 Headscale REST API client。開發時預設使用 mock；設定 `HEADSCALE_CLIENT_MODE=rest` 與 `HEADSCALE_API_KEY` 後，使用者、pre-auth key、節點同步與 policy apply 會打到真正的 Headscale。

## 開發

```bash
npm install
npm run prisma:generate
DATABASE_URL=file:$PWD/data/covaflux.dev.db npm -w @covaflux/api exec prisma migrate deploy
npm run dev:api:local
npm run dev:web:local
```

串接本機 Docker Headscale：

```bash
docker compose -f deploy/docker-compose.yml up -d headscale
docker compose -f deploy/docker-compose.yml exec headscale headscale apikeys create --expiration 365d
HEADSCALE_CLIENT_MODE=rest HEADSCALE_API_KEY=<API_KEY> npm run dev:api:local
```

預設 bootstrap admin：

```text
username: admin
password: change-me-password
```

## Docker Compose

```bash
docker compose -f deploy/docker-compose.yml up --build
```

Docker Compose 的 Headscale runtime 會自動建立 Headscale API key，並寫入 `covaflux-secrets` volume；API 服務會從 `HEADSCALE_API_KEY_FILE` 讀取，不需要手動 copy token。

服務：

- Web: http://localhost:12146
- API: http://localhost:12145
- Headscale client login server: http://localhost
- Headscale development API: http://localhost:12147

## 文件

完整規劃在 [docs/management-plan.md](docs/management-plan.md)。

開發手冊在 [docs/development.md](docs/development.md)。
