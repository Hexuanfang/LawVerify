#!/usr/bin/env sh
# 用 certbot 容器以 webroot 方式签发 / 续期证书，复制到外层 nginx 的证书目录并重载。
# 适用于 80/443 由宿主机上另一个 nginx 统一接入、LawVerify 只监听 WEB_PORT 的情况。
#   DOMAIN=lawverify.example.com ACME_WEBROOT=/path/to/certbot-www CERT_DIR=/path/to/certs \
#   NGINX_CONTAINER=outer-nginx ./issue-cert.sh
# 证书未到续期时间时 certbot 不会重新签发，适合放进每周的 cron。
set -eu
domain="${DOMAIN:?请设置 DOMAIN}"
webroot="${ACME_WEBROOT:?请设置 ACME_WEBROOT（外层 nginx 的 /.well-known/acme-challenge/ 对应的宿主机目录）}"
cert_dir="${CERT_DIR:?请设置 CERT_DIR（外层 nginx 挂载的证书目录）}"
state_dir="${LETSENCRYPT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/letsencrypt}"

mkdir -p "$state_dir"
docker run --rm \
  -v "$state_dir:/etc/letsencrypt" \
  -v "$webroot:/var/www/certbot" \
  certbot/certbot:v3.1.0 certonly --webroot -w /var/www/certbot -d "$domain" \
  --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring

install -m 600 "$state_dir/live/$domain/fullchain.pem" "$cert_dir/$domain.pem"
install -m 600 "$state_dir/live/$domain/privkey.pem" "$cert_dir/$domain.key"

if [ -n "${NGINX_CONTAINER:-}" ]; then
  docker exec "$NGINX_CONTAINER" nginx -t
  docker exec "$NGINX_CONTAINER" nginx -s reload
fi
echo "证书已更新：$cert_dir/$domain.pem"
