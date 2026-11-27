#!/usr/bin/env bash
# 发布辅助：推送后刷新 jsDelivr 主源的缓存，并确认 @main 的元数据与脚本本体均为刚发布的版本。
#
# 只处理 jsDelivr（主源，公开 purge 接口、无需任何密钥），这是每次发布的必做项。
# JSDMirror 等镜像不再主动刷新：它们按自身的分支缓存自然过期就会追上，
# 作者不持有、也不需要使用任何镜像刷新密钥。
#
# 用法（在仓库任意位置执行均可）：
#   scripts/release.sh            # 校验版本 → 等 raw 生效 → 刷新缓存 → 等生效
#   scripts/release.sh --verify   # 只校验版本与主源当前状态，不发刷新请求
#   scripts/release.sh --no-wait  # 发完刷新请求就退出，不等生效
#
# 说明：本脚本只是发布工具，不属于安装产物，也不参与脚本运行时。

set -u

cd "$(dirname "$0")/.." || exit 1

PURGE_FILES="eclesiar-helper.meta.js eclesiar-helper.user.js"
CDN_BASE='https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main'
RAW_BASE='https://raw.githubusercontent.com/Billdex/eclesiar-helper/main'
WAIT=1
PURGE=1

# 等待参数：raw 自带 max-age=300，jsDelivr 的 purge 是回源到 raw 取内容，
# 刷早了会把旧内容重新写进边缘缓存（s-maxage=43200），因此先等 raw、再刷、再轮询。
RAW_MAX=8          # raw 等待：最多 8 次
RAW_INTERVAL=40    #          每次间隔 40 秒，覆盖 5 分钟的 raw 缓存
POLL_MAX=20        # CDN 轮询：最多 20 次
POLL_INTERVAL=30   #          每次间隔 30 秒
REPURGE_EVERY=3    # 轮询期间每 3 次（约 90 秒）重刷一次，防止上一次刷进了旧内容

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

# 读一个地址上的 @version；失败返回空串，由调用方决定怎么处理。
fetch_version() {
  curl -sS -m 15 "$1?eh_t=$(date +%s%N)" 2>/dev/null \
    | grep '@version' | awk 'NR == 1 { print $3 }'
}

# ---------------------------------------------------------------- 1. 版本一致性
info '== 1/4 版本号四处同步'
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

# ------------------------------------------------------------ 2. 等 GitHub raw
# purge 是回源到 raw 取内容：推送后 5 分钟内 raw 可能还是旧内容，此时刷 jsDelivr
# 会把旧文件重新写进边缘缓存（s-maxage=12 小时），只能再刷一次才生效。
# 所以先确认 raw 已经是新版本，再刷 CDN。
info ''
raw_ready=1
if [ "$PURGE" -eq 1 ] && [ "$WAIT" -eq 1 ]; then
  info "== 2/4 等待 GitHub raw 反映 v${user_version}（raw 自带 max-age=300）"
  attempt=1
  while : ; do
    raw_meta=$(fetch_version "$RAW_BASE/eclesiar-helper.meta.js")
    raw_user=$(fetch_version "$RAW_BASE/eclesiar-helper.user.js")
    info "   第 $attempt/$RAW_MAX 次：meta.js=${raw_meta:-<读取失败>} user.js=${raw_user:-<读取失败>}"
    if [ "$raw_meta" = "$user_version" ] && [ "$raw_user" = "$user_version" ]; then
      info '   raw 已是新版本，可以刷新 jsDelivr'
      break
    fi
    if [ "$attempt" -ge "$RAW_MAX" ]; then
      raw_ready=0
      warn '   raw 在等待窗口内仍未变成新版本（可能是本机访问 raw 不稳，或 GitHub 侧还在缓存）'
      warn '   仍继续刷新 jsDelivr，但这次刷新可能又写进旧内容，稍后会自动重刷'
      break
    fi
    attempt=$((attempt + 1))
    sleep "$RAW_INTERVAL"
  done
else
  info '== 2/4 跳过 raw 等待（--verify 或 --no-wait）'
fi

