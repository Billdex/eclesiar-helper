#!/usr/bin/env bash
# 发布辅助：推送后刷新 jsDelivr 主源的缓存，并确认 @main 上读到的版本号已经是刚发布的版本。
#
# 只处理 jsDelivr（主源，公开 purge 接口、无需任何密钥），这是每次发布的必做项。
# JSDMirror 等镜像不再主动刷新：它们按自身的分支缓存自然过期就会追上，
# 作者不持有、也不需要使用任何镜像刷新密钥。
#
# 用法（在仓库任意位置执行均可）：
#   scripts/release.sh            # 校验版本 → 刷新缓存 → 等生效
#   scripts/release.sh --verify   # 只校验版本与主源当前状态，不发刷新请求
#   scripts/release.sh --no-wait  # 发完刷新请求就退出，不等生效
#
# 说明：本脚本只是发布工具，不属于安装产物，也不参与脚本运行时。

set -u

cd "$(dirname "$0")/.." || exit 1

PURGE_FILES="eclesiar-helper.meta.js eclesiar-helper.user.js"
CDN_BASE='https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main'
WAIT=1
PURGE=1

for arg in "$@"; do
  case "$arg" in
    --verify) PURGE=0 ;;
    --no-wait) WAIT=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
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
[ "$user_version" = "$meta_version" ] || fail "meta.js 的 @version 与主脚本不一致（$meta_version / $user_version）"
[ "$user_version" = "$readme_version" ] || fail "README 的当前版本与脚本不一致（$readme_version / $user_version）"

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
if [ -n "$branch" ] && [ "$branch" != 'main' ]; then
  warn "当前分支是 ${branch}，不是 main；发布前请确认该版本分支已合并并推送到 main。"
fi

if command -v node >/dev/null 2>&1; then
  node --check eclesiar-helper.user.js || fail 'eclesiar-helper.user.js 语法检查未通过'
  node --check eclesiar-helper.meta.js || fail 'eclesiar-helper.meta.js 语法检查未通过'
  info '   语法检查：通过'
else
  warn '未找到 node，跳过 node --check'
fi

# ------------------------------------------------------------------ 2. 刷新缓存
info ''
info '== 2/3 刷新 jsDelivr 主源缓存（镜像不主动刷新，等它自己过期）'

purge_failed=0

purge_jsdelivr() {
  target="$1"
  slash_path=${target#https://cdn.jsdelivr.net/}
  resp=$(curl -sS -m 30 "https://purge.jsdelivr.net/$slash_path" 2>&1)
  case "$resp" in
    *'"status": "finished"'*|*'"status":"finished"'*) info "   ok  $target" ;;
    *) purge_failed=1; warn "jsDelivr 刷新未确认：$target"; warn "   ${resp:0:160}" ;;
  esac
}

if [ "$PURGE" -eq 1 ]; then
  # jsDelivr 没有批量接口，逐个文件刷；两个文件缺一不可，
  # 只刷 .meta.js 会出现「提示有新版本、点安装下来还是旧的」。
  for file in $PURGE_FILES; do
    purge_jsdelivr "$CDN_BASE/$file"
  done
else
  info '   （--verify）跳过刷新请求'
fi

# -------------------------------------------------------------- 3. 确认已生效
info ''
info '== 3/3 确认 jsDelivr 上的 @main 已生效'

probe() {
  curl -sS -m 15 "$CDN_BASE/eclesiar-helper.meta.js?eh_t=$(date +%s)" 2>/dev/null \
    | grep -m1 '@version' | awk '{print $3}'
}

if [ "$WAIT" -eq 1 ]; then
  max=12
  attempt=1
  while : ; do
    got=$(probe)
    info "   第 $attempt/$max 次探测：$(printf '%-22s' 'cdn.jsdelivr.net') ${got:-<读取失败>}"
    if [ "$got" = "$user_version" ]; then
      info ''
      info "jsDelivr 已是 v${user_version}。镜像（JSDMirror / GitHub raw）会随自身缓存过期自动追上，不另行刷新。"
      exit 0
    fi
    [ "$attempt" -ge "$max" ] && break
    attempt=$((attempt + 1))
    sleep 15
  done
  warn "等了 $((max * 15)) 秒 jsDelivr 仍返回旧版本；中间层缓存可能还没过期，稍后重跑 scripts/release.sh --verify。"
  exit 1
else
  got=$(probe)
  info "   $(printf '%-22s' 'cdn.jsdelivr.net') ${got:-<读取失败>}"
  if [ "$got" = "$user_version" ] && [ "$purge_failed" -eq 0 ]; then
    info ''
    info "jsDelivr 已是 v${user_version}，缓存刷新成功。镜像不主动刷新。"
    exit 0
  fi
  warn "jsDelivr 尚未返回 v${user_version}，或刷新请求失败（--no-wait，未轮询等待）。"
  exit 1
fi
