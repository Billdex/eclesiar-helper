#!/usr/bin/env bash
# 发布辅助：推送后刷新三个 CDN 源（JSDMirror 主 / JSDMirror 备用域名 / jsDelivr），
# 并确认 @main 上读到的版本号已经是刚发布的版本。
#
# 用法（在仓库任意位置执行均可）：
#   scripts/release.sh            # 校验版本 → 刷新缓存 → 等生效
#   scripts/release.sh --verify   # 只校验版本与三源当前状态，不发刷新请求
#   scripts/release.sh --no-wait   # 发完刷新请求就退出，不等生效
#
# 密钥读取规则（见 AGENTS.md §9）：
#   - 文件：仓库根目录 `.jsdmirror-key`（已在 .gitignore 里）
#   - 内容：第一行非空、且不以 # 开头的文本即为 API Key；首尾空白与 \r 会被去掉
#   - 文件缺失或为空：跳过 JSDMirror 的两次刷新，只刷 jsDelivr，并给出提示
#   - 任何输出都不打印 Key 本身，最多打印前 6 位掩码
#
# 说明：本脚本只是发布工具，不属于安装产物，也不参与脚本运行时。

set -u

cd "$(dirname "$0")/.." || exit 1

VERSION_FILE_KEY='.jsdmirror-key'
PURGE_API='https://cache.jsdmirror.com/api/v1/purge'
MIRRORS="cdn.jsdmirror.com cdn.jsdelivr.net cdn.jsdmirror.cn"
FILES="eclesiar-helper.meta.js eclesiar-helper.user.js"
WAIT=1
PURGE=1

for arg in "$@"; do
  case "$arg" in
    --verify) PURGE=0 ;;
    --no-wait) WAIT=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

info() { printf '%s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
fail() { printf 'X %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. 版本一致性
info '== 1/3 版本号四处同步'
user_version=$(grep -m1 '^// @version' eclesiar-helper.user.js | awk '{print $3}')
meta_version=$(grep -m1 '^// @version' eclesiar-helper.meta.js | awk '{print $3}')
const_version=$(grep -m1 "const VERSION = '" eclesiar-helper.user.js | sed -E "s/.*'([^']+)'.*/\1/")
readme_version=$(grep -m1 '当前版本 \*\*v' README.md | sed -E 's/.*当前版本 \*\*v([0-9A-Za-z._-]+)\*\*.*/\1/')

info "   user.js @version : ${user_version:-<缺失>}"
info "   user.js const    : ${const_version:-<缺失>}"
info "   meta.js @version : ${meta_version:-<缺失>}"
info "   README 当前版本  : ${readme_version:-<缺失>}"

[ -n "$user_version" ] || fail '读不到 user.js 的 @version'
[ "$user_version" = "$const_version" ] || fail "user.js 里 @version 与 const VERSION 不一致（$user_version / ${const_version}）"
[ "$user_version" = "$meta_version" ] || fail "meta.js 的 @version 与主脚本不一致（$meta_version / ${user_version}）"
[ "$user_version" = "$readme_version" ] || fail "README 的当前版本与脚本不一致（$readme_version / ${user_version}）"

if command -v node >/dev/null 2>&1; then
  node --check eclesiar-helper.user.js || fail 'eclesiar-helper.user.js 语法检查未通过'
  node --check eclesiar-helper.meta.js || fail 'eclesiar-helper.meta.js 语法检查未通过'
  info '   语法检查：通过'
else
  warn '未找到 node，跳过 node --check'
fi

# ------------------------------------------------------------------ 2. 刷新缓存
info ''
info '== 2/3 刷新三个源的缓存'

read_key() {
  [ -f "$VERSION_FILE_KEY" ] || return 0
  sed -e 's/\r$//' "$VERSION_FILE_KEY" \
    | grep -v '^[[:space:]]*#' \
    | grep -v '^[[:space:]]*$' \
    | head -n 1 \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

purge_jsdmirror() {
  target="$1"
  payload=$(printf '{"url":"%s","method":"invalidate"}' "$target")
  if [ -n "${JSD_PROVIDER:-}" ]; then
    payload=$(printf '{"url":"%s","method":"invalidate","provider":"%s"}' "$target" "$JSD_PROVIDER")
  fi
  resp=$(curl -sS -m 30 -X POST "$PURGE_API" \
    -H 'Content-Type: application/json' \
    -H "X-API-Key: $key" \
    -d "$payload" -w '|%{http_code}' 2>&1)
  code=${resp##*|}
  body=${resp%|*}
  case "$code" in
    200|201|202) info "   ok  $target"; info "       ${body:0:160}" ;;
    *) purge_failed=1; warn "JSDMirror 刷新失败（HTTP ${code}）$target"; warn "   ${body:0:160}" ;;
  esac
}

purge_jsdelivr() {
  target="$1"
  slash_path=${target#https://cdn.jsdelivr.net/}
  resp=$(curl -sS -m 30 "https://purge.jsdelivr.net/$slash_path" 2>&1)
  case "$resp" in
    *'"status": "finished"'*|*'"status":"finished"'*) info "   ok  $target" ;;
    *) purge_failed=1; warn "jsDelivr 刷新未确认：$target"; warn "   ${resp:0:160}" ;;
  esac
}

purge_failed=0
if [ "$PURGE" -eq 1 ]; then
  key=$(read_key)
  if [ -n "$key" ]; then
    info "   JSDMirror Key：${key:0:6}…（来自 ${VERSION_FILE_KEY}）"
  else
    purge_failed=1
    warn "没读到 ${VERSION_FILE_KEY}（或内容为空），本次跳过 JSDMirror 的两个域名"
    warn '格式：第一行非空、且不以 # 开头的文本即 Key，例如 eclesiar_xxx'
  fi

  for file in $FILES; do
    for host in $MIRRORS; do
      target="https://$host/gh/Billdex/eclesiar-helper@main/$file"
      case "$host" in
        cdn.jsdelivr.net) purge_jsdelivr "$target" ;;
        *) [ -n "$key" ] && purge_jsdmirror "$target" ;;
      esac
    done
  done
else
  info '   （--verify）跳过刷新请求'
fi

# -------------------------------------------------------------- 3. 确认已生效
info ''
info '== 3/3 确认 @main 已生效'

probe() {
  curl -sS -m 15 "https://$1/gh/Billdex/eclesiar-helper@main/eclesiar-helper.meta.js" 2>/dev/null \
    | grep -m1 '@version' | awk '{print $3}'
}

all_fresh() {
  stale=0
  for host in $MIRRORS; do
    got=$(probe "$host")
    printf '   %-22s %s\n' "$host" "${got:-<读取失败>}"
    [ "$got" = "$user_version" ] || stale=1
  done
  return $stale
}

attempt=1
if [ "$WAIT" -eq 1 ]; then
  max=12
  while : ; do
    info "   第 $attempt/$max 次探测："
    if all_fresh; then
      info ''
      info "全部源已是 v${user_version}。"
      exit 0
    fi
    [ "$attempt" -ge "$max" ] && break
    attempt=$((attempt + 1))
    sleep 15
  done
  warn "等了 $((max * 15)) 秒仍有源返回旧版本；中间层缓存可能还没过期，稍后重跑 scripts/release.sh --verify。"
  exit 1
else
  if all_fresh && [ "$purge_failed" -eq 0 ]; then
    info ''
    info "三源均已是 v${user_version}，缓存刷新全部成功。"
    exit 0
  fi
  warn "仍有源不是 v${user_version}，或存在刷新失败的源（--no-wait，未轮询等待）。"
  exit 1
fi