# ------------------------------------------------------------------ 3. 刷新缓存
info ''
info '== 3/4 刷新 jsDelivr 主源缓存（镜像不主动刷新，等它自己过期）'

purge_failed=0

purge_round() {
  purge_failed=0
  for file in $PURGE_FILES; do
    target="$CDN_BASE/$file"
    slash_path=${target#https://cdn.jsdelivr.net/}
    resp=$(curl -sS -m 30 "https://purge.jsdelivr.net/$slash_path" 2>&1)
    case "$resp" in
      *'"status": "finished"'*|*'"status":"finished"'*) info "   ok  $target" ;;
      *) purge_failed=1; warn "jsDelivr 刷新未确认：$target"; warn "   ${resp:0:160}" ;;
    esac
  done
}

if [ "$PURGE" -eq 1 ]; then
  # jsDelivr 没有批量接口，逐个文件刷；两个文件缺一不可，
  # 只刷 .meta.js 会出现「提示有新版本、点安装下来还是旧的」。
  purge_round
else
  info '   （--verify）跳过刷新请求'
fi

# -------------------------------------------------------------- 4. 确认已生效
info ''
info '== 4/4 确认 jsDelivr 上的 @main 元数据与脚本本体均已生效'

probe() {
  local file="$1"
  # 不用 grep -m1 提前关闭管道，避免下载较大的 user.js 时 curl 报写入失败。
  curl -sS -m 15 "$CDN_BASE/$file?eh_t=$(date +%s%N)" 2>/dev/null \
    | grep '@version' | awk 'NR == 1 { print $3 }'
}

probe_all() {
  got_meta=$(probe 'eclesiar-helper.meta.js')
  got_user=$(probe 'eclesiar-helper.user.js')
  info "   meta.js：${got_meta:-<读取失败>}"
  info "   user.js：${got_user:-<读取失败>}"
}

versions_ready() {
  [ "$got_meta" = "$user_version" ] && [ "$got_user" = "$user_version" ]
}

release_ready() {
  versions_ready && [ "$purge_failed" -eq 0 ]
}

report_failure() {
  warn "发布尚未完成：目标为 v${user_version}，meta.js=${got_meta:-<读取失败>}，user.js=${got_user:-<读取失败>}。"
  [ "$purge_failed" -eq 0 ] || warn '本次至少一个 jsDelivr 缓存刷新请求未确认成功。'
  [ "$raw_ready" -eq 1 ] || warn 'GitHub raw 在等待窗口内未确认到新版本，下一次刷新前可能仍会回源到旧内容。'
  warn '稍后重跑 scripts/release.sh 即可重新刷新并校验，不需要再次 git push。'
}

if [ "$WAIT" -eq 1 ]; then
  attempt=1
  while : ; do
    info "   第 $attempt/$POLL_MAX 次探测："
    probe_all
    if release_ready; then
      info ''
      info "jsDelivr 的 meta.js 与 user.js 均已是 v${user_version}。镜像（JSDMirror / GitHub raw）会随自身缓存过期自动追上，不另行刷新。"
      exit 0
    fi
    [ "$attempt" -ge "$POLL_MAX" ] && break
    # purge 可能回源到还没更新的 raw，把旧内容重新固化进边缘缓存；
    # 这种情况下单次刷新永远等不到结果，必须周期性重刷。
    if [ "$PURGE" -eq 1 ] && [ "$raw_ready" -eq 1 ] && [ $((attempt % REPURGE_EVERY)) -eq 0 ]; then
      info '   仍是旧版本，重新刷新一次 jsDelivr 缓存'
      purge_round
    fi
    attempt=$((attempt + 1))
    sleep "$POLL_INTERVAL"
  done
  warn '轮询结束，jsDelivr 仍未全部生效；中间层缓存可能还没过期。'
  report_failure
  exit 1
else
  probe_all
  if release_ready; then
    info ''
    info "jsDelivr 的 meta.js 与 user.js 均已是 v${user_version}，缓存刷新成功。镜像不主动刷新。"
    exit 0
  fi
  report_failure
  exit 1
fi
