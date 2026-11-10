# The backup service (2P-OPS10, #216): pg_dump 17 (the database's major version), age (encryption),
# rclone (optional remote copy) and curl (the Healthchecks ping).
FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
RUN apk add --no-cache bash postgresql17-client age rclone curl ca-certificates
COPY deploy/selfhost/backup/backup.sh /usr/local/bin/backup.sh
RUN chmod 755 /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["schedule"]
