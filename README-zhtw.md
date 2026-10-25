# CovaFlux

[English](README.md) | [中文](README-zhtw.md)

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
cp deploy/.env.example deploy/.env   # 填入必要設定
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up -d headscale
HEADSCALE_CLIENT_MODE=rest \
HEADSCALE_API_KEY=$(docker compose -f deploy/docker-compose.yml exec -u headscale headscale cat /secrets/headscale_api_key) \
npm run dev:api:local
```

開發用 bootstrap admin（僅限 `npm run dev:api:local`）：

```text
username: admin
password: change-me-password
```

正式環境（`NODE_ENV=production`）若使用這組密碼、公開過的 `JWT_SECRET` 或 `CORS_ORIGINS=*` 會拒絕啟動；既有 admin 若仍是公開的預設密碼，啟動時會改成 `BOOTSTRAP_ADMIN_PASSWORD`。

## Exit Node

節點必須先宣告 `0.0.0.0/0` 和／或 `::/0`（例如執行 `tailscale up --advertise-exit-node`），再由 CovaFlux 管理員從 Web 管理介面核准或停用，亦可呼叫：

```text
POST /nodes/:id/exit-node/approve
POST /nodes/:id/exit-node/disable
```

停用 Exit Node 時只會移除 default routes，其他已核准的 subnet routes 會保留。CovaFlux 只會在 Exit Node routes 已核准後加入 `autogroup:internet:*` ACL；分享給使用者或群組時還必須設定 `allowExitNode`。

## Docker Compose

```bash
cp deploy/.env.example deploy/.env   # 設定網域、JWT_SECRET、BOOTSTRAP_ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml up -d --build
```

只有 Caddy 對外發布（80/443），負責申請 TLS 憑證並提供：

- Web 管理介面與 API（`/api`）：`https://$COVAFLUX_DOMAIN`
- Headscale client login server：`https://$HEADSCALE_DOMAIN`（不對外開放 Headscale 管理 API、metrics、debug 路徑）

Headscale runtime 會建立 CovaFlux 使用的 API key，存放在 `covaflux-secrets` volume（只有這兩個服務可讀），並在 `HEADSCALE_API_KEY_ROTATE_AFTER_DAYS` 後自動輪替；API 會自動重新讀取。所有容器皆為唯讀 root filesystem、`no-new-privileges`、移除 capabilities 並限制記憶體／PID；應用程式以非 root 使用者執行。
