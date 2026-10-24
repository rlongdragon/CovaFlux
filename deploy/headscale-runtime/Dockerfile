FROM headscale/headscale:0.29.6@sha256:cabe84f0699913dbca9320f0883dca7565dd08df3c5be29edfabbebeff763966 AS headscale

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
# jq parses `headscale apikeys list -o json` for key rotation; su-exec drops
# root after volume ownership is fixed.
RUN apk add --no-cache jq su-exec \
  && addgroup -g 10001 secrets \
  && addgroup -g 10000 headscale \
  && adduser -D -H -u 10000 -G headscale headscale \
  && addgroup headscale secrets \
  && mkdir -p /var/lib/headscale /var/run/headscale /secrets
COPY --from=headscale /ko-app/headscale /usr/local/bin/headscale
COPY entrypoint.sh /usr/local/bin/headscale-entrypoint
RUN chmod 0755 /usr/local/bin/headscale-entrypoint
ENTRYPOINT ["/usr/local/bin/headscale-entrypoint"]
