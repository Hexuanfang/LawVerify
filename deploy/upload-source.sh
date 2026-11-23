#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：bash deploy/upload-source.sh --host user@host --dir /path/to/project [--port 22] [--identity /path/to/key] [--rebuild | --no-rebuild]
将 cloud-server/ 和 web/ 上传到服务器目标目录，覆盖同路径文件，不删除远端额外文件。
cloud-server 排除顶层 .env.local、.data、dist、node_modules，web 排除顶层 dist、node_modules。
--rebuild    上传成功后在目标目录的 deploy/ 子目录执行 docker compose up -d --build（默认）。
--no-rebuild 仅上传源码。
EOF
}

host=""
remote_dir=""
rebuild=true
ssh_options=()
while (( $# > 0 )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --rebuild) rebuild=true; shift ;;
    --no-rebuild) rebuild=false; shift ;;
    --host|--dir|--port|--identity)
      if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
        printf '%s 缺少参数。\n' "$1" >&2
        exit 2
      fi
      case "$1" in
        --host) host="$2" ;;
        --dir) remote_dir="$2" ;;
        --port)
          if ! [[ "$2" =~ ^[1-9][0-9]{0,4}$ ]] || (( $2 > 65535 )); then
            echo 'SSH 端口必须在 1 到 65535 之间。' >&2
            exit 2
          fi
          ssh_options+=(-p "$2")
          ;;
        --identity) ssh_options+=(-i "$2") ;;
      esac
      shift 2
      ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$host" || "$host" == *[[:space:]]* || "$remote_dir" != /* ]]; then
  echo '请指定 SSH 主机和服务器上的绝对路径。' >&2
  usage >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
if [[ ! -d "$repo_root/cloud-server" || ! -d "$repo_root/web" ]]; then
  echo '项目根目录必须包含 cloud-server 和 web。' >&2
  exit 1
fi

# 打包成功后才开始传输，避免源文件读取失败时覆盖远端文件。
mkdir -p -- "$repo_root/tmp"
archive="$(mktemp "$repo_root/tmp/.lawverify-source.XXXXXXXX")"
trap 'rm -f -- "$archive"' EXIT
(
  cd "$repo_root"
  shopt -s dotglob nullglob
  paths=()
  for entry in cloud-server/* web/*; do
    case "$entry" in
      cloud-server/.env.local|cloud-server/.data|cloud-server/dist|cloud-server/node_modules|web/dist|web/node_modules) continue ;;
    esac
    paths+=("$entry")
  done
  COPYFILE_DISABLE=1 tar -czf "$archive" -T /dev/null -- "${paths[@]}"
)

# SSH 将命令交给远端 shell，按 POSIX 规则引用目标路径。
quoted_dir="'${remote_dir//\'/\'\\\'\'}'"
ssh -T "${ssh_options[@]}" -- "$host" "
  set -eu
  mkdir -p -- $quoted_dir
  cd $quoted_dir
  incoming=\$(mktemp .lawverify-source.XXXXXXXX)
  trap 'rm -f -- \"\$incoming\"' 0
  cat > \"\$incoming\"
  gzip -t \"\$incoming\"
  if [ -L cloud-server ] || [ -L web ]; then
    echo '远端 cloud-server 或 web 指向符号链接，请改用实际目录。' >&2
    exit 1
  fi
  mkdir -p -- cloud-server web
  tar -xzf \"\$incoming\" --no-same-owner
  if [ '$rebuild' = true ]; then
    echo '源码已上传，开始重建远端容器。'
    (cd deploy && docker compose up -d --build)
  fi
" < "$archive"

result_suffix=""
if [[ "$rebuild" == true ]]; then
  result_suffix='，并完成容器重建'
fi
printf '已上传 cloud-server 和 web 到 %s:%s%s。\n' "$host" "$remote_dir" "$result_suffix"
