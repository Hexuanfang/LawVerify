#!/usr/bin/env sh
# 在服务器上管理系统管理员账号，例如：
#   ./admin.sh list
#   ./admin.sh set-password admin
#   echo '新密码' | ./admin.sh set-password admin --password-stdin
set -eu
cd "$(dirname "$0")"
if [ -t 0 ]; then tty_flag=""; else tty_flag="-T"; fi
exec docker compose exec $tty_flag cloud-server node dist/scripts/admin-account.js "$@"
