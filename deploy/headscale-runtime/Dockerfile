FROM headscale/headscale:latest AS headscale

FROM alpine:3.22
COPY --from=headscale /ko-app/headscale /usr/local/bin/headscale
COPY entrypoint.sh /usr/local/bin/headscale-entrypoint
RUN chmod +x /usr/local/bin/headscale-entrypoint
ENTRYPOINT ["/usr/local/bin/headscale-entrypoint"]
