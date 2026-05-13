# CovaFlux

CovaFlux 是 Headscale 的輕量管理 API 與開發測試前台。

目前第一版先使用 mock Headscale client，讓使用者、節點、分享、群組、policy version、API token 與 audit log 流程可以先跑起來。真正的 Headscale API/gRPC client 會在 Docker 測試環境確認細節後接上。

## 開發

```bash
npm install
npm run prisma:generate
DATABASE_URL=file:$PWD/data/covaflux.dev.db npm -w @covaflux/api exec prisma migrate deploy
npm run dev:api:local
npm run dev:web:local
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

服務：

- Web: http://localhost:5173
- API: http://localhost:3000
- Headscale: http://localhost:8080

## 文件

完整規劃在 [docs/management-plan.md](docs/management-plan.md)。

開發手冊在 [docs/development.md](docs/development.md)。
