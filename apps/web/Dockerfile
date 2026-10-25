ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @covaflux/web
COPY tsconfig.base.json ./
COPY apps/web apps/web
# Same-origin by default (Caddy routes /api to the API).
ARG VITE_API_BASE_URL=/api
ARG VITE_HEADSCALE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_HEADSCALE_URL=$VITE_HEADSCALE_URL
RUN npm run build -w @covaflux/web

FROM ${NGINX_IMAGE} AS runner
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
