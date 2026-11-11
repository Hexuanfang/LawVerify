#!/usr/bin/env bash
# 从本机把当前工作区的 web / cloud-server / deploy 推到服务器，并在服务器上构建、启动容器。
#   DEPLOY_HOST=user@host ./deploy/deploy.sh
# 可选：DEPLOY_DIR（默认 /opt/lawverify）、DEPLOY_SERVICES（默认全部，例如 "web"）
set -euo pipefail

host="${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 root@1.2.3.4 或 ssh config 中的别名}"
remote_dir="${DEPLOY_DIR:-/opt/lawverify}"
services="${DEPLOY_SERVICES:-}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$repo_root"
echo "== 打包 web / cloud-server / deploy =="
file_list="$(mktemp)"
trap 'rm -f "$file_list"' EXIT
git ls-files -co --exclude-standard -- web cloud-server deploy | while IFS= read -r file; do
  [ -e "$file" ] && printf '%s\n' "$file"
done > "$file_list"

echo "== 上传到 $host:$remote_dir =="
COPYFILE_DISABLE=1 tar -czf - -T "$file_list" | ssh "$host" "
  set -e
  mkdir -p '$remote_dir/deploy/releases'
  rm -rf '$remote_dir/.incoming' && mkdir -p '$remote_dir/.incoming'
  tar -xzf - -C '$remote_dir/.incoming'
  rm -rf '$remote_dir/web' '$remote_dir/cloud-server'
  mv '$remote_dir/.incoming/web' '$remote_dir/.incoming/cloud-server' '$remote_dir/'
  cp -R '$remote_dir/.incoming/deploy/.' '$remote_dir/deploy/'
  chmod +x '$remote_dir/deploy/'*.sh
  rm -rf '$remote_dir/.incoming'
"

echo "== 构建并启动 =="
ssh "$host" "
  set -e
  cd '$remote_dir/deploy'
  if [ ! -f .env ]; then echo '缺少 $remote_dir/deploy/.env，请参考 .env.example 创建后重试。' >&2; exit 1; fi
  docker compose build $services
  docker compose up -d $services
  docker compose ps
"
