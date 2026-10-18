#!/bin/sh
# FreeLLMAPI 纯离线试验：不读取或导入任何用户模型 API Key。
# 启动后只有本机 127.0.0.1:3001 可访问，容器无外网，不做模型推理。
set -eu
umask 077

DOCKER="/usr/local/bin/docker"
NAME="ai-team-freellmapi-lab"
NET="ai-team-freellmapi-offline"
IMAGE="ghcr.io/tashfeenahmed/freellmapi:latest"
LAB_DIR="/tmp/ai-team-freellmapi-lab"
ENV_FILE="$LAB_DIR/docker-env"
ACTION="status"
if [ "$#" -ge 1 ]; then ACTION="$1"; fi

status() {
  "$DOCKER" ps -a --filter "name=^/$NAME$" \
    --format 'name={{.Names}} status={{.Status}} ports={{.Ports}}'
}

case "$ACTION" in
  status)
    status
    ;;
  start)
    # 禁止现有工作负载的端口或已有同名实例被覆盖。
    if "$DOCKER" container inspect "$NAME" >/dev/null 2>&1; then
      echo "lab_already_exists: do_not_replace"
      exit 2
    fi
    if ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "official_image_not_present: pull_from_verified_repository_first"
      exit 2
    fi
    PLATFORM="$("$DOCKER" image inspect "$IMAGE" --format '{{.Architecture}}')"
    if [ "$PLATFORM" != arm64 ]; then
      echo "incorrect_docker_architecture"
      exit 2
    fi
    if ! "$DOCKER" network inspect "$NET" >/dev/null 2>&1; then
      "$DOCKER" network create --driver bridge --internal \
        --label 'ai.team.purpose=freellmapi-isolated-evaluation' "$NET" >/dev/null
    fi
    INTERNAL="$("$DOCKER" network inspect "$NET" --format '{{.Internal}}')"
    if [ "$INTERNAL" != true ]; then
      echo "network_not_internal: refusing"
      exit 2
    fi
    /bin/mkdir -p "$LAB_DIR"
    /bin/chmod 700 "$LAB_DIR"
    if [ ! -f "$ENV_FILE" ]; then
      SECRET="$(/usr/bin/openssl rand -hex 32)"
      {
        echo "NODE_ENV=production"
        echo "PORT=3001"
        echo "HOST=0.0.0.0"
        echo "ENCRYPTION_KEY=$SECRET"
        echo "FREELLMAPI_UPDATE_CHECK=0"
      } > "$ENV_FILE"
      /bin/chmod 600 "$ENV_FILE"
      unset SECRET
    fi
    # 使用镜像 sha256 id，而不是 mutable :latest；绝不自动拉取镜像。
    IMAGE_ID="$("$DOCKER" image inspect "$IMAGE" --format '{{.Id}}')"
    "$DOCKER" run --detach --pull never \
      --name "$NAME" \
      --label 'ai.team.purpose=freellmapi-isolated-evaluation' \
      --user 1000:1000 \
      --network "$NET" \
      --publish 127.0.0.1:3001:3001 \
      --restart no \
      --read-only \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --pids-limit 128 \
      --memory 768m \
      --cpus 1.25 \
      --tmpfs /app/server/data:rw,nosuid,nodev,uid=1000,gid=1000,mode=700,size=128m \
      --tmpfs /tmp:rw,nosuid,nodev,size=64m \
      --log-opt max-size=1m \
      --log-opt max-file=2 \
      --env-file "$ENV_FILE" \
      "$IMAGE_ID" >/dev/null
    echo "isolated_lab_started: provider_credentials=0 model_calls=0"
    status
    ;;
  stop)
    "$DOCKER" stop "$NAME" >/dev/null
    "$DOCKER" rm "$NAME" >/dev/null
    echo "lab_stopped_and_removed_ephemeral_data_lost"
    ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
