#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：deploy.sh [--local | --host user@host] [服务 ...]
服务：web、cloud-server、postgres、all
cloud-server 会启动 PostgreSQL。无服务参数时部署 web 和 cloud-server。
SSH 模式也可通过 DEPLOY_HOST 指定主机，DEPLOY_DIR 默认为 /opt/lawverify。
EOF
}

host="${DEPLOY_HOST:-}"
mode=ssh
requested=()
while (( $# > 0 )); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --local) mode=local ;;
    --host)
      if (( $# < 2 )) || [[ -z "$2" || "$2" == -* ]]; then
        echo '--host 需要一个 SSH 主机地址。' >&2
        exit 2
      fi
      host="$2"
      mode=ssh
      shift
      ;;
    *) requested+=("$1") ;;
  esac
  shift
done

if (( ${#requested[@]} == 0 )); then
  read -r -a requested <<< "${DEPLOY_SERVICES:-web cloud-server}"
fi

selected=" "
for service in "${requested[@]}"; do
  case "$service" in
    all) selected+="web cloud-server " ;;
    web|cloud-server|postgres) selected+="$service " ;;
    *) printf '未知的部署服务：%s\n' "$service" >&2; exit 2 ;;
  esac
done

targets=()
if [[ "$selected" == *" cloud-server "* ]]; then
  targets+=(cloud-server)
elif [[ "$selected" == *" postgres "* ]]; then
  targets+=(postgres)
fi
if [[ "$selected" == *" web "* ]]; then targets+=(web); fi
if (( ${#targets[@]} == 0 )); then
  echo '请指定至少一个部署服务。' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
deploy_root="$repo_root/deploy"
target_deploy="$deploy_root"
if [[ "$mode" == ssh ]]; then
  : "${host:?请设置 DEPLOY_HOST、传入 --host，或使用 --local}"
  remote_dir="${DEPLOY_DIR:-/opt/lawverify}"
  if [[ "$remote_dir" != /* ]]; then
    echo 'DEPLOY_DIR 必须是服务器上的绝对路径。' >&2
    exit 2
  fi
  target_deploy="${remote_dir%/}/deploy"
fi
# SSH 调用的命令由目标 shell 解释，路径按 POSIX shell 规则引用。
target_deploy="'${target_deploy//\'/\'\\\'\'}'"

run_on_target() {
  if [[ "$mode" == local ]]; then
    sh -c "$1"
  else
    ssh -- "$host" "$1"
  fi
}

compose_on_target() {
  local target="$1" compose_file env_file legacy_env_files=""
  shift
  case "$target" in
    cloud-server|postgres)
      compose_file=cloud-server/compose.yml
      env_file=cloud-server/.env
      legacy_env_files=.env
      ;;
    web)
      compose_file=web/compose.yml
      env_file=web/.env
      legacy_env_files=.env
      ;;
  esac
  # 路径基准保留在 deploy，已有 releases 路径可直接使用。
  run_on_target "
    set -e
    cd $target_deploy
    for env_file in $env_file $legacy_env_files $env_file.example; do
      if [ -f \"\$env_file\" ]; then break; fi
    done
    CLOUD_SERVER_ENV_FILE=\"\$env_file\" COMPOSE_REMOVE_ORPHANS=false COMPOSE_IGNORE_ORPHANS=true \\
      docker compose --project-directory . --env-file \"\$env_file\" -f $compose_file $*
  "
}

upload_runtime_files() {
  local target
  local files=()
  for target in "${targets[@]}"; do
    case "$target" in
      web) files+=(deploy/web/compose.yml deploy/web/.env.example deploy/web/nginx-outer-vhost.conf.example deploy/issue-cert.sh) ;;
      cloud-server|postgres) files+=(deploy/cloud-server/compose.yml deploy/cloud-server/.env.example deploy/admin.sh) ;;
    esac
  done

  echo "== 上传运行配置到 $host =="
  COPYFILE_DISABLE=1 tar -czf - -C "$repo_root" "${files[@]}" | run_on_target "
    set -e
    mkdir -p $target_deploy
    cd $target_deploy/..
    staging=\$(mktemp -d .config.XXXXXXXX)
    trap 'rm -rf -- \"\$staging\"' EXIT
    tar -xzf - -C \"\$staging\"
    for file in ${files[*]}; do
      mkdir -p \"\$(dirname \"\$file\")\"
      case \"\$file\" in *.sh) chmod +x \"\$staging/\$file\" ;; esac
      mv -f -- \"\$staging/\$file\" \"\$file\"
    done
  "
}

build_image() {
  local target="$1" image="$2" env_file
  env_file="deploy/$target/.env.build"
  if [[ -n "${DEPLOY_BUILD_ENV_FILE:-}" ]]; then
    env_file="$DEPLOY_BUILD_ENV_FILE"
  elif [[ ! -f "$env_file" ]]; then
    if [[ -f deploy/.env.build ]]; then
      env_file=deploy/.env.build
    else
      env_file="deploy/$target/.env.build.example"
    fi
  fi

  echo "== 本地构建 $DEPLOY_PLATFORM 镜像：$image =="
  DEPLOY_BUILD_IMAGE="$image" \
    docker compose --project-directory "$deploy_root" --env-file "$env_file" \
      -f "deploy/$target/compose.build.yml" build "$target"
}

cd "$repo_root"
if [[ "$mode" == ssh ]]; then upload_runtime_files; fi

build_targets=()
images=()
for target in "${targets[@]}"; do
  config_images="$(compose_on_target "$target" config --images "$target")"
  case "$target" in
    web|cloud-server) image_name="lawverify-$target" ;;
    *) continue ;;
  esac
  if ! image="$(printf '%s\n' "$config_images" | grep "^$image_name:")"; then
    printf '目标配置中缺少镜像：%s\n' "$image_name" >&2
    exit 1
  fi
  build_targets+=("$target")
  images+=("$image")
done

if (( ${#images[@]} > 0 )); then
  DEPLOY_PLATFORM="$(run_on_target "docker version --format '{{.Server.Os}}/{{.Server.Arch}}'")"
  export DEPLOY_PLATFORM
  for index in "${!images[@]}"; do
    build_image "${build_targets[index]}" "${images[index]}"
  done
  if [[ "$mode" == ssh ]]; then
    echo '== 上传镜像 =='
    docker image save "${images[@]}" | run_on_target 'docker image load'
  fi
fi

for target in "${targets[@]}"; do
  echo "== 启动 $target =="
  compose_on_target "$target" up -d --no-build "$target"
  compose_on_target "$target" ps "$target"
done
