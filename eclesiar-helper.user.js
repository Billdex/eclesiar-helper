// ==UserScript==
// @name         Eclesiar 助手
// @name:en      Eclesiar Helper
// @namespace    https://github.com/Billdex/eclesiar-helper
// @version      0.2.6
// @description  Eclesiar 经济 / 政治计算辅助插件：悬浮球面板 + 全球汇率总览 + 各国市场商品金价比价与销售税后收益估算 + 各国地区工业数据与税负 / 最低工资总览 + 各国招工信息按税后薪资金价排序，商品市场列表与上架表单直接标注折算金价，并可一键跳转游戏对应页面。
// @description:en Eclesiar helper: floating panel + exchange rates + cross-market goods pricing and after-tax sale revenue in gold + sortable overviews of every region's industry data and every country's taxes and minimum wage + job listings ranked by after-tax pay in gold, plus one-click jumps to the matching game pages.
// @author       billdex
// @match        https://app.eclesiar.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// @homepageURL  https://github.com/Billdex/eclesiar-helper
// @supportURL   https://github.com/Billdex/eclesiar-helper/issues
// @source       https://github.com/Billdex/eclesiar-helper
// @updateURL    https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.meta.js
// @downloadURL  https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/eclesiar-helper.user.js
// ==/UserScript==

/**
 * Eclesiar 助手 · 基础框架
 * ---------------------------------------------------------------------------
 * 目标：给游戏页面加一个互不干扰的常驻入口（悬浮球 + 面板），
 *      后续的计算器、行情、政治等模块以「功能（feature）」形式注册即可接入。
 *
 * 结构：
 *   1. 外壳 —— Shadow DOM 隔离样式，宿主挂在 document.body 上（0×0，不挡页面）
 *   2. 悬浮球 —— 可拖拽、位置记忆、点击开合面板
 *   3. 面板 —— 标签页容器 + 内置「汇率 / 市场 / 工商（工业）/ 设置」
 *   4. 功能注册表 —— window.EclesiarHelper.features.register({ ... })
 *   5. SPA 路由钩子 —— 包装 history.pushState / replaceState，供功能订阅
 *
 * 设计约束：
 *   - 不引入任何外部依赖，单文件即可安装
 *   - 不主动请求游戏接口，只做界面容器与本地计算（后续功能再按需扩展）
 *   - 所有监听器、定时器都登记在册，destroy() 可完整回收
 */
(function () {
  'use strict';

  /* =========================================================================
   * 1. 常量与工具
   * ========================================================================= */

  const VERSION = '0.2.6';
  const REPO_URL = 'https://github.com/Billdex/eclesiar-helper';
  /** 主源：jsDelivr 官方。自动更新与「安装更新」都以它为准，不接受任何第三方密钥。 */
  const CDN_RAW = 'https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/';
  /**
   * 备源一：JSDMirror（与 jsDelivr 路径完全兼容的国内镜像，腾讯 EdgeOne 多线节点）。
   * jsDelivr 在国内被限速 / 拦截时走它，设置页与版本检查都留了入口。
   */
  const MIRROR_RAW = 'https://cdn.jsdmirror.com/gh/Billdex/eclesiar-helper@main/';
  /** 备源二：JSDMirror 的备用域名（阿里 ESA），主域名解析异常时顶上。 */
  const MIRROR_CN_RAW = 'https://cdn.jsdmirror.cn/gh/Billdex/eclesiar-helper@main/';
  /** GitHub raw 在国内常被拦，只作为最后备用。 */
  const REPO_RAW = 'https://raw.githubusercontent.com/Billdex/eclesiar-helper/main/';
  /**
   * 版本号只从元数据文件读，检查更新时不需要下载整个脚本。
   * 几个源并行请求、取其中最高的版本号：某个源缓存落后（分支缓存最长 12 小时）也不会漏更新。
   */
  const UPDATE_META_URLS = [
    CDN_RAW + 'eclesiar-helper.meta.js',
    MIRROR_RAW + 'eclesiar-helper.meta.js',
    MIRROR_CN_RAW + 'eclesiar-helper.meta.js',
    REPO_RAW + 'eclesiar-helper.meta.js'
  ];
  const UPDATE_INSTALL_URL = CDN_RAW + 'eclesiar-helper.user.js';
  const UPDATE_INSTALL_MIRROR = MIRROR_RAW + 'eclesiar-helper.user.js';
  const UPDATE_INSTALL_FALLBACK = REPO_RAW + 'eclesiar-helper.user.js';
  const NS = 'eclesiar-helper';
  const ROOT_ID = NS + '-root';
  const Z_INDEX = '2147483000';
  const BALL_SIZE = 54;
  const EDGE = 8;
  const DEFAULT_BALL = { rx: 1, ry: 0.78 };
  /**
   * 调试开关：地址上带 eh-debug=1 打开后记进 sessionStorage，
   * 这样 SPA 跳转丢掉 query、或者退回整页刷新后仍然继续打印日志。
   */
  const DEBUG = (() => {
    try {
      if (/[?&]eh-debug=1(?:&|$)/.test(location.search)) {
        sessionStorage.setItem('eh:debug', '1');
        return true;
      }
      return sessionStorage.getItem('eh:debug') === '1';
    } catch (err) {
      return /[?&]eh-debug=1(?:&|$)/.test(location.search);
    }
  })();

  if (window.EclesiarHelper) {
    console.warn('[Eclesiar Helper] 已检测到已加载的实例，跳过重复注入。');
    return;
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const log = (...args) => {
    if (DEBUG) console.log('%c[Eclesiar Helper]', 'color:#c9a54a;font-weight:600', ...args);
  };

  const warn = (...args) => console.warn('[Eclesiar Helper]', ...args);

  const storage = {
    read(key, fallback) {
      try {
        const raw = localStorage.getItem(NS + ':' + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(NS + ':' + key, JSON.stringify(value));
      } catch (err) {
        /* 隐私模式 / 存储已满：静默降级为不记忆 */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(NS + ':' + key);
      } catch (err) {
        /* ignore */
      }
    },
    clear() {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key && key.indexOf(NS + ':') === 0) keys.push(key);
        }
        keys.forEach((key) => localStorage.removeItem(key));
      } catch (err) {
        /* ignore */
      }
    }
  };

  /* =========================================================================
   * 2. 状态
   * ========================================================================= */

  const state = {
    open: false,
    ball: { ...DEFAULT_BALL },
    panelPinned: false,
    panelPos: null,
    activeTab: null
  };

  const dom = {};
  const features = new Map();
  const disposers = [];

  let hostObserver = null;
  let viewportObserver = null;
  let statusTimer = 0;
  let suppressClickTimer = 0;
  let resizeFollowUp = 0;
  let lastViewportW = 0;
  let lastViewportH = 0;
  let panelHeightCache = 0;
  let fallbackStyles = false;
  let booted = false;
  let destroyed = false;

  const tabButtons = new Map();

  /* =========================================================================
   * 3. 样式（Shadow DOM 内，避免与游戏样式互相污染）
   * ========================================================================= */

  const STYLES = `
  :host {
    --eh-ivory: #f4eddd;
    --eh-muted: #9fadc2;
    --eh-dim: #74839a;
    --eh-navy: #16253b;
    --eh-navy-deep: #0c1626;
    --eh-brass: #c9a54a;
    --eh-brass-bright: #e8cd8f;
    --eh-brass-soft: rgba(201, 165, 74, .16);
    --eh-brass-line: rgba(201, 165, 74, .28);
    --eh-line: rgba(255, 255, 255, .08);
    --eh-font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    --eh-serif: Georgia, "Times New Roman", "Songti SC", "Noto Serif SC", serif;
    --eh-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }

  /* ---------- 黄金图标（代替「金」字，放在数字前面） ---------- */

  .eh-gold-ico {
    width: 14px;
    height: 14px;
    display: inline-block;
    object-fit: contain;
    vertical-align: -3px;
    margin-right: 2px;
  }

  .eh-gold-ico--sm {
    width: 13px;
    height: 13px;
    vertical-align: -2px;
    margin-right: 1px;
  }

  .eh-gold-ico--lg {
    width: 16px;
    height: 16px;
    vertical-align: -3px;
  }

  /* ---------- 悬浮球 ---------- */

  .eh-ball {
    position: fixed;
    left: 0;
    top: 0;
    width: 54px;
    height: 54px;
    margin: 0;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid rgba(232, 205, 143, .5);
    border-radius: 50%;
    background: radial-gradient(circle at 30% 24%, #2b4165 0%, #1a2b45 45%, #0d1929 100%);
    color: #ecd79f;
    box-shadow:
      0 12px 26px -8px rgba(0, 0, 0, .75),
      0 0 0 1px rgba(0, 0, 0, .4),
      inset 0 1px 1px rgba(255, 255, 255, .16);
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
    font-family: var(--eh-font);
    transition: box-shadow .22s ease, transform .18s ease, border-color .22s ease;
    z-index: 2;
  }

  .eh-ball:hover {
    transform: scale(1.05);
    border-color: rgba(232, 205, 143, .8);
    box-shadow:
      0 14px 30px -8px rgba(0, 0, 0, .8),
      0 0 18px -2px rgba(201, 165, 74, .45),
      inset 0 1px 1px rgba(255, 255, 255, .2);
  }

  .eh-ball:active,
  .eh-ball.is-dragging {
    cursor: grabbing;
    transform: scale(.97);
  }

  .eh-ball.is-open {
    border-color: rgba(232, 205, 143, .9);
    box-shadow:
      0 14px 30px -8px rgba(0, 0, 0, .8),
      0 0 22px -2px rgba(201, 165, 74, .55),
      inset 0 1px 1px rgba(255, 255, 255, .2);
  }

  .eh-ball::after {
    content: "";
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    border: 1px solid rgba(201, 165, 74, .3);
    pointer-events: none;
  }

  .eh-ball__glow {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 18%, rgba(255, 255, 255, .22), transparent 55%);
    pointer-events: none;
  }

  .eh-ball__mark {
    position: relative;
    font-family: var(--eh-serif);
    font-size: 25px;
    line-height: 1;
    color: #f0dcaa;
    text-shadow: 0 1px 0 rgba(0, 0, 0, .35), 0 0 12px rgba(201, 165, 74, .35);
    transform: translateY(-1px);
    pointer-events: none;
  }

  .eh-ball__dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #8fd6a8;
    border: 2px solid #0d1929;
    opacity: 0;
    transform: scale(.4);
    transition: opacity .2s ease, transform .2s ease;
    pointer-events: none;
  }

  .eh-ball.is-open .eh-ball__dot {
    opacity: 1;
    transform: scale(1);
  }

  /* ---------- 面板 ---------- */

  .eh-panel {
    position: fixed;
    left: 0;
    top: 0;
    width: 384px;
    max-height: calc(100vh - 24px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
    border: 1px solid var(--eh-brass-line);
    border-radius: 16px;
    background:
      radial-gradient(120% 80% at 100% 0%, rgba(201, 165, 74, .1), transparent 55%),
      linear-gradient(165deg, #1a2a43 0%, #111e31 48%, #0b1523 100%);
    box-shadow:
      0 30px 70px -18px rgba(0, 0, 0, .85),
      0 0 0 1px rgba(0, 0, 0, .35),
      inset 0 1px 0 rgba(255, 255, 255, .07);
    color: var(--eh-ivory);
    font-family: var(--eh-font);
    font-size: 13px;
    line-height: 1.5;
    text-align: left;
    letter-spacing: normal;
    -webkit-font-smoothing: antialiased;
    opacity: 0;
    visibility: hidden;
    transform: translateY(10px) scale(.985);
    transform-origin: var(--eh-origin, bottom right);
    transition: opacity .2s ease, transform .22s cubic-bezier(.2, .7, .3, 1), visibility .22s;
    z-index: 1;
  }

  .eh-panel.is-open {
    opacity: 1;
    visibility: visible;
    transform: none;
  }

  /* ---------- 标题栏 ---------- */

  .eh-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    flex: none;
    padding: 9px 12px;
    border-bottom: 1px solid var(--eh-line);
    background: linear-gradient(180deg, rgba(255, 255, 255, .035), transparent);
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .eh-head:active { cursor: grabbing; }

  .eh-mark {
    flex: none;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 1px solid var(--eh-brass-line);
    border-radius: 8px;
    background: linear-gradient(160deg, #24395a, #152337);
    color: #ecd79f;
    font-family: var(--eh-serif);
    font-size: 14px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .1);
  }

  .eh-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: .04em;
    color: #f6efdf;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .eh-head__tools {
    display: flex;
    gap: 4px;
  }

  .eh-icon-btn {
    width: 26px;
    height: 26px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--eh-muted);
    cursor: pointer;
    transition: background .15s, color .15s, border-color .15s;
  }

  .eh-icon-btn:hover {
    background: rgba(255, 255, 255, .07);
    border-color: rgba(255, 255, 255, .08);
    color: var(--eh-ivory);
  }

  /* ---------- 标签栏 ---------- */

  .eh-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    padding: 4px 8px 5px;
    border-bottom: 1px solid var(--eh-line);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .eh-tabs::-webkit-scrollbar { display: none; }

  .eh-tab {
    flex: none;
    padding: 3px 9px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--eh-muted);
    font-family: inherit;
    font-size: 11.5px;
    line-height: 1.5;
    letter-spacing: .02em;
    white-space: nowrap;
    cursor: pointer;
    transition: color .15s, background .15s, border-color .15s;
  }

  .eh-tab:hover {
    color: var(--eh-ivory);
    background: rgba(255, 255, 255, .05);
  }

  .eh-tab.is-active {
    color: #f0d9a4;
    background: var(--eh-brass-soft);
    border-color: var(--eh-brass-line);
  }

  /* ---------- 内容区 ---------- */

  /* 滚动容器只负责滚动：留白交给每个功能页自己定，带二级导航的页面才能把导航贴到一级标签下面 */
  .eh-body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(201, 165, 74, .35) transparent;
  }

  /* 功能页统一留白（工商页会自己覆盖顶部那一截） */
  .eh-pane { padding: 14px; }

  .eh-body::-webkit-scrollbar { width: 8px; }

  .eh-body::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 8px;
    background: rgba(201, 165, 74, .25);
    background-clip: content-box;
  }

  .eh-pane[hidden] { display: none; }

  /* ---------- 固定顶部 + 内部滚动（汇率 / 市场 / 工业） ---------- */

  /* display 只写在类上（特异性低于 .eh-pane[hidden]），否则隐藏标签时会被 flex 顶回来 */
  .eh-pane--stick {
    display: flex;
    flex-direction: column;
  }

  /* 撑满内容区：顶部块固定，下面一整块自己滚，整页不再跟着滚 */
  .eh-body > .eh-pane.eh-pane--stick {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .eh-stick-head {
    flex: none;
    margin-bottom: 14px;
  }

  /* 滚动区上方的固定小标题（「全球汇率」「各国市场」）：只固定标题，说明与列表照常滚 */
  .eh-stick-bar {
    flex: none;
    margin-bottom: 8px;
  }

  .eh-stick-scroll {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(201, 165, 74, .35) transparent;
  }

  /* 滚动区里的内容按自然高度排列，别被 flex 压缩（否则溢出而不是滚动） */
  .eh-stick-scroll > * { flex: none; }

  .eh-stick-scroll::-webkit-scrollbar { width: 8px; }

  .eh-stick-scroll::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 8px;
    background: rgba(201, 165, 74, .25);
    background-clip: content-box;
  }

  .eh-section + .eh-section { margin-top: 16px; }

  .eh-h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .16em;
    text-transform: uppercase;
    color: #b39a63;
  }

  .eh-h3::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, rgba(201, 165, 74, .35), transparent);
  }

  .eh-kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 7px 14px;
    align-items: baseline;
    font-size: 12px;
  }

  .eh-kv > span {
    color: var(--eh-dim);
    white-space: nowrap;
  }

  .eh-kv > b {
    font-weight: 500;
    color: #e7dfcd;
    overflow-wrap: anywhere;
  }

  /* 需要用颜色提醒的取值（比如还没配置专用密钥时的「登录凭据」） */
  .eh-kv > b.is-warn { color: #e39a9a; }

  /* 版本号 + 检查更新按钮同一行 */
  .eh-ver {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .eh-ver > span { color: var(--eh-dim); }

  .eh-ver > b {
    font-weight: 500;
    color: #e7dfcd;
  }

  .eh-ver .eh-btn {
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11.5px;
  }

  .eh-ver a.eh-btn { line-height: 1.5; }

  .eh-mono {
    font-family: var(--eh-mono);
    font-size: 11.5px;
    letter-spacing: -.01em;
  }

  .eh-note {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.65;
    color: var(--eh-dim);
  }

  .eh-kv + .eh-note { margin-top: 10px; }

  .eh-callout {
    margin-top: 16px;
    padding: 10px 12px;
    border: 1px solid rgba(201, 165, 74, .18);
    border-left: 2px solid rgba(201, 165, 74, .65);
    border-radius: 10px;
    background: rgba(201, 165, 74, .06);
    font-size: 11.5px;
    line-height: 1.65;
    color: #cfc6b2;
  }

  .eh-empty {
    margin: 0;
    padding: 28px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--eh-dim);
  }

  .eh-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
  }

  .eh-links a {
    padding: 4px 10px;
    border: 1px solid rgba(201, 165, 74, .25);
    border-radius: 999px;
    color: #e6cd93;
    font-size: 12px;
    text-decoration: none;
    transition: background .15s, border-color .15s;
  }

  .eh-links a:hover {
    background: rgba(201, 165, 74, .12);
    border-color: rgba(201, 165, 74, .45);
  }

  .eh-linkline { margin: 12px 0 0; }

  .eh-textlink {
    color: #e6cd93;
    font-size: 12px;
    text-decoration: underline;
    text-decoration-color: rgba(201, 165, 74, .45);
    text-underline-offset: 3px;
    transition: color .15s, text-decoration-color .15s;
  }

  .eh-textlink:hover {
    color: #f4e2b4;
    text-decoration-color: rgba(232, 205, 143, .9);
  }

  .eh-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }

  .eh-btn {
    padding: 6px 12px;
    border: 1px solid rgba(201, 165, 74, .4);
    border-radius: 8px;
    background: rgba(201, 165, 74, .12);
    color: #f0d9a4;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background .15s, border-color .15s, color .15s;
  }

  .eh-btn:hover { background: rgba(201, 165, 74, .2); }

  .eh-btn:disabled,
  .eh-btn:disabled:hover {
    opacity: .55;
    background: rgba(255, 255, 255, .04);
    cursor: default;
  }

  .eh-btn--ghost {
    border-color: rgba(255, 255, 255, .12);
    background: transparent;
    color: var(--eh-muted);
  }

  .eh-btn--ghost:hover {
    border-color: rgba(255, 255, 255, .22);
    background: rgba(255, 255, 255, .05);
    color: var(--eh-ivory);
  }

  /* 更新按钮是 <a>，样式与 eh-btn 对齐 */
  a.eh-btn {
    display: inline-block;
    line-height: 1.5;
    text-decoration: none;
  }

  .eh-input {
    flex: 1 1 180px;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 8px;
    background: rgba(8, 14, 24, .5);
    color: #e7dfcd;
    font-family: var(--eh-mono);
    font-size: 11.5px;
    outline: none;
  }

  .eh-input:focus-visible {
    border-color: rgba(232, 205, 143, .7);
  }

  .eh-input::placeholder {
    color: #5f6e85;
  }

  .eh-flash {
    margin: 10px 0 0;
    font-size: 11.5px;
    color: #8fd6a8;
  }

  .eh-flash[data-tone="warn"] { color: #d9a35e; }
  .eh-flash[data-tone="error"] { color: #e39a9a; }

  .eh-note.is-ok { color: #8fd6a8; }
  .eh-note.is-warn { color: #d9a35e; }

  .eh-disclaimer {
    margin: 16px 0 0;
    padding-top: 10px;
    border-top: 1px solid var(--eh-line);
    font-size: 10.5px;
    line-height: 1.6;
    color: #64738a;
  }

  /* ---------- 汇率总览 ---------- */

  .eh-fx-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  /* 高度与右边的「刷新行情」按钮一致（12px 字 × 1.5 行高 + 6px 上下内边距 + 1px 边框 = 32px） */
  .eh-fx-field {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--eh-line);
    border-radius: 8px;
    background: rgba(255, 255, 255, .03);
    font-size: 12px;
    color: var(--eh-muted);
  }

  .eh-fx-field input {
    width: 68px;
    padding: 0 2px;
    border: 0;
    border-bottom: 1px dashed rgba(201, 165, 74, .45);
    background: transparent;
    color: #f0d9a4;
    font-family: var(--eh-mono);
    font-size: 15px;
    text-align: right;
    outline: none;
  }

  .eh-fx-field input:focus-visible {
    border-bottom-color: rgba(232, 205, 143, .9);
    outline: none;
  }

  .eh-fx-field input::-webkit-outer-spin-button,
  .eh-fx-field input::-webkit-inner-spin-button {
    margin: 0;
    -webkit-appearance: none;
    appearance: none;
  }

  .eh-fx-field input[type="number"] {
    -moz-appearance: textfield;
    appearance: textfield;
  }

  /* 换汇目标：口径标签本身就是切换按钮（右侧图标表示可切换） */
  .eh-fx-unit {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: none;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.5;
    cursor: pointer;
    transition: color .15s;
  }

  .eh-fx-unit:hover { color: #cfc6b2; }

  .eh-fx-unit:focus-visible {
    outline: 1px solid rgba(201, 165, 74, .55);
    outline-offset: 2px;
  }

  .eh-fx-unit__ico {
    flex: none;
    width: 12px;
    height: 12px;
    opacity: .7;
    transition: opacity .15s;
  }

  .eh-fx-unit:hover .eh-fx-unit__ico { opacity: 1; }

  .eh-fx-note {
    margin: 6px 0 0;
    font-size: 10.5px;
    line-height: 1.6;
    color: #7d8ba0;
  }

  .eh-fx-status {
    margin: 6px 0 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--eh-dim);
  }

  .eh-fx-status[data-tone="warn"] { color: #e0b071; }
  .eh-fx-status[data-tone="error"] { color: #e39a9a; }

  .eh-fx-legend {
    margin: 0 0 9px;
    font-size: 10.5px;
    line-height: 1.65;
    color: #7d8ba0;
  }

  .eh-fx-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .eh-fx-row {
    position: relative;
    padding: 7px 9px;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 10px;
    background: rgba(255, 255, 255, .022);
  }

  .eh-fx-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  /* 国旗：优先用接口 avatar 里的图片，图挂了退回国旗 emoji */
  .eh-fx-flag {
    flex: none;
    width: 18px;
    height: 13px;
    display: inline-grid;
    place-items: center;
    overflow: hidden;
    border-radius: 3px;
    background: rgba(255, 255, 255, .06);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1);
    font-size: 13px;
    line-height: 1;
  }

  .eh-fx-flag img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* emoji 兜底：保留同样的占位宽度，图标列才不会参差不齐（emoji 略溢出由居中吸收） */
  .eh-fx-flag--glyph {
    overflow: visible;
    background: none;
    box-shadow: none;
  }

  .eh-fx-code {
    flex: none;
    font-family: var(--eh-mono);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: .05em;
    color: #f0d9a4;
  }

  .eh-fx-name {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 5px;
    overflow: hidden;
  }

  .eh-fx-name__zh {
    flex: none;
    font-size: 11px;
    font-weight: 500;
    color: #cfc6b2;
  }

  .eh-fx-name__en {
    min-width: 0;
    overflow: hidden;
    font-size: 10px;
    color: #74839a;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* 标题行最右侧的一组：跳转箭头 + 加载转圈 */
  .eh-fx-tail {
    flex: none;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* 该货币还在拉取：行右侧的小转圈 */
  .eh-fx-spin {
    flex: none;
    width: 11px;
    height: 11px;
    border: 1.5px solid rgba(201, 165, 74, .22);
    border-top-color: #e8cd8f;
    border-radius: 50%;
    animation: eh-fx-turn .72s linear infinite;
  }

  @keyframes eh-fx-turn {
    to { transform: rotate(1turn); }
  }

  /* 标题行最右侧的跳转按钮：汇率 → 货币市场，商品 → 该国商品市场，工业 → 地区页。
     做成行内元素跟着标题走，不用绝对定位，行高变了也不会飘。 */
  .eh-go {
    flex: none;
    margin-left: auto;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: none;
    color: #7f8ea3;
    cursor: pointer;
  }

  .eh-go[hidden] { display: none; }

  .eh-go svg {
    display: block;
    width: 15px;
    height: 15px;
  }

  /* 静止时只有箭头，悬停只把箭头本身点亮 */
  .eh-go:hover { color: #f0d9a4; }

  .eh-go:focus-visible {
    outline: 1px solid rgba(201, 165, 74, .6);
    outline-offset: 1px;
  }

  .eh-fx-row.is-error {
    border-color: rgba(227, 154, 154, .3);
    background: rgba(227, 154, 154, .04);
  }

  /* 置顶：玩家国籍 / 当前所在国的汇率，用不同配色与标签区分 */
  .eh-fx-pin {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
  }

  .eh-fx-pin:empty { display: none; }

  .eh-fx-row--pin-home {
    border-color: rgba(124, 178, 232, .42);
    background: rgba(124, 178, 232, .08);
  }

  .eh-fx-row--pin-here {
    border-color: rgba(217, 163, 94, .42);
    background: rgba(217, 163, 94, .08);
  }

  .eh-fx-pin-label {
    flex: none;
    padding: 0 6px;
    border-radius: 5px;
    font-size: 9.5px;
    line-height: 1.7;
    letter-spacing: .04em;
    white-space: nowrap;
  }

  .eh-fx-row--pin-home .eh-fx-pin-label {
    background: rgba(124, 178, 232, .2);
    color: #9dc2e6;
  }

  .eh-fx-row--pin-here .eh-fx-pin-label {
    background: rgba(217, 163, 94, .2);
    color: #dcb17a;
  }

  /* 已经置顶的货币不再在全球列表里重复出现 */
  .eh-fx-row.is-pinned { display: none; }

  .eh-fx-pin-hint {
    margin: 0 0 2px;
    font-size: 10.5px;
    line-height: 1.6;
    color: #7d8ba0;
  }

  /* 一个方向一行：徽标（含最优质）+ 成交明细，窄的时候自动折行 */
  .eh-fx-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 5px;
    margin-top: 4px;
    min-width: 0;
    font-size: 10.5px;
    line-height: 1.6;
    color: #8d9bb0;
  }

  .eh-fx-flow {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .eh-fx-flow b {
    font-family: var(--eh-mono);
    font-weight: 600;
    color: #e7dfcd;
  }

  .eh-fx-avg {
    flex: none;
    font-family: var(--eh-mono);
    font-size: 9.5px;
    color: #74839a;
  }

  .eh-fx-avg b {
    font-weight: 600;
    color: #98a5b8;
  }

  .eh-fx-tag {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    padding: 1px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 10px;
    line-height: 1.7;
  }

  .eh-fx-tag b {
    font-family: var(--eh-mono);
    font-size: 11.5px;
    font-weight: 600;
  }

  /* 深度不足时徽标里的价格是成交均价，前面标一下，免得被当成最优价 */
  .eh-fx-tag__avg {
    font-size: 9px;
    opacity: .75;
  }

  .eh-fx-tag--buy {
    border-color: rgba(124, 178, 232, .22);
    background: rgba(124, 178, 232, .1);
    color: #8fb6de;
  }

  .eh-fx-tag--sell {
    border-color: rgba(143, 214, 168, .2);
    background: rgba(143, 214, 168, .09);
    color: #86c79c;
  }

  .eh-fx-tag--idle {
    border-color: rgba(255, 255, 255, .08);
    background: rgba(255, 255, 255, .03);
    color: #6d7a8f;
  }

  .eh-fx-deep {
    margin-left: 3px;
    color: #d9a35e;
  }

  /* ---------- 商品比价 ---------- */

  /* 商品选择：两行紧凑按钮（成品 / 原材料）＋ 成品才出现的品质行 */
  .eh-gd-picker {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .eh-gd-picks {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
  }

  .eh-gd-pick {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 4px 2px;
    border: 1px solid var(--eh-line);
    border-radius: 8px;
    background: rgba(255, 255, 255, .03);
    color: var(--eh-muted);
    font-family: var(--eh-font);
    font-size: 10.5px;
    line-height: 1.15;
    white-space: nowrap;
    cursor: pointer;
    transition: border-color .16s, background .16s, color .16s;
  }

  .eh-gd-pick:hover {
    border-color: rgba(201, 165, 74, .38);
    background: rgba(255, 255, 255, .06);
    color: #e7dfcd;
  }

  .eh-gd-pick.is-on {
    border-color: rgba(232, 205, 143, .6);
    background: rgba(201, 165, 74, .14);
    color: #f4e6c4;
  }

  .eh-gd-pick-icon {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    flex: none;
    overflow: hidden;
    font-size: 13px;
    line-height: 1;
  }

  .eh-gd-pick-icon img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .eh-gd-quals {
    display: grid;
    grid-template-columns: auto repeat(5, minmax(0, 1fr));
    align-items: center;
    gap: 5px;
  }

  .eh-gd-quals[hidden] { display: none; }

  .eh-gd-quals > span {
    font-size: 10px;
    color: var(--eh-dim);
  }

  .eh-gd-q {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 3px 0 2px;
    border: 1px solid var(--eh-line);
    border-radius: 7px;
    background: rgba(8, 14, 24, .5);
    color: #cbd5e1;
    font-family: var(--eh-mono);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition: border-color .16s, background .16s, color .16s;
  }

  .eh-gd-q i {
    display: block;
    width: 14px;
    height: 2px;
    border-radius: 2px;
    background: var(--q, #cbd5e1);
    opacity: .85;
  }

  .eh-gd-q:hover { border-color: rgba(255, 255, 255, .22); }

  .eh-gd-q.is-on {
    border-color: var(--q, #cbd5e1);
    background: rgba(255, 255, 255, .1);
    color: #fff;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  }

  .eh-gd-q.is-on i { opacity: 1; }

  .eh-gd-q[data-q="1"] { --q: #d7dee8; }
  .eh-gd-q[data-q="2"] { --q: #6fdc9b; }
  .eh-gd-q[data-q="3"] { --q: #7ab6f5; }
  .eh-gd-q[data-q="4"] { --q: #a98cf0; }
  .eh-gd-q[data-q="5"] { --q: #e8c069; }

  .eh-gd-pick:focus-visible,
  .eh-gd-q:focus-visible {
    outline: 1px solid rgba(232, 205, 143, .75);
    outline-offset: 1px;
  }

  /* 采购 / 销售 切换：比商品按钮矮一点，别把顶部固定区撑得太高 */
  .eh-gd-modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
    margin-bottom: 6px;
    padding: 2px;
    border: 1px solid var(--eh-line);
    border-radius: 8px;
    background: rgba(255, 255, 255, .03);
  }

  .eh-gd-mode {
    padding: 1px 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--eh-muted);
    font-family: inherit;
    font-size: 11px;
    line-height: 1.4;
    letter-spacing: .02em;
    cursor: pointer;
    transition: background .16s, color .16s, border-color .16s;
  }

  .eh-gd-mode:hover {
    background: rgba(255, 255, 255, .05);
    color: #e7dfcd;
  }

  .eh-gd-mode.is-on {
    border-color: rgba(232, 205, 143, .45);
    background: rgba(201, 165, 74, .16);
    color: #f4e6c4;
  }

  .eh-gd-mode:focus-visible {
    outline: 1px solid rgba(232, 205, 143, .75);
    outline-offset: 1px;
  }

  /* 销售：只在税率 / 国籍读取异常时出现（正常态不重复「国籍 / 免进口税」，列表行内已有） */
  .eh-gd-own {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin-top: 7px;
    padding: 6px 8px;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 9px;
    background: rgba(255, 255, 255, .022);
  }

  .eh-gd-own[hidden] { display: none; }

  .eh-gd-hint {
    flex: 1 1 100%;
    margin: 0;
    font-size: 10px;
    line-height: 1.55;
    color: #7d8ba0;
  }

  .eh-gd-hint[data-tone="warn"] { color: #e0b071; }

  /* ---------- 功能开关（设置页：市场页金价 / 地区入口 / 自动比价） ---------- */

  .eh-gd-switch {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 0 0;
    font-size: 11px;
    line-height: 1.4;
    color: #9fadc2;
    cursor: pointer;
    user-select: none;
  }

  .eh-gd-switch input {
    width: 13px;
    height: 13px;
    margin: 0;
    accent-color: #c9a54a;
    cursor: pointer;
    flex: none;
  }

  .eh-gd-switch:hover { color: #c7d3e3; }

  .eh-gd-meta--sub {
    padding-top: 1px;
    font-size: 9.5px;
    color: #64738a;
  }

  .eh-gd-bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
  }

  .eh-gd-bar .eh-fx-status {
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre-line;
  }

  .eh-gd-bar .eh-btn { flex: none; }

  .eh-gd-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .eh-gd-row {
    position: relative;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto 24px;
    align-items: center;
    gap: 3px 7px;
    padding: 6px 9px;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 10px;
    background: rgba(255, 255, 255, .022);
  }

  /* 第一名：绿色系，和「当前所在国」的橙色拉开距离 */
  .eh-gd-row.is-best {
    border-color: rgba(111, 191, 155, .4);
    background: rgba(111, 191, 155, .08);
  }

  /* 玩家当前所在国家：只换一套配色并加标签，不置顶、不改排序 */
  .eh-gd-row.is-here {
    border-color: rgba(217, 163, 94, .42);
    background: rgba(217, 163, 94, .08);
  }

  .eh-gd-row.is-here .eh-gd-place b { color: #f0d3ab; }

  /* 既是第一名又是当前所在国：橙色底色保留，描边换成绿色，两种状态都看得出来 */
  .eh-gd-row.is-best.is-here { border-color: rgba(111, 191, 155, .5); }

  .eh-gd-row.is-idle { opacity: .62; }

  .eh-gd-row .eh-go {
    grid-column: 4;
    grid-row: 1;
    align-self: center;
    justify-self: end;
    margin-left: 0;
  }

  .eh-gd-place {
    display: flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
  }

  .eh-gd-place b {
    flex: none;
    font-size: 11.5px;
    font-weight: 500;
    color: #e7dfcd;
    white-space: nowrap;
  }

  /* 英文国名：紧跟中文名的小字，空间不够时自己截断，不挤掉后面的标签 */
  .eh-gd-en {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: 9.5px;
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #6d7c92;
  }

  .eh-gd-gold {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
    font-family: var(--eh-mono);
  }

  .eh-gd-gold b {
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -.01em;
    color: #f0d9a4;
  }

  .eh-gd-gold .eh-gold-ico { margin-right: 0; vertical-align: 0; }

  .eh-gd-row.is-best .eh-gd-gold b { color: #a7e0c4; }

  .eh-gd-meta {
    grid-column: 1 / -1;
    font-size: 10px;
    line-height: 1.6;
    color: #7d8ba0;
  }

  .eh-gd-meta b {
    font-family: var(--eh-mono);
    font-weight: 600;
    color: #b6c0cf;
  }

  /* 国名右侧的状态标签：玩家国籍 / 当前位置，两者重合时合成一个 */
  .eh-gd-mark {
    flex: none;
    margin-left: 2px;
    padding: 0 5px;
    border: 1px solid rgba(217, 163, 94, .34);
    border-radius: 4px;
    background: rgba(217, 163, 94, .16);
    font-size: 9.5px;
    white-space: nowrap;
    color: #e0b47c;
  }

  .eh-gd-tax {
    margin-left: 4px;
    font-size: 9.5px;
    white-space: nowrap;
    color: #d9a35e;
  }

  /* 流亡政府：失去全部领土后玩家无法抵达，单独列一栏放在最底下 */
  .eh-gd-exile {
    margin-top: 9px;
    padding-top: 8px;
    border-top: 1px dashed rgba(200, 130, 96, .26);
  }

  .eh-gd-exile[hidden] { display: none; }

  .eh-gd-exile-head { margin-bottom: 6px; }

  .eh-gd-exile-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .04em;
    color: #c88d6c;
  }

  .eh-gd-exile-title::before {
    content: '';
    width: 3px;
    height: 11px;
    border-radius: 2px;
    background: #8c5a3c;
  }

  .eh-gd-exile-note {
    margin: 3px 0 0;
    font-size: 9.5px;
    line-height: 1.6;
    color: #6d7889;
  }

  .eh-gd-row.is-exile {
    opacity: .58;
    border-style: dashed;
  }

  .eh-gd-exile-tag {
    margin-left: 4px;
    font-size: 9.5px;
    white-space: nowrap;
    color: #b07a5c;
  }

  /* ---------- 工商：子面板 + 工业地区列表 ---------- */

  /* 整页撑满内容区：子标签固定在上面，只有下面的列表滚动，也不会多出一条色带 */
  .eh-biz-shell {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    /* 顶部只留 10px：二级标签是一级标签的下一行，跟着通用留白会显得像又开了一层板 */
    padding: 10px 14px 14px;
    overflow: hidden;
  }

  .eh-biz-tabs {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 0 0 8px;
    padding-bottom: 6px;
    border-bottom: 1px dashed rgba(255, 255, 255, .09);
  }

  .eh-biz-body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(201, 165, 74, .35) transparent;
  }

  /* 默认由整块内容一起滚；固定头部的子面板（工业 / 税费）自己接管滚动 */
  .eh-biz-body > .eh-biz-pane { flex: none; }

  .eh-biz-body > .eh-biz-pane.eh-pane--stick {
    flex: 1 1 auto;
    min-height: 0;
  }

  .eh-biz-body::-webkit-scrollbar { width: 8px; }

  .eh-biz-body::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 8px;
    background: rgba(201, 165, 74, .25);
    background-clip: content-box;
  }

  /* 二级标签：比一级标签再小一号，配色用青绿系，和顶栏的金色区分开 */
  .eh-biz-tab {
    flex: none;
    padding: 2px 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: #8b9bb0;
    font-family: inherit;
    font-size: 10.5px;
    line-height: 1.55;
    white-space: nowrap;
    cursor: pointer;
    transition: color .15s, background .15s, border-color .15s;
  }

  .eh-biz-tab:hover {
    color: var(--eh-ivory);
    background: rgba(255, 255, 255, .05);
  }

  .eh-biz-tab.is-active {
    color: #a8d8c4;
    background: rgba(111, 191, 155, .12);
    border-color: rgba(111, 191, 155, .34);
  }

  .eh-biz-pane[hidden] { display: none; }

  /* 税费子面板：顶部搜索（中英文国名 / 法币代码） */
  .eh-biz-search {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 7px;
  }

  .eh-biz-search .eh-input {
    flex: 1 1 auto;
    padding: 4px 9px;
    font-size: 11px;
  }

  /* 税费子面板：搜索 / 排序 / 状态固定，只有下面的国家列表滚 */
  .eh-tax-pane {
    display: flex;
    flex-direction: column;
  }

  /* 覆盖上面那条「整块内容一起滚」：税费页把高度让给内部的列表滚动区 */
  .eh-biz-body > .eh-tax-pane {
    flex: 1 1 auto;
    min-height: 0;
  }

  .eh-tax-pane > .eh-section {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  .eh-tax-head { flex: none; }

  .eh-tax-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(201, 165, 74, .35) transparent;
  }

  .eh-tax-scroll::-webkit-scrollbar { width: 8px; }

  .eh-tax-scroll::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 8px;
    background: rgba(201, 165, 74, .25);
    background-clip: content-box;
  }

  /* 排序：一列一个标签，点一次换列、再点一次切换升降序 */
  .eh-biz-sorts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-bottom: 7px;
  }

  .eh-biz-sorts__cap {
    flex: none;
    font-size: 10px;
    letter-spacing: .12em;
    color: #7d8ba0;
  }

  .eh-biz-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .eh-biz-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 1px 7px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px;
    background: transparent;
    color: #9fadc2;
    font-family: inherit;
    font-size: 10px;
    line-height: 1.7;
    white-space: nowrap;
    cursor: pointer;
    transition: color .15s, background .15s, border-color .15s;
  }

  .eh-biz-chip:hover {
    color: #c7d3e3;
    border-color: rgba(255, 255, 255, .2);
  }

  .eh-biz-chip.is-active {
    color: #f0d9a4;
    background: rgba(201, 165, 74, .13);
    border-color: rgba(201, 165, 74, .42);
  }

  .eh-biz-chip__dir {
    font-size: 9px;
    line-height: 1;
    opacity: .9;
  }

  .eh-biz-bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-top: 7px;
  }

  .eh-biz-bar .eh-fx-status {
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
    white-space: pre-line;
  }

  .eh-biz-bar .eh-btn {
    flex: none;
    padding: 4px 10px;
    font-size: 11.5px;
  }

  .eh-biz-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }

  .eh-biz-row {
    position: relative;
    padding: 5px 9px 5px;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 9px;
    background: rgba(255, 255, 255, .022);
  }

  /* 默认综合排序下的第一名：绿色系，和其它面板保持一致 */
  .eh-biz-row.is-best {
    border-color: rgba(111, 191, 155, .38);
    background: rgba(111, 191, 155, .07);
  }

  .eh-biz-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .eh-biz-name {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 5px;
    overflow: hidden;
  }

  .eh-biz-name b {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: 11.5px;
    font-weight: 500;
    color: #e7dfcd;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .eh-biz-country {
    flex: none;
    max-width: 45%;
    overflow: hidden;
    font-size: 9.5px;
    color: #6d7c92;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .eh-biz-meta {
    margin-top: 2px;
    font-size: 9.5px;
    line-height: 1.7;
    color: #7d8ba0;
  }

  /* 一组「标签 + 数值」不要被换行拆开，只在组与组之间换行 */
  .eh-biz-cell {
    display: inline-block;
    margin-right: 9px;
    white-space: nowrap;
  }

  /* 物产可能有好几种，允许它自己换行，别把一行撑爆 */
  .eh-biz-cell--wrap { white-space: normal; }

  .eh-biz-cell:last-child { margin-right: 0; }

  /* 强制换行的占位：让后面的格子从新的一行开始，不额外占高度 */
  .eh-biz-break {
    display: block;
    height: 0;
  }

  .eh-biz-meta em {
    margin-right: 3px;
    font-style: normal;
    color: #64738a;
  }

  .eh-biz-meta b {
    font-family: var(--eh-mono);
    font-size: 10px;
    font-weight: 600;
    color: #b6c0cf;
  }

  .eh-biz-meta b[data-tone="warn"] { color: #d9a35e; }

  /* 国名后的法币代码：小号等宽，方便和「汇率」页的货币对上 */
  .eh-biz-cur {
    flex: none;
    padding: 0 4px;
    border-radius: 4px;
    background: rgba(201, 165, 74, .12);
    color: #c9a54a;
    font-family: var(--eh-mono);
    font-size: 9px;
    line-height: 1.65;
  }

  /* 折算成黄金的副值：跟在同一格主值后面，小一号 */
  .eh-biz-gold {
    margin-left: 3px;
    font-family: var(--eh-mono);
    font-size: 9.5px;
    color: #c9a54a;
  }

  /* 流亡政府的行：虚线框 + 降透明度，和「市场」页的处理一致 */
  .eh-biz-row.is-exile {
    opacity: .6;
    border-style: dashed;
  }

  /* 税费：玩家国籍国 / 当前所在国就地高亮（不置顶、不干预排序），配色与「汇率」「市场」一致 */
  .eh-biz-row.is-home {
    border-color: rgba(124, 178, 232, .42);
    background: rgba(124, 178, 232, .08);
  }

  .eh-biz-row.is-here {
    border-color: rgba(217, 163, 94, .42);
    background: rgba(217, 163, 94, .08);
  }

  .eh-biz-row.is-home .eh-biz-name b { color: #cfe2f5; }
  .eh-biz-row.is-here .eh-biz-name b { color: #f0d3ab; }

  /* 既是第一名又是本国 / 所在国：底色保留标记色，描边换成绿色，两种状态都看得出来 */
  .eh-biz-row.is-best.is-home,
  .eh-biz-row.is-best.is-here {
    border-color: rgba(111, 191, 155, .5);
  }

  /* 国名右侧的状态标签：玩家国籍 / 当前位置，两者重合时合成一个 */
  .eh-tax-mark {
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 9.5px;
    line-height: 1.7;
    letter-spacing: .02em;
    white-space: nowrap;
  }

  .eh-biz-row.is-home .eh-tax-mark {
    background: rgba(124, 178, 232, .2);
    color: #9dc2e6;
  }

  .eh-biz-row.is-here .eh-tax-mark {
    background: rgba(217, 163, 94, .2);
    color: #dcb17a;
  }

  /* 工作子面板：搜索框下面一行放最低税后工资 / 技能过滤；刷新按钮跟状态栏同一行 */
  .eh-job-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-bottom: 7px;
  }

  /* 复合输入框：左侧「金币 ≥」+ 右侧数字，视觉上仍是同一个输入框 */
  .eh-job-min-wrap {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: stretch;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 8px;
    background: rgba(8, 14, 24, .5);
  }

  .eh-job-min-wrap:focus-within { border-color: rgba(232, 205, 143, .7); }

  .eh-job-min-addon {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    border-right: 1px solid rgba(255, 255, 255, .1);
    color: #c9a54a;
    font-size: 10px;
    white-space: nowrap;
  }

  .eh-job-min-addon .eh-gold-ico {
    width: 15px;
    height: 15px;
    margin-right: 0;
    vertical-align: -2px;
  }

  .eh-job-min {
    flex: 0 1 110px;
    width: 110px;
    min-width: 80px;
    padding: 4px 7px;
    border: 0;
    border-radius: 0;
    background: transparent;
    font-size: 11px;
  }

  .eh-job-min:focus-visible { border-color: transparent; }

  .eh-job-filter { margin: 0; }

  /* 岗位行：左列公司 / 拥有者 / 类型技能 / 地区，右列薪资与跳转（右列撑满整行高度） */
  .eh-job-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: stretch;
    gap: 8px;
  }

  .eh-job-main { min-width: 0; }

  /* 标题区：公司图标占满两行，第一行产业类型 + 公司名，第二行职位数 + 技能要求。
     图标 28px + 5px 间距与底部两行的图标块（11 + 5 + 12）同宽同距，四行文字共用一个左边界 */
  .eh-job-title {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-rows: 14px 14px;
    align-items: center;
    column-gap: 5px;
    row-gap: 1px;
  }

  .eh-job-title > .eh-job-avatar {
    grid-row: 1 / span 2;
    width: 28px;
    height: 28px;
    align-self: center;
  }

  .eh-job-avatar {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 5px;
    object-fit: cover;
    background: rgba(255, 255, 255, .06);
    color: #9fadc2;
    font-size: 11px;
  }

  .eh-job-headline,
  .eh-job-subtitle {
    grid-column: 2;
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }

  .eh-job-headline { grid-row: 1; }

  /* 副标题 / 雇主 / 地区是同一种说明文字，字号、字重、颜色统一在这里定义，
     各行不要再单独覆盖（地区行的配置是基准；500 是补齐 9.5px 下数字、拉丁
     字母比中文显细的观感）。公司类型 .eh-job-type 单独着色，不在此列 */
  .eh-job-subtitle,
  .eh-job-owner,
  .eh-job-loc-text {
    font-size: 9.5px;
    font-weight: 500;
    color: #9fadc2;
  }

  .eh-job-subtitle { grid-row: 2; flex-wrap: wrap; gap: 3px 3px; }

  .eh-job-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: 11.5px;
    font-weight: 500;
    color: #e7dfcd;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 雇主行与地区行是同一块底部信息：标记 11px + 5px 间距 + 标识 12px = 28px，
     正好等于标题区公司图标的宽度，标识才不会顶出图标列；两处间距也必须一致，
     文字列才会落在同一条竖线上（改一处要同步改另一处） */
  .eh-job-line {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    margin-top: 3px;
  }

  .eh-job-owner {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    min-width: 0;
  }

  .eh-job-owner-mark { flex: none; display: inline-flex; color: #8d9bb0; }
  .eh-job-owner-mark svg { display: block; width: 11px; height: 11px; }

  .eh-job-owner-avatar {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    object-fit: cover;
    background: rgba(255, 255, 255, .06);
  }

  .eh-job-owner-fallback {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: rgba(255, 255, 255, .06);
    color: #9fadc2;
    font-size: 9px;
  }

  .eh-job-owner > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* 地区信息移到左列最底下，开头带地图标记 */
  .eh-job-loc {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    min-width: 0;
  }

  .eh-job-pin { flex: none; display: inline-flex; color: #8d9bb0; }
  .eh-job-pin svg { display: block; width: 11px; height: 11px; }

  .eh-job-flag { width: 12px; height: 9px; font-size: 9px; }

  .eh-job-loc-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .eh-job-type {
    color: #dcbb6b;
    white-space: nowrap;
  }

  /* 分隔点与地区行的「·」同款：字号、颜色都继承副标题，不再单独调暗调小 */
  .eh-job-dot {
    flex: none;
    line-height: 1;
  }

  .eh-job-subtitle .eh-tax-mark { padding: 0 4px; font-size: 9px; }

  .eh-job-side {
    display: flex;
    flex: none;
    align-self: stretch;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .eh-job-pay {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.4;
  }

  .eh-job-pay b {
    font-family: var(--eh-mono);
    font-size: 11px;
    font-weight: 600;
    color: #e7dfcd;
    white-space: nowrap;
  }

  .eh-job-pay span {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: var(--eh-mono);
    font-size: 9.5px;
    color: #c9a54a;
    white-space: nowrap;
  }

  .eh-job-pay span[data-tone="muted"] { color: #7d8ba0; }

  .eh-job-side .eh-go { width: 22px; height: 22px; margin: auto 0 0; }

  /* ---------- 底栏 ---------- */

  .eh-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex: none;
    padding: 8px 14px;
    border-top: 1px solid var(--eh-line);
    background: rgba(0, 0, 0, .22);
    font-size: 10.5px;
    color: var(--eh-dim);
  }

  .eh-foot__status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .eh-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #8fd6a8;
    box-shadow: 0 0 8px rgba(143, 214, 168, .7);
  }

  .eh-foot__hint {
    font-family: var(--eh-mono);
    font-size: 10px;
    color: #5f6e85;
  }

  /* ---------- 焦点与动效偏好 ---------- */

  :where(button, a):focus-visible {
    outline: 2px solid rgba(232, 205, 143, .75);
    outline-offset: 2px;
  }

  .eh-panel:focus { outline: none; }

  .eh-panel:focus-visible {
    outline: 1px solid rgba(232, 205, 143, .4);
    outline-offset: -1px;
  }

  @media (prefers-reduced-motion: reduce) {
    .eh-panel,
    .eh-ball,
    .eh-tab,
    .eh-btn,
    .eh-icon-btn,
    .eh-links a,
    .eh-ball__dot {
      transition: none !important;
    }

    /* 偏好减少动效时用呼吸代替旋转，仍然看得出「还在读取」 */
    .eh-fx-spin {
      border-color: rgba(201, 165, 74, .38);
      animation: eh-fx-breathe 1.2s ease-in-out infinite;
    }
  }

  @keyframes eh-fx-breathe {
    50% { opacity: .35; }
  }

  @media (max-width: 480px) {
    .eh-head { padding: 8px 10px; }
    .eh-tabs { padding: 4px 6px 5px; }
    .eh-pane { padding: 12px; }
    .eh-biz-shell { padding: 8px 12px 12px; }
  }
  `;

  /* =========================================================================
   * 4. 外壳
   * ========================================================================= */

  function applyStyles(shadow) {
    try {
      if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLES);
        shadow.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (err) {
      /* 构造样式表失败时回退到 <style> */
    }
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);
  }

  function createShell() {
    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:' + Z_INDEX + ';pointer-events:none;';

    const shadow = host.attachShadow({ mode: 'open' });
    applyStyles(shadow);
    // 黄金图标加载失败时退回「金」字（img 的 error 不冒泡，用捕获阶段委托）
    on(shadow, 'error', onGoldIconError, true);

    // ---- 悬浮球 ----
    const ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'eh-ball';
    ball.setAttribute('aria-label', 'Eclesiar 助手（Alt+E）');
    ball.setAttribute('aria-expanded', 'false');
    ball.setAttribute('aria-controls', 'eh-panel');
    ball.title = 'Eclesiar 助手（Alt+E）';
    ball.innerHTML =
      '<span class="eh-ball__glow" aria-hidden="true"></span>' +
      '<span class="eh-ball__mark" aria-hidden="true">E</span>' +
      '<span class="eh-ball__dot" aria-hidden="true"></span>';

    // ---- 面板 ----
    const panel = document.createElement('section');
    panel.id = 'eh-panel';
    panel.className = 'eh-panel';
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Eclesiar 助手面板');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <header class="eh-head" data-role="head" title="拖动可移动面板，双击恢复自动跟随">
        <span class="eh-mark" aria-hidden="true">E</span>
        <div class="eh-title">Eclesiar 助手</div>
        <div class="eh-head__tools">
          <button class="eh-icon-btn" type="button" data-action="collapse"
            aria-label="收起面板" title="收起面板（Esc）">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 7h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </header>
      <nav class="eh-tabs" role="tablist" aria-label="功能模块" data-role="tabs"></nav>
      <div class="eh-body" data-role="body"></div>
      <footer class="eh-foot">
        <span class="eh-foot__status">
          <i class="eh-dot" aria-hidden="true"></i>
          <span data-role="status">运行中 · v${VERSION}</span>
        </span>
        <span class="eh-foot__hint">Alt+E</span>
      </footer>
    `;

    shadow.appendChild(ball);
    shadow.appendChild(panel);
    document.body.appendChild(host);

    dom.host = host;
    dom.shadow = shadow;
    dom.ball = ball;
    dom.panel = panel;
    dom.head = panel.querySelector('[data-role="head"]');
    dom.tabs = panel.querySelector('[data-role="tabs"]');
    dom.body = panel.querySelector('[data-role="body"]');
    dom.status = panel.querySelector('[data-role="status"]');

    applyCriticalFallback();
  }

  /**
   * 兜底：若样式表被页面 CSP 拦截（<style> 也不生效），
   * 用 CSSOM 写一段最小内联样式，保证入口仍可见、可用。
   */
  function applyCriticalFallback() {
    let styled = true;
    try {
      styled = getComputedStyle(dom.ball).position === 'fixed';
    } catch (err) {
      styled = true;
    }
    if (styled) return;

    fallbackStyles = true;
    warn('样式表未生效（可能被页面 CSP 拦截），已启用最小内联样式兜底。');

    Object.assign(dom.ball.style, {
      position: 'fixed',
      width: '54px',
      height: '54px',
      padding: '0',
      borderRadius: '50%',
      border: '1px solid #c9a54a',
      background: '#16253b',
      color: '#ecd79f',
      font: '25px Georgia, serif',
      zIndex: '2',
      cursor: 'grab',
      pointerEvents: 'auto'
    });

    Object.assign(dom.panel.style, {
      position: 'fixed',
      display: 'flex',
      flexDirection: 'column',
      width: '384px',
      maxHeight: 'calc(100vh - 24px)',
      overflow: 'hidden',
      background: '#101d30',
      border: '1px solid rgba(201, 165, 74, .4)',
      borderRadius: '14px',
      color: '#f4eddd',
      font: '13px/1.5 -apple-system, "PingFang SC", sans-serif',
      zIndex: '1',
      boxSizing: 'border-box',
      pointerEvents: 'auto'
    });
    dom.panel.style.visibility = 'hidden';

    Object.assign(dom.head.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '12px 14px',
      borderBottom: '1px solid rgba(255, 255, 255, .1)',
      cursor: 'grab'
    });
    Object.assign(dom.tabs.style, {
      display: 'flex',
      gap: '4px',
      padding: '8px 10px',
      borderBottom: '1px solid rgba(255, 255, 255, .1)',
      overflowX: 'auto'
    });
    Object.assign(dom.body.style, {
      padding: '14px',
      overflowY: 'auto',
      flex: '1 1 auto',
      minHeight: '0'
    });
  }

  /* =========================================================================
   * 5. 悬浮球：定位、拖拽、点击
   * ========================================================================= */

  function freeArea() {
    return {
      w: Math.max(0, window.innerWidth - BALL_SIZE - EDGE * 2),
      h: Math.max(0, window.innerHeight - BALL_SIZE - EDGE * 2)
    };
  }

  function ballPosition() {
    const area = freeArea();
    return {
      x: EDGE + clamp(state.ball.rx, 0, 1) * area.w,
      y: EDGE + clamp(state.ball.ry, 0, 1) * area.h
    };
  }

  function applyBall() {
    if (!dom.ball) return;
    const pos = ballPosition();
    dom.ball.style.left = Math.round(pos.x) + 'px';
    dom.ball.style.top = Math.round(pos.y) + 'px';
  }

  function saveBallPosition(x, y) {
    const area = freeArea();
    state.ball = {
      rx: area.w ? clamp((x - EDGE) / area.w, 0, 1) : 0,
      ry: area.h ? clamp((y - EDGE) / area.h, 0, 1) : 0
    };
    storage.write('ball', state.ball);
  }

  function bindBall() {
    const ball = dom.ball;
    let drag = null;
    let suppressClick = false;

    on(ball, 'pointerdown', (event) => {
      if (!event.isPrimary) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const origin = ballPosition();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: origin.x,
        originY: origin.y,
        moved: false
      };
      try {
        ball.setPointerCapture(event.pointerId);
      } catch (err) {
        /* ignore */
      }
      ball.classList.add('is-dragging');
    });

    on(ball, 'pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (event.buttons === 0) {
        finishDrag(event);
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const area = freeArea();
      ball.style.left = Math.round(clamp(drag.originX + dx, EDGE, EDGE + area.w)) + 'px';
      ball.style.top = Math.round(clamp(drag.originY + dy, EDGE, EDGE + area.h)) + 'px';
      if (state.open && !state.panelPinned) placePanel();
    });

    const finishDrag = (event) => {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      const wasMoved = drag.moved;
      const pointerId = drag.id;
      // 先清空再释放：releasePointerCapture 可能同步触发 lostpointercapture
      drag = null;
      try {
        ball.releasePointerCapture(pointerId);
      } catch (err) {
        /* ignore */
      }
      ball.classList.remove('is-dragging');
      if (!wasMoved) return;

      saveBallPosition(parseFloat(ball.style.left) || 0, parseFloat(ball.style.top) || 0);
      if (state.open) placePanel();

      // 拖拽结束会补发一次 click，这里吞掉它，避免误开合面板
      suppressClick = true;
      clearTimeout(suppressClickTimer);
      suppressClickTimer = window.setTimeout(() => {
        suppressClick = false;
      }, 450);
    };

    on(ball, 'pointerup', finishDrag);
    on(ball, 'pointercancel', finishDrag);
    on(ball, 'lostpointercapture', finishDrag);

    on(ball, 'click', (event) => {
      if (suppressClick) {
        suppressClick = false;
        clearTimeout(suppressClickTimer);
        // 键盘触发的 click（detail 为 0）不应被拖拽后的抑制逻辑吞掉
        if (event.detail > 0) {
          event.preventDefault();
          return;
        }
      }
      setOpen(!state.open);
    });
  }

  /* =========================================================================
   * 6. 面板：定位、开合、标签页
   * ========================================================================= */

  function panelWidth() {
    return Math.min(384, window.innerWidth - 24);
  }

  function measurePanelHeight() {
    const limit = Math.max(0, window.innerHeight - 24);
    panelHeightCache = Math.min(dom.panel.offsetHeight || 0, limit);
    return panelHeightCache;
  }

  /**
   * 面板跟随悬浮球（未固定时）或保持用户拖拽的位置（已固定时）。
   * options.measure —— 重新测量高度（首次打开、切标签、窗口缩放时）
   * options.keepTop —— 内容变高时保持顶部不动，只向下生长（避免切标签整块跳动）
   */
  function placePanel(options) {
    if (!dom.panel) return;
    const opts = options || {};

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = panelWidth();
    const widthText = width + 'px';
    if (dom.panel.style.width !== widthText) dom.panel.style.width = widthText;

    if (opts.measure || !panelHeightCache) measurePanelHeight();
    const height = Math.min(panelHeightCache, Math.max(0, vh - 24));
    const maxLeft = Math.max(12, vw - width - 12);
    const maxTop = Math.max(12, vh - height - 12);

    if (state.panelPinned && state.panelPos) {
      dom.panel.style.left = Math.round(clamp(state.panelPos.left, 12, maxLeft)) + 'px';
      dom.panel.style.top = Math.round(clamp(state.panelPos.top, 12, maxTop)) + 'px';
      dom.panel.style.setProperty('--eh-origin', 'top left');
      return;
    }

    const ball = ballPosition();
    const anchorRight = ball.x + BALL_SIZE / 2 > vw / 2;
    const left = clamp(anchorRight ? ball.x - width - 14 : ball.x + BALL_SIZE + 14, 12, maxLeft);

    let top = clamp(ball.y + BALL_SIZE - height, 12, maxTop);
    if (opts.keepTop) {
      const currentTop = parseFloat(dom.panel.style.top);
      if (Number.isFinite(currentTop)) top = clamp(currentTop, 12, maxTop);
    }

    dom.panel.style.left = Math.round(left) + 'px';
    dom.panel.style.top = Math.round(top) + 'px';
    dom.panel.style.setProperty('--eh-origin', anchorRight ? 'bottom right' : 'bottom left');
  }

  function setOpen(next) {
    if (destroyed || !dom.panel) return;
    next = Boolean(next);
    if (next === state.open) return;

    const active = dom.shadow.activeElement;
    const hadFocus = Boolean(active && dom.panel.contains(active));

    state.open = next;
    dom.panel.classList.toggle('is-open', next);
    dom.panel.setAttribute('aria-hidden', String(!next));
    dom.ball.classList.toggle('is-open', next);
    dom.ball.setAttribute('aria-expanded', String(next));
    if (fallbackStyles) dom.panel.style.visibility = next ? 'visible' : 'hidden';

    if (next) {
      renderTabs();
      activateTab(state.activeTab);
      placePanel({ measure: true });
      dom.panel.focus({ preventScroll: true });
    } else if (hadFocus) {
      dom.ball.focus({ preventScroll: true });
    }
  }

  function sortedFeatures() {
    return [...features.values()].sort((a, b) => {
      const order = (a.order == null ? 100 : a.order) - (b.order == null ? 100 : b.order);
      return order !== 0 ? order : a.title.localeCompare(b.title, 'zh-Hans');
    });
  }

  function tabButtonFor(id) {
    return [...dom.tabs.querySelectorAll('.eh-tab')].find((btn) => btn.dataset.feature === id) || null;
  }

  function renderTabs() {
    if (!dom.tabs) return;
    const list = sortedFeatures();

    // 复用按钮：反复开合面板时不新增监听器，也不会丢焦点
    list.forEach((feature) => {
      let btn = tabButtons.get(feature.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-tab';
        btn.dataset.feature = feature.id;
        btn.id = 'eh-tab-' + feature.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', 'false');
        btn.setAttribute('aria-controls', 'eh-pane-' + feature.id);
        btn.tabIndex = -1;
        on(btn, 'click', () => activateTab(feature.id));
        tabButtons.set(feature.id, btn);
      }
      if (btn.textContent !== feature.title) btn.textContent = feature.title;
    });

    [...tabButtons.keys()].forEach((id) => {
      if (features.has(id)) return;
      const btn = tabButtons.get(id);
      if (btn) btn.remove();
      tabButtons.delete(id);
    });

    const desired = list.map((feature) => feature.id).join('|');
    const current = [...dom.tabs.children].map((btn) => btn.dataset.feature).join('|');
    if (desired !== current) {
      list.forEach((feature) => dom.tabs.appendChild(tabButtons.get(feature.id)));
    }

    dom.tabs.hidden = list.length === 0;
  }

  function activateTab(id, options) {
    if (!dom.body) return;
    const list = sortedFeatures();

    if (!list.length) {
      dom.body.textContent = '';
      const empty = document.createElement('p');
      empty.className = 'eh-empty';
      empty.textContent = '还没有注册任何功能模块。';
      dom.body.appendChild(empty);
      return;
    }

    const feature = features.get(id) || list[0];
    state.activeTab = feature.id;
    storage.write('activeTab', feature.id);

    [...dom.tabs.querySelectorAll('.eh-tab')].forEach((btn) => {
      const active = btn.dataset.feature === feature.id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });

    if (!feature.__pane) {
      const pane = document.createElement('div');
      pane.className = 'eh-pane';
      pane.id = 'eh-pane-' + feature.id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', 'eh-tab-' + feature.id);
      dom.body.appendChild(pane);
      feature.__pane = pane;

      const tabBtn = tabButtonFor(feature.id);
      if (tabBtn) tabBtn.setAttribute('aria-controls', pane.id);

      try {
        feature.mount(pane, createFeatureContext(feature));
      } catch (err) {
        warn('功能「' + feature.title + '」初始化失败', err);
        const failed = document.createElement('p');
        failed.className = 'eh-empty';
        failed.textContent = '功能初始化失败：' + (err && err.message ? err.message : String(err));
        pane.appendChild(failed);
      }
    }

    [...dom.body.querySelectorAll('.eh-pane')].forEach((pane) => {
      pane.hidden = pane !== feature.__pane;
    });

    if (state.open) placePanel({ measure: true, keepTop: true });
    if (options && options.focus) {
      const btn = tabButtonFor(feature.id);
      if (btn) btn.focus();
    }

    // 标签被显示时才通知：面板没开时切标签不该发请求
    if (state.open && feature.__showHooks) {
      feature.__showHooks.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          warn('功能「' + feature.title + '」显示回调异常', err);
        }
      });
    }
  }

  function createFeatureContext(feature) {
    const cleanups = [];
    const showHooks = [];
    feature.__cleanups = cleanups;
    feature.__showHooks = showHooks;

    return {
      version: VERSION,
      id: feature.id,
      shadow: dom.shadow,
      ui: publicUi,
      storage: {
        get: (key, fallback) => storage.read(feature.id + ':' + key, fallback),
        set: (key, value) => storage.write(feature.id + ':' + key, value),
        remove: (key) => storage.remove(feature.id + ':' + key)
      },
      route: {
        get current() {
          return route.current;
        },
        onChange: (fn) => route.subscribe(fn),
        goto: (path) => route.goto(path)
      },
      onDestroy(fn) {
        if (typeof fn === 'function') cleanups.push(fn);
      },
      /**
       * 这个标签每次被显示（面板重新打开 / 切到它）时调用一次。
       * 用来把「什么时候去读」收在一处：命中 TTL 就不发请求，过期才重读。
       */
      onShow(fn) {
        if (typeof fn === 'function') showHooks.push(fn);
      },
      log: (...args) => log('[' + feature.id + ']', ...args)
    };
  }

  function registerFeature(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) {
      throw new Error('registerFeature: 需要合法的 id');
    }
    if (typeof definition.title !== 'string' || !definition.title.trim()) {
      throw new Error('registerFeature: 需要 title');
    }
    if (typeof definition.mount !== 'function') {
      throw new Error('registerFeature: 需要 mount 函数');
    }
    if (features.has(definition.id)) {
      warn('功能 id 重复，已忽略：' + definition.id);
      return features.get(definition.id);
    }

    features.set(definition.id, definition);
    if (dom.tabs) {
      renderTabs();
      if (state.open) activateTab(state.activeTab);
    }
    return definition;
  }

  function bindPanel() {
    const panel = dom.panel;

    on(panel.querySelector('[data-action="collapse"]'), 'click', () => setOpen(false));

    // 标题栏拖拽：只改 left/top，因此用 inline 位置而不是 getBoundingClientRect
    // （后者会把入场动画的 transform 一并算进去，导致松手后位置跳一下）
    let drag = null;
    const head = dom.head;

    on(head, 'pointerdown', (event) => {
      if (!event.isPrimary) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest('button, a, input, textarea, select')) return;
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: parseFloat(panel.style.left) || 0,
        top: parseFloat(panel.style.top) || 0,
        width: panel.offsetWidth,
        height: panel.offsetHeight,
        moved: false
      };
      try {
        head.setPointerCapture(event.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    on(head, 'pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (event.buttons === 0) {
        finishDrag(event);
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      panel.classList.add('is-dragging');

      const maxLeft = Math.max(8, window.innerWidth - drag.width - 8);
      const maxTop = Math.max(8, window.innerHeight - drag.height - 8);
      panel.style.left = Math.round(clamp(drag.left + dx, 8, maxLeft)) + 'px';
      panel.style.top = Math.round(clamp(drag.top + dy, 8, maxTop)) + 'px';
    });

    const finishDrag = (event) => {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      const moved = drag.moved;
      const pointerId = drag.id;
      drag = null;
      try {
        head.releasePointerCapture(pointerId);
      } catch (err) {
        /* ignore */
      }
      panel.classList.remove('is-dragging');
      if (!moved) return;

      state.panelPinned = true;
      state.panelPos = {
        left: parseFloat(panel.style.left) || 0,
        top: parseFloat(panel.style.top) || 0
      };
      storage.write('panelPinned', true);
      storage.write('panelPos', state.panelPos);
    };

    on(head, 'pointerup', finishDrag);
    on(head, 'pointercancel', finishDrag);
    on(head, 'lostpointercapture', finishDrag);

    on(head, 'dblclick', (event) => {
      if (event.target.closest('button, a')) return;
      publicUi.resetPanel();
      flashStatus('面板已恢复自动跟随');
    });

    // 标签栏键盘导航（Shadow DOM 内要用 shadow.activeElement）
    on(dom.tabs, 'keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const buttons = [...dom.tabs.querySelectorAll('.eh-tab')];
      const index = buttons.indexOf(dom.shadow.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next.focus();
      activateTab(next.dataset.feature);
    });
  }

  function flashStatus(text, duration) {
    if (!dom.status) return;
    clearTimeout(statusTimer);
    dom.status.textContent = text;
    statusTimer = window.setTimeout(() => {
      dom.status.textContent = '运行中 · v' + VERSION;
    }, duration || 2400);
  }

  /* =========================================================================
   * 7. 路由钩子（SPA 内部跳转不会触发页面加载）
   * ========================================================================= */

  const route = (() => {
    const subscribers = new Set();
    const originals = new Map();
    const PATCHED = '__eclesiarHelperPatched';
    let current = location.pathname + location.search + location.hash;

    function read() {
      return location.pathname + location.search + location.hash;
    }

    /**
     * 游戏把当前语言拼在路径首段（/zh-CN/market/12），跳转目标必须跟着带，
     * 否则游戏路由认不出这个地址，会把玩家弹回首页。
     * 首段是不是语言：先和 <html lang> 对（en / en-US 两种写法都算），
     * 再看是否符合两位语言码格式，都不像就当它是普通页面路径。
     */
    function routePrefix() {
      const first = String(location.pathname.split('/')[1] || '');
      if (!first) return '';
      const lower = first.toLowerCase();
      const docLang = String(document.documentElement.lang || '').toLowerCase();
      if (docLang && (lower === docLang || lower === docLang.split('-')[0])) return '/' + first;
      if (/^[a-z]{2}([-_][a-z]{2})?$/.test(lower)) return '/' + first;
      return '';
    }

    function emit() {
      const next = read();
      if (next === current) return;
      current = next;
      [...subscribers].forEach((fn) => {
        try {
          fn(current);
        } catch (err) {
          warn('路由订阅回调异常', err);
        }
      });
    }

    function patch() {
      ['pushState', 'replaceState'].forEach((name) => {
        const original = history[name];
        if (typeof original !== 'function' || original[PATCHED]) return;
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          emit();
          return result;
        };
        wrapped[PATCHED] = true;
        originals.set(name, { original, wrapped });
        try {
          history[name] = wrapped;
        } catch (err) {
          warn('无法包装 history.' + name, err);
        }
      });

      on(window, 'popstate', emit);
      on(window, 'hashchange', emit);
    }

    patch();

    /**
     * 在 SPA 内前进到 path。
     * React Router 底下的 history 库靠 state.idx 判断是不是一次新的导航，
     * idx 不变它会直接忽略这次 popstate，所以先加一再派发。
     */
    function pushTo(path) {
      try {
        const next = Object.assign({}, history.state);
        if (typeof next.idx === 'number') next.idx += 1;
        history.pushState(next, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: next }));
        return true;
      } catch (err) {
        warn('SPA 跳转失败', err);
        return false;
      }
    }

    /** 同上，但替换当前这条历史记录（中转页不留在历史里）。 */
    function replaceTo(path) {
      try {
        const next = Object.assign({}, history.state);
        if (typeof next.idx === 'number') next.idx += 1;
        history.replaceState(next, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: next }));
        return true;
      } catch (err) {
        warn('SPA 替换失败', err);
        return false;
      }
    }

    /**
     * 同一个页面只换 id（/market/17 → /18、/monetary-market/2 → /3）时，
     * 游戏组件不会因为路由参数变化重新挂载，直接 pushState 只会让地址变、页面不动。
     * 绕法：先跳到 dashboard 把当前页面卸掉（结构变化，路由会正常重渲染），
     * 等它渲染出来再 replaceState 成目标（再变化一次），两段都不刷新，
     * 中转页也会被 replace 掉，不会多留一条历史。
     *
     * 「渲染出来」用节点增删判断，不靠固定等待：dashboard 一画完就换目标，
     * 正常只要一百多毫秒；600ms 还没动静就用兜底时钟。
     * 换完不再回头校验 URL —— 目标若是玩家所在国，游戏会自己把地址改成不带 id 的
     * /market，校验反而会误判成失败再整页刷一次。
     */
    function detour(target) {
      const home = routePrefix() + '/dashboard';
      if (location.pathname === home) {
        location.assign(target);
        return true;
      }
      if (!pushTo(home)) {
        location.assign(target);
        return true;
      }

      // 同样盯 body：dashboard 渲染可能把 #app 换掉，观察旧节点会一直等不到信号
      const shell = document.body;

      let mutating = 0;
      let done = false;
      let timer = 0;

      function finish() {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        if (!replaceTo(target)) location.assign(target);
      }

      const observer = new MutationObserver((records) => {
        for (let i = 0; i < records.length; i += 1) {
          const record = records[i];
          if (record.type !== 'childList') continue;
          mutating += record.addedNodes.length + record.removedNodes.length;
        }
        if (mutating >= 10) finish();
      });

      try {
        observer.observe(shell, { childList: true, subtree: true });
      } catch (err) {
        /* 观察不了就直接靠兜底时钟 */
      }
      timer = setTimeout(finish, 300);
      return true;
    }

    return {
      get current() {
        return current;
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      /**
       * 跳到游戏内页面（例如 /market/{country_id}、/monetary-market/{currency_id}）。
       * 先试 SPA 内切换：pushState 后用 popstate 交给游戏自己的路由渲染，
       * 行情缓存与面板状态都能留住，比整页刷新快得多；游戏没接住时退回整页跳转。
       * 已经是同一个页面、只换 id 的（/market/17 → /18）游戏不会重新渲染，直接整页跳。
       */
      goto(path) {
        const raw = String(path || '');
        if (!raw) return false;
        const prefix = routePrefix();
        const target =
          prefix && raw.charAt(0) === '/' && !raw.startsWith(prefix + '/') ? prefix + raw : raw;
        log('跳转', '语言前缀 ' + (prefix || '（无）'), '→', target);
        if (target === read()) return false;

        /*
         * 同一个路由只换 id（/monetary-market/5 → /12、/market/17 → /18）时，
         * 游戏对应的 React 组件不会因为参数变化重新挂载，pushState 后地址变了页面不动。
         * 这种交给 detour 走一趟 dashboard 中转，两段都是结构变化，都不用刷新。
         * 段数不同的（/market → /market/17）本身就是结构变化，直接 SPA。
         */
        const shapeOf = (value) =>
          value
            .split('/')
            .map((seg) => (/^\d+$/.test(seg) ? '*' : seg))
            .join('/');
        if (shapeOf(target.split(/[?#]/)[0]) === shapeOf(location.pathname)) {
          log('跳转', '同一页面只换 id，走 dashboard 中转');
          return detour(target);
        }

        /*
         * 直接用 body 当观察目标：游戏换页面时可能把 #app 整个替换掉，
         * 持有旧引用就永远测不到变化，会被误判成「游戏没响应」然后整页刷。
         * 插件自己的界面在 Shadow DOM 里，不计入 innerHTML，不会干扰判断。
         */
        const shell = document.body;
        // 用整页正文长度当指纹：游戏切换页面时这里一定会变，够判断它有没有接住
        const mark = () => shell.innerHTML.length;
        const before = mark();
        // 跳之前的位置，用来判断游戏有没有把地址改回原处
        const fromUrl = read();

        if (!pushTo(target)) {
          location.assign(target);
          return true;
        }

        /*
         * 判定「游戏有没有接住」：不猜固定时长，改成盯着页面变化。
         * 结构变化的跳转（/market → /market/17、市场 ↔ 货币市场）游戏渲染新页面时 DOM 一定动，
         * 给 3 秒窗口，期间有变化就算接管；真的一动不动才整页跳。
         */
        // 只数节点的增删，忽略纯文本刷新：货币市场页的价格跳动不该算「页面切换了」
        let mutating = 0;
        let observer = null;
        try {
          observer = new MutationObserver((records) => {
            for (let i = 0; i < records.length; i += 1) {
              const record = records[i];
              if (record.type !== 'childList') continue;
              mutating += record.addedNodes.length + record.removedNodes.length;
            }
          });
          observer.observe(shell, { childList: true, subtree: true });
        } catch (err) {
          observer = null;
        }

        const stopWatching = () => {
          if (observer) observer.disconnect();
          observer = null;
        };

        const deadline = Date.now() + 3000;
        const watch = () => {
          const now = read();
          if (now !== target) {
            // 游戏把地址改回原处 = 它不接受这次跳转，别再干等，直接整页跳
            if (now === fromUrl) {
              stopWatching();
              log('跳转', '游戏把地址改回原处，改用整页跳转');
              location.assign(target);
              return;
            }
            // 游戏自己补了参数 / 去了别处，交给它
            stopWatching();
            return;
          }
          // 行情页会不停刷新节点，阈值给宽一点，别把「价格跳动」当成「页面换了」
          if (mutating >= 200 || Math.abs(mark() - before) > before * 0.05) {
            stopWatching();
            log('跳转', '游戏路由已接管，未刷新');
            return;
          }
          if (Date.now() >= deadline) {
            stopWatching();
            log('跳转', '游戏路由没响应，改用整页跳转');
            location.assign(target);
            return;
          }
          setTimeout(watch, 250);
        };
        setTimeout(watch, 300);
        return true;
      },
      destroy() {
        originals.forEach((entry, name) => {
          // 只还原仍是我们包装的那一层，避免覆盖游戏后来追加的补丁
          if (history[name] !== entry.wrapped) return;
          try {
            history[name] = entry.original;
          } catch (err) {
            /* ignore */
          }
        });
        originals.clear();
        subscribers.clear();
      }
    };
  })();

  /* =========================================================================
   * 8. 对外 UI 控制（内置功能与后续模块共用）
   * ========================================================================= */

  const publicUi = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!state.open),
    isOpen: () => state.open,
    position: () => ballPosition(),
    /** 跳到游戏内页面（优先 SPA 内切换，失败退回整页跳转） */
    navigate: (path) => route.goto(path),
    /** 功能模块改变自身内容高度后调用，重新测量并保持顶部位置 */
    reposition() {
      if (state.open) placePanel({ measure: true, keepTop: true });
    },
    resetBall() {
      state.ball = { ...DEFAULT_BALL };
      storage.write('ball', state.ball);
      applyBall();
      if (state.open) placePanel();
    },
    resetPanel() {
      state.panelPinned = false;
      state.panelPos = null;
      storage.write('panelPinned', false);
      storage.remove('panelPos');
      if (state.open) placePanel();
    },
    resetAll() {
      // API 密钥是玩家自己生成、专门给插件用的，不随界面设置一起清掉
      const keepKey = apiKey.value;
      storage.clear();
      if (keepKey) apiKey.set(keepKey);
      state.ball = { ...DEFAULT_BALL };
      state.panelPinned = false;
      state.panelPos = null;
      applyBall();
      if (state.open) placePanel();
    }
  };

  /**
   * 行尾的跳转按钮：点击先收起面板，再让游戏路由切到对应页面。
   * 只读数据 + 用户主动点击，不替玩家做任何游戏内操作。
   */
  function buildGoButton(title, go, intent) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eh-go';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    // 右箭头：语义是「前往」，不要用外链 / 分享那种方框箭头
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M3.4 8h9.2M8.9 4.1 12.8 8l-3.9 3.9" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>';
    on(btn, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 商品 / 品质不在游戏 URL 里，先把意图写进 sessionStorage，落地后再消费
      if (intent) marketJump.remember(intent);
      publicUi.close();
      route.goto(go);
    });
    return btn;
  }

  /* =========================================================================
   * 9. 内置功能
   * ========================================================================= */

  /* -------- 9.0 数据访问层：接口级缓存与请求去重 -------- */

  /**
   * 请求层各类数据的 TTL（毫秒）。
   * 行情类（币种挂单、各国市场挂单、地区清单）统一 10 分钟，不做后台续期；
   * 账号 / 公开资料 10 秒（旅行、换国籍、升级都会改，且只在读取时触发）；
   * 岗位页沿用 2 分钟（改门槛只补缺失页）；
   * page 表示「一次页面只拉一次」，destroy 前不过期。
   */
  const API_TTL = {
    coin: 10 * 60 * 1000,
    goods: 10 * 60 * 1000,
    regions: 10 * 60 * 1000,
    jobPage: 2 * 60 * 1000,
    // 账号与公开资料描述的是玩家自身状态（旅行 / 换国籍 / 升级都会改），
    // 只在功能读取时触发、不轮询，所以给 10 秒也不会变成高频请求
    account: 10 * 1000,
    profile: 10 * 1000,
    usage: 60 * 1000,
    page: Infinity
  };
  /** 普通失败后的重试冷却：错误不写缓存，只在这段时间内不再问同一个 key。 */
  const API_COOLDOWN = 60 * 1000;
  /** 429 多半是当日额度用尽，冷却久一点，别把额度打光。 */
  const API_COOLDOWN_429 = 5 * 60 * 1000;

  /**
   * 接口缓存（请求层）。key 只由「接口 + 参数」决定，不认功能：
   * 谁能共享就给谁共享，功能层不再自己维护接口缓存。
   *
   * - ensure：命中即返回；同 key 有 in-flight 就合并；冷却期内直接失败
   * - refresh：绕过 TTL 重新请求（给「刷新」按钮用），失败保留旧值并标 stale
   * - peek / fresh：只读查询，fresh 才带 TTL 判断（判「要不要发请求」一律用 fresh）
   * - invalidate：按前缀删除（凭据变化、明确丢弃旧数据）
   * - clear：destroy / 换凭据时整体清空
   *
   * 不透传调用方的 signal：请求可能被多个面板共享，取消只意味着「不再发起新 key」，
   * 已经发出的请求不会被某个调用方 abort；超时由 apiClient.call 负责。
   * 也不起定时器：只被动响应 ensure / refresh，不轮询。
   */
  const apiCache = (() => {
    /** key → { key, value, at, ttl, empty, emptyPick, stale, namespace, loader } */
    const entries = new Map();
    /** key → { at, code, retryAt }；错误不写缓存，只留失败时间用来冷却。 */
    const failures = new Map();
    /** key → promise */
    const inflight = new Map();
    const counters = { hit: 0, join: 0, miss: 0, cooldown: 0, refresh: 0, fail: 0, request: 0 };
    /**
     * 失效代数：`invalidate(prefix)` 给该前缀加一代，`clear()` 把 epoch 整体加一。
     * 请求发出时记下当时的代数，回来时对不上就把结果丢掉——
     * 否则「换凭据 / 丢弃旧数据」之后，在途的旧请求会把自己的结果又写回缓存。
     * 按前缀记而不是按 key 记：在途请求的 key 还没进缓存，按 key 记不上。
     */
    let epoch = 0;
    const prefixStamps = new Map();
    const stampOf = (item) => {
      let signature = String(epoch);
      prefixStamps.forEach((value, prefix) => {
        if (item.indexOf(prefix) === 0) signature += '|' + prefix + '@' + value;
      });
      return signature;
    };

    /** 参数按名排序后拼接，保证同样的调用得到同一个 key。 */
    function key(path, params) {
      const base = String(path == null ? '' : path);
      if (!params) return base;
      const pairs = Object.keys(params)
        .filter((name) => params[name] !== undefined && params[name] !== null)
        .sort()
        .map((name) => name + '=' + String(params[name]));
      return pairs.length ? base + '?' + pairs.join('&') : base;
    }

    /** ttl 可以写数字，也可以写 API_TTL 的键名。 */
    const ttlOf = (opts) => {
      const raw = opts && opts.ttl;
      if (typeof raw === 'number') return raw;
      if (typeof raw === 'string' && API_TTL[raw] != null) return API_TTL[raw];
      return API_TTL.goods;
    };

    /** 空结果（无挂单 / 无地区 / 空岗位页）也是有效缓存，与「未加载」严格区分。 */
    const isEmpty = (value, opts) => {
      const pick = opts && opts.empty;
      if (typeof pick === 'function') return pick(value) === true;
      return Array.isArray(value) && value.length === 0;
    };

    /**
     * 凭据问题不冷却（补到凭据后要能立刻重试）；
     * 调用方显式给的 cooldown 优先；429 冷却 5 分钟；其它默认 60 秒。
     */
    const cooldownOf = (err, opts) => {
      const code = err && err.code;
      if (code === 'NO_TOKEN' || code === 'UNAUTHORIZED') return 0;
      const custom = opts && opts.cooldown;
      if (typeof custom === 'number') return custom;
      if (code === 'HTTP' && String(err && err.message) === 'HTTP_429') return API_COOLDOWN_429;
      return API_COOLDOWN;
    };

    /* ---- key 级订阅：缓存写入 / 删除后通知（学 SWR 的 cache 订阅） ---- */

    /**
     * 订阅「某个 key 的缓存变了」。test 可以是前缀字符串，也可以是 (key) => boolean；
     * 回调收到本帧内变化的 key 数组（同一帧里几十个 key 只叫一次）。
     * 只用来驱动界面重绘：回调里只读数据，别再发请求，否则容易自己触发自己。
     */
    const watchers = new Set();
    const pendingKeys = new Set();
    let flushQueued = false;

    function notifyWatchers() {
      flushQueued = false;
      if (!pendingKeys.size) return;
      const changed = [...pendingKeys];
      pendingKeys.clear();
      if (!watchers.size) return;
      watchers.forEach((item) => {
        let hit = null;
        for (let i = 0; i < changed.length; i += 1) {
          if (!item.test(changed[i])) continue;
          if (!hit) hit = [];
          hit.push(changed[i]);
        }
        if (!hit) return;
        try {
          item.fn(hit);
        } catch (err) {
          warn('缓存订阅回调异常', err);
        }
      });
    }

    /** 按帧合并：后台标签页里 rAF 会暂停，回退到 setTimeout（界面不可见，语义不变）。 */
    function emitKey(item) {
      pendingKeys.add(item);
      if (flushQueued) return;
      flushQueued = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(notifyWatchers);
      else setTimeout(notifyWatchers, 16);
    }

    function watch(test, fn) {
      if (typeof fn !== 'function') return () => {};
      const match =
        typeof test === 'function'
          ? test
          : (item) => item.indexOf(String(test == null ? '' : test)) === 0;
      const item = { test: match, fn };
      watchers.add(item);
      return () => watchers.delete(item);
    }

    const writeEntry = (key, value, loader, opts) => {
      const entry = {
        key,
        value,
        at: Date.now(),
        ttl: ttlOf(opts),
        empty: isEmpty(value, opts),
        // 空结果谓词留着：refresh 不传 opts 时要沿用同一套判定，别退回默认规则
        emptyPick: opts && typeof opts.empty === 'function' ? opts.empty : null,
        stale: false,
        namespace: (opts && opts.namespace) || '',
        loader
      };
      entries.set(key, entry);
      failures.delete(key);
      emitKey(key);
      return entry;
    };

    /** 只清掉自己登记的那个 promise，避免把同 key 后续新起的请求一起抹掉。 */
    const settle = (key, pending) => {
      if (inflight.get(key) === pending) inflight.delete(key);
    };

    /**
     * 真正发一次请求。loader 收到 key（便于由 key 反解参数），返回 Promise。
     * 失败不写缓存；已有旧值时只标 stale，不删除（面板继续显示上次成功的数据）。
     */
    function run(key, loader, opts, mode) {
      const mine = stampOf(key);
      counters.request += 1;
      if (DEBUG) log('apiCache', mode, key, '请求 #' + counters.request);

      let pending;
      pending = Promise.resolve()
        .then(() => loader(key))
        .then(
          (value) => {
            settle(key, pending);
            // 期间被 invalidate / clear 过（换凭据 / destroy）：结果作废，别写回去
            if (mine !== stampOf(key)) return null;
            const entry = writeEntry(key, value, loader, opts);
            if (DEBUG) log('apiCache', mode, key, '成功', entry.empty ? '（空结果）' : '');
            return entry;
          },
          (err) => {
            settle(key, pending);
            if (mine !== stampOf(key)) throw err;
            const wait = cooldownOf(err, opts);
            if (wait > 0) {
              const now = Date.now();
              failures.set(key, { at: now, code: (err && err.code) || '', retryAt: now + wait });
            }
            counters.fail += 1;
            const previous = entries.get(key);
            if (previous) previous.stale = true;
            if (DEBUG) {
              log(
                'apiCache',
                mode,
                key,
                '失败',
                (err && err.code) || err,
                wait > 0 ? '冷却 ' + Math.round(wait / 1000) + 's' : '不冷却',
                previous ? '（保留旧值）' : ''
              );
            }
            throw err;
          }
        );
      inflight.set(key, pending);
      return pending;
    }

    /**
     * 命中即返回（返回缓存条目 { value, at, empty, stale }，不是裸载荷）；
     * 同 key 有 in-flight 就合并；冷却期内直接失败，不重复问同一个 key。
     */
    function ensure(key, loader, opts) {
      const cached = entries.get(key);
      if (cached && Date.now() - cached.at < cached.ttl) {
        counters.hit += 1;
        if (DEBUG) log('apiCache', 'ensure', key, 'hit');
        return Promise.resolve(cached);
      }
      const joining = inflight.get(key);
      if (joining) {
        counters.join += 1;
        if (DEBUG) log('apiCache', 'ensure', key, 'join');
        return joining;
      }
      const blocked = failures.get(key);
      if (blocked && Date.now() < blocked.retryAt) {
        counters.cooldown += 1;
        if (DEBUG) log('apiCache', 'ensure', key, 'cooldown');
        const error = new Error('COOLDOWN');
        error.code = 'COOLDOWN';
        error.reason = blocked.code;
        error.retryAt = blocked.retryAt;
        return Promise.reject(error);
      }
      counters.miss += 1;
      return run(key, loader, opts, 'ensure');
    }

    /**
     * 忽略 TTL 重新请求；已有 in-flight 就复用（不并发第二次），失败不删旧值。
     * 不传 opts 时沿用这个 key 上次登记的口径（ttl / empty 谓词 / namespace），
     * 免得「少传一个 opts 就把 10 秒的账号缓存改写成 10 分钟」这类静默漂移。
     * 批量刷新由各功能自己按并发跑（要进度与失败计数），这里不做批量入口。
     */
    function refresh(key, loader, opts) {
      const joining = inflight.get(key);
      if (joining) {
        counters.join += 1;
        if (DEBUG) log('apiCache', 'refresh', key, 'join');
        return joining;
      }
      const previous = entries.get(key);
      const pick = loader || (previous || {}).loader;
      if (typeof pick !== 'function') {
        const error = new Error('NO_LOADER');
        error.code = 'NO_LOADER';
        return Promise.reject(error);
      }
      const effective =
        opts ||
        (previous
          ? { ttl: previous.ttl, namespace: previous.namespace, empty: previous.emptyPick || undefined }
          : undefined);
      counters.refresh += 1;
      return run(key, pick, effective, 'refresh');
    }

    /**
     * 按前缀删除（下次 ensure 才会重新请求）。这是「丢弃旧数据」，
     * 只适用于凭据变化 / 明确要求重抓；面板上的「刷新」请用 refresh*。
     */
    function invalidate(prefix) {
      const wanted = prefix == null || prefix === '' ? null : String(prefix);
      let removed = 0;
      const dropped = [];
      // 先换代：在途请求回来时会因此丢弃结果，否则会把刚删掉的数据写回缓存
      if (wanted) prefixStamps.set(wanted, (prefixStamps.get(wanted) || 0) + 1);
      else epoch += 1;
      [...entries.keys()].forEach((item) => {
        if (wanted && item.indexOf(wanted) !== 0) return;
        entries.delete(item);
        dropped.push(item);
        removed += 1;
      });
      [...failures.keys()].forEach((item) => {
        if (wanted && item.indexOf(wanted) !== 0) return;
        failures.delete(item);
      });
      // 删掉的条目也要通知：订阅方得知道「这份数据没了」，而不是继续显示旧快照
      dropped.forEach(emitKey);
      if (DEBUG && removed) log('apiCache', 'invalidate', wanted || '*', '删除 ' + removed + ' 条');
      return removed;
    }

    /**
     * 整体清空：destroy() 用。
     * keepPage=true 时保留页面级条目（国家清单 / 税率），凭据变化走这个——
     * 那些数据与凭据无关，没必要因为换了密钥再拉一遍。
     */
    function clear(keepPage) {
      const kept = new Map();
      const dropped = [];
      entries.forEach((entry, item) => {
        // keepPage 时页面级条目（国家清单 / 税率）与凭据无关，保留且不通知
        if (keepPage && entry.ttl === Infinity) kept.set(item, entry);
        else dropped.push(item);
      });
      epoch += 1;
      prefixStamps.clear();
      entries.clear();
      kept.forEach((entry, item) => entries.set(item, entry));
      failures.clear();
      inflight.clear();
      dropped.forEach(emitKey);
      // 整体清空（destroy）时连计数一起归零，方便验收「destroy 后 stats 归零」
      if (!keepPage) resetStats();
    }

    /** 只读查询，不触发请求。 */
    function peek(item) {
      const entry = entries.get(item);
      if (!entry) return null;
      return { value: entry.value, at: entry.at, empty: entry.empty, stale: entry.stale };
    }

    /**
     * 该 key 是否已有**未过期**的缓存（只读，不触发请求）。
     * 与 peek 的区别：peek 只看「有没有这条」，判「要不要发请求」必须用这个，
     * 否则过期条目会被当成命中，明明会发请求却不计入请求上限。
     */
    function fresh(item) {
      const entry = entries.get(item);
      return Boolean(entry) && Date.now() - entry.at < entry.ttl;
    }

    /** 该 key 是否已有在途请求（「刷新」想在它结束后补一次时用）。 */
    function busy(item) {
      return inflight.has(item);
    }

    function stats() {
      return {
        hit: counters.hit,
        join: counters.join,
        miss: counters.miss,
        cooldown: counters.cooldown,
        refresh: counters.refresh,
        fail: counters.fail,
        /** 逻辑请求数（apiClient 内部兜底重试之前），用来对比迁移前后的请求量。 */
        request: counters.request,
        entries: entries.size,
        failures: failures.size,
        inflight: inflight.size,
        /** 订阅方数量：用来确认面板 destroy 后没有残留订阅。 */
        watchers: watchers.size
      };
    }

    /** 一轮结束后打一条汇总（?eh-debug=1 下用来对比迁移前后的真实请求数）。 */
    function report(label) {
      const snapshot = stats();
      if (DEBUG) {
        log(
          'apiCache 汇总' + (label ? '（' + label + '）' : ''),
          '请求 ' + snapshot.request,
          'hit ' + snapshot.hit,
          'join ' + snapshot.join,
          'miss ' + snapshot.miss,
          'cooldown ' + snapshot.cooldown,
          'refresh ' + snapshot.refresh,
          'fail ' + snapshot.fail,
          '条目 ' + snapshot.entries
        );
      }
      return snapshot;
    }

    /** 调试用：计数清零，便于只看某一轮。 */
    function resetStats() {
      Object.keys(counters).forEach((name) => {
        counters[name] = 0;
      });
      return stats();
    }

    return {
      key,
      peek,
      fresh,
      busy,
      ensure,
      refresh,
      invalidate,
      clear,
      /** 订阅 key 级缓存变化（前缀或谓词）；返回退订函数，必须挂到 ctx.onDestroy。 */
      watch,
      stats,
      report,
      resetStats
    };
  })();

  /* -------- 9.1 汇率总览：接口、凭据与计算 -------- */

  const FX_API = 'https://api.eclesiar.com';
  const FX_CONCURRENCY = 3;
  const FX_GAP = 60;
  /** 游戏内的接口文档页，也可以在这里自己生成 / 管理 API 密钥。 */
  const API_DOC_URL = 'https://app.eclesiar.com/zh-CN/api';

  /**
   * 专用 API 密钥。
   * 游戏对公开数据的每日查询按账号限次，插件自己发起的请求改用自己的密钥，
   * 就不会挤占玩家在游戏里操作时的那份额度。
   * 这是玩家主动生成、专门给第三方查询用的密钥（与登录 JWT 无关），
   * 允许保存在 localStorage；只存本地，不打日志、不上报。
   */
  const apiKey = (() => {
    const KEY = 'api-key';
    const PATTERN = /^eclesiar_[a-z0-9]+_[A-Za-z0-9]{8,}$/i;
    let value = '';
    try {
      const saved = storage.read(KEY, '');
      if (typeof saved === 'string' && PATTERN.test(saved.trim())) value = saved.trim();
    } catch (err) {
      /* ignore */
    }

    return {
      get value() {
        return value;
      },
      get active() {
        return Boolean(value);
      },
      /** 形如 eclesiar_prod_848a…60c4，仅用于界面展示。 */
      get masked() {
        if (!value) return '';
        return value.length <= 20 ? value : value.slice(0, 14) + '…' + value.slice(-4);
      },
      /** 判断一段凭据是不是 API 密钥（用于区分游戏自己的登录 JWT）。 */
      looksLike(raw) {
        return PATTERN.test(String(raw == null ? '' : raw).trim());
      },
      set(raw) {
        const next = String(raw == null ? '' : raw).trim();
        if (!PATTERN.test(next)) return false;
        value = next;
        storage.write(KEY, next);
        return true;
      },
      clear() {
        value = '';
        storage.remove(KEY);
      }
    };
  })();

  /**
   * 内置中文国名 + 国旗 emoji（按法币代码索引）。
   * 游戏本身没有中文翻译，只给英文国名；这里按代码内置一份，随插件分发。
   * 中文名直接显示在列表里；emoji 只在 summary 的 avatar 图缺失 / 加载失败时兜底，
   * 接口以后新增货币导致查不到时，就只显示英文国名，不影响功能。
   */
  const FX_LOCALES = {
    GBP: ['英国', '🇬🇧'],
    USD: ['美国', '🇺🇸'],
    MXN: ['墨西哥', '🇲🇽'],
    COP: ['哥伦比亚', '🇨🇴'],
    PEN: ['秘鲁', '🇵🇪'],
    BRL: ['巴西', '🇧🇷'],
    CLP: ['智利', '🇨🇱'],
    ARS: ['阿根廷', '🇦🇷'],
    IEP: ['爱尔兰', '🇮🇪'],
    FRF: ['法国', '🇫🇷'],
    PTE: ['葡萄牙', '🇵🇹'],
    ESP: ['西班牙', '🇪🇸'],
    DEM: ['德国', '🇩🇪'],
    SEK: ['瑞典', '🇸🇪'],
    ITL: ['意大利', '🇮🇹'],
    PLN: ['波兰', '🇵🇱'],
    LTL: ['立陶宛', '🇱🇹'],
    SIT: ['斯洛文尼亚', '🇸🇮'],
    HRK: ['克罗地亚', '🇭🇷'],
    BAM: ['波黑', '🇧🇦'],
    RSD: ['塞尔维亚', '🇷🇸'],
    MKD: ['北马其顿', '🇲🇰'],
    ALL: ['阿尔巴尼亚', '🇦🇱'],
    GRD: ['希腊', '🇬🇷'],
    HUF: ['匈牙利', '🇭🇺'],
    RON: ['罗马尼亚', '🇷🇴'],
    BGN: ['保加利亚', '🇧🇬'],
    TRY: ['土耳其', '🇹🇷'],
    UAH: ['乌克兰', '🇺🇦'],
    RUB: ['俄罗斯', '🇷🇺'],
    GEL: ['格鲁吉亚', '🇬🇪'],
    NIS: ['以色列', '🇮🇱'],
    EGP: ['埃及', '🇪🇬'],
    ZAR: ['南非', '🇿🇦'],
    SAR: ['沙特阿拉伯', '🇸🇦'],
    IQD: ['伊拉克', '🇮🇶'],
    IRR: ['伊朗', '🇮🇷'],
    PKR: ['巴基斯坦', '🇵🇰'],
    INR: ['印度', '🇮🇳'],
    CNY: ['中国', '🇨🇳'],
    JPY: ['日本', '🇯🇵'],
    KRW: ['韩国', '🇰🇷'],
    IDR: ['印度尼西亚', '🇮🇩'],
    AUD: ['澳大利亚', '🇦🇺'],
    PHP: ['菲律宾', '🇵🇭'],
    // 以下为常见货币的预留条目，接口真用到时无需再改代码
    CHF: ['瑞士', '🇨🇭'],
    CAD: ['加拿大', '🇨🇦'],
    NZD: ['新西兰', '🇳🇿'],
    NOK: ['挪威', '🇳🇴'],
    DKK: ['丹麦', '🇩🇰'],
    CZK: ['捷克', '🇨🇿'],
    ISK: ['冰岛', '🇮🇸'],
    THB: ['泰国', '🇹🇭'],
    VND: ['越南', '🇻🇳'],
    MYR: ['马来西亚', '🇲🇾'],
    SGD: ['新加坡', '🇸🇬'],
    HKD: ['中国香港', '🇭🇰'],
    MOP: ['中国澳门', '🇲🇴'],
    TWD: ['中国台湾', '🇹🇼']
  };

  const fxLocale = (code) => FX_LOCALES[code] || null;

  /** avatar 可能是绝对地址，也可能是以 / 开头的相对路径（相对接口域名）。 */
  function fxAvatarUrl(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    try {
      const base = value.charAt(0) === '/' && value.charAt(1) !== '/' ? FX_API : location.href;
      const url = new URL(value, base);
      // data: 只是为了本地演示能内联小图标，真实接口返回的是普通图片地址
      if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'data:') {
        return url.href;
      }
      return '';
    } catch (err) {
      return '';
    }
  }

  const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );

  const fxSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 统一请求出口与凭据。
   * 插件所有数据请求都从这里发出（行情、账号、地区、岗位、设置页用量都一样），
   * 不只是「市场接口」：`/market` 只是其中一个接口前缀。
   * 登录 JWT 只从游戏自己发往 api.eclesiar.com 的请求里读取，仅保存在内存中：
   * 不写 localStorage、不打日志、不上报。
   * 若用户在「设置」页保存了专用 API 密钥，则所有插件请求优先用它。
   */
  const apiClient = (() => {
    let loginToken = '';
    let seenAuth = false;
    let expired = false;
    let apiExpired = false;
    let installed = false;
    const restores = [];
    /** 第一次拿到登录凭据时通知订阅者（市场页标注靠它补画，不用轮询）。 */
    const authListeners = new Set();

    const notifyAuth = () => {
      [...authListeners].forEach((fn) => {
        try {
          fn();
        } catch (err) {
          /* 订阅方自己出错不影响凭据捕获 */
        }
      });
    };

    /** 兼容裸主机、大写主机、协议相对路径等写法；只看主机名。 */
    const isApiUrl = (url) => {
      try {
        return new URL(String(url), location.href).hostname === 'api.eclesiar.com';
      } catch (err) {
        return false;
      }
    };

    const remember = (raw) => {
      if (typeof raw !== 'string') return;
      const value = raw.trim();
      if (!value) return;
      // 见过凭据头就够了：格式不符时也能在界面上说清楚，而不是让用户猜
      seenAuth = true;
      if (value.length < 16 || !/^bearer\s+\S+$/i.test(value)) return;
      // 插件自己带着专用密钥发的请求也会经过这里，别把 API 密钥当成登录凭据
      if (apiKey.looksLike(value.replace(/^bearer\s+/i, ''))) return;
      if (value === loginToken) return;
      loginToken = value;
      expired = false;
      log('已捕获登录凭据（仅内存）');
      notifyAuth();
    };

    const scanHeaders = (headers) => {
      if (!headers) return;
      try {
        if (typeof Headers === 'function' && headers instanceof Headers) {
          remember(headers.get('authorization'));
          return;
        }
        if (Array.isArray(headers)) {
          headers.forEach((pair) => {
            if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'authorization') {
              remember(pair[1]);
            }
          });
          return;
        }
        if (typeof headers === 'object') {
          Object.keys(headers).forEach((key) => {
            if (key.toLowerCase() === 'authorization') remember(headers[key]);
          });
        }
      } catch (err) {
        /* 读不到就算了，绝不因为抓凭据影响页面自己的请求 */
      }
    };

    function install() {
      if (installed) return;
      installed = true;

      const nativeFetch = window.fetch;
      if (typeof nativeFetch === 'function') {
        const wrapped = function (input, init) {
          try {
            const url =
              typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
            if (isApiUrl(url)) {
              if (init && init.headers) scanHeaders(init.headers);
              else if (input && input.headers) scanHeaders(input.headers);
            }
          } catch (err) {
            /* ignore */
          }
          return nativeFetch.apply(this, arguments);
        };
        window.fetch = wrapped;
        restores.push(() => {
          if (window.fetch === wrapped) window.fetch = nativeFetch;
        });
      }

      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (proto && typeof proto.open === 'function' && typeof proto.setRequestHeader === 'function') {
        const nativeOpen = proto.open;
        const nativeSet = proto.setRequestHeader;

        const wrappedOpen = function (method, url) {
          try {
            this.__ehApiUrl = String(url);
          } catch (err) {
            /* ignore */
          }
          return nativeOpen.apply(this, arguments);
        };

        const wrappedSet = function (name, value) {
          try {
            if (isApiUrl(this.__ehApiUrl) && String(name).toLowerCase() === 'authorization') {
              remember(String(value));
            }
          } catch (err) {
            /* ignore */
          }
          return nativeSet.apply(this, arguments);
        };

        proto.open = wrappedOpen;
        proto.setRequestHeader = wrappedSet;
        restores.push(() => {
          if (proto.open === wrappedOpen) proto.open = nativeOpen;
          if (proto.setRequestHeader === wrappedSet) proto.setRequestHeader = nativeSet;
        });
      }
    }

    function uninstall() {
      restores.splice(0).forEach((fn) => {
        try {
          fn();
        } catch (err) {
          /* ignore */
        }
      });
      installed = false;
      loginToken = '';
      seenAuth = false;
      expired = false;
      apiExpired = false;
    }

    const normalize = (err) => {
      if (err && err.name === 'TimeoutError') {
        const error = new Error('请求超时');
        error.code = 'TIMEOUT';
        return error;
      }
      return err;
    };

    /**
     * 插件所有公开数据请求的统一出口。
     * 默认优先使用专用 API 密钥；生成密钥这类账号操作必须用登录凭据（opts.login）。
     */
    async function call(path, options) {
      const opts = options || {};
      const useLogin = opts.login === true;
      const auth = useLogin ? loginToken : apiKey.active ? 'Bearer ' + apiKey.value : loginToken;
      if (!auth) {
        const error = new Error('NO_TOKEN');
        error.code = 'NO_TOKEN';
        throw error;
      }
      const usingApiKey = !useLogin && apiKey.active;

      const headers = { accept: 'application/json', authorization: auth };
      const guards = [];
      if (opts.signal) guards.push(opts.signal);
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
        // 单个请求最多等 10 秒，避免网络挂住时刷新按钮永久不可用
        guards.push(AbortSignal.timeout(10000));
      }

      const init = {
        method: 'GET',
        headers,
        credentials: opts.credentials || 'same-origin',
        signal: guards.length > 1 ? AbortSignal.any(guards) : guards[0]
      };

      if (opts.generate) {
        // POST + 空 body：浏览器会自动补 content-length: 0
        headers['content-type'] = 'application/json';
        init.method = 'POST';
      } else if (opts.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        init.method = 'POST';
        init.body = new URLSearchParams(opts.form).toString();
      }

      const request = (credentials) =>
        window.fetch(FX_API + path, Object.assign({}, init, { credentials }));
      const retryWithCookie = () =>
        call(path, Object.assign({}, opts, { credentials: 'include', cookieRetry: true }));

      let response;
      try {
        response = await request(init.credentials);
      } catch (err) {
        // 超时 / 主动中断：直接上报，绝不拿已中止的 signal 再发一次
        if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw normalize(err);
        // 网络层失败：补一次带同站 Cookie 的请求（个别环境的 Cloudflare 需要）
        try {
          response = await request('include');
        } catch (again) {
          throw normalize(again);
        }
      }

      if (response.status === 401) {
        if (usingApiKey) {
          // 密钥被拒：保留登录凭据（重新生成密钥还要用它），只标记失效
          apiExpired = true;
        } else {
          loginToken = '';
          expired = true;
        }
        // 凭据失效：会过期的缓存全部作废，别拿旧凭据的数据继续显示
        dropSessionCache();
        const error = new Error('UNAUTHORIZED');
        error.code = 'UNAUTHORIZED';
        error.source = usingApiKey ? 'api' : 'login';
        throw error;
      }

      if (usingApiKey) apiExpired = false;

      if (!response.ok) {
        // 列表接口可能只接受 POST：GET 被拒时补一次空表单请求
        // 只认 GET 的接口（如 /country/regions?country_id=…）传 noMethodRetry 跳过这一步
        if (
          init.method === 'GET' &&
          !opts.noMethodRetry &&
          (response.status === 404 || response.status === 405)
        ) {
          return call(path, Object.assign({}, opts, { form: opts.form || {} }));
        }
        // 403 常见于 Cloudflare 挑战：带同站 Cookie 再试一次
        if (response.status === 403 && !opts.cookieRetry) return retryWithCookie();
        const error = new Error('HTTP_' + response.status);
        error.code = 'HTTP';
        throw error;
      }

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        // 挑战页常见形态是 200 + HTML：解析失败也按 Cookie 兜底重试一次
        if (!opts.cookieRetry) return retryWithCookie();
        const error = new Error('BAD_PAYLOAD');
        error.code = 'BAD_PAYLOAD';
        throw error;
      }

      // 列表接口返回数组；/market/get 这类返回 { offers, canBuy }，用 opts.object 显式放行
      // 个别接口（如 /country/regions 查已无领土的国家）成功时干脆不带 data，用 opts.allowEmpty 放行
      const data = payload && payload.data;
      const validData =
        Array.isArray(data) ||
        (opts.allowEmpty === true && (data === undefined || data === null)) ||
        (opts.object === true && Boolean(data) && typeof data === 'object');
      if (!payload || payload.code !== 200 || !validData) {
        const error = new Error('BAD_PAYLOAD');
        error.code = 'BAD_PAYLOAD';
        throw error;
      }
      // 分页接口（如 /market/jobs/get）的 pagination 在根上，full 让调用方拿到整个信封；
      // 不传时维持原行为，只返回 data，既有调用方不受影响。
      return opts.full === true ? payload : data;
    }

    /** 用玩家当前登录凭据换一个专用 API 密钥；只用于账号操作，不占用数据查询额度。 */
    async function generateKey() {
      const data = await call('/account/apikey/generate', {
        login: true,
        object: true,
        generate: true
      });
      const key = data && typeof data.key === 'string' ? data.key.trim() : '';
      if (!apiKey.set(key)) {
        const error = new Error('BAD_KEY');
        error.code = 'BAD_KEY';
        throw error;
      }
      apiExpired = false;
      // 换了密钥：之前用旧凭据拉到的数据作废，下次进面板重新拉
      dropSessionCache();
      return apiKey.value;
    }

    return {
      /** api：使用专用密钥；login：临时借用登录凭据；none：还没有任何凭据。 */
      get mode() {
        if (apiKey.active) return 'api';
        return loginToken ? 'login' : 'none';
      },
      /** none：没见过凭据头；unsupported：见过但格式不符；expired：服务端判失效 */
      get state() {
        if (apiKey.active) return apiExpired ? 'expired' : 'ok';
        if (loginToken) return 'ok';
        if (expired) return 'expired';
        return seenAuth ? 'unsupported' : 'none';
      },
      install,
      uninstall,
      call,
      generateKey,
      /** 首次拿到登录凭据时回调（用于补画依赖凭据的界面）；返回取消订阅函数。 */
      onAuth(fn) {
        if (typeof fn !== 'function') return () => {};
        authListeners.add(fn);
        return () => authListeners.delete(fn);
      },
      /** 手动保存玩家粘贴的密钥；格式由 apiKey 校验。 */
      setKey(raw) {
        if (!apiKey.set(raw)) return false;
        apiExpired = false;
        // 换了密钥：之前用旧凭据拉到的数据作废
        dropSessionCache();
        return true;
      },
      /** 移除已保存的密钥，回到使用登录凭据。 */
      clearKey() {
        apiKey.clear();
        apiExpired = false;
        dropSessionCache();
      }
    };
  })();

  /** 凭据不可用时的统一提示，汇率与商品共用。 */
  function authHint() {
    if (apiClient.mode === 'api') {
      return apiClient.state === 'expired'
        ? '专用 API 密钥已失效，请到「设置」页重新生成。'
        : '专用 API 密钥暂不可用，请到「设置」页检查。';
    }
    const state = apiClient.state;
    if (state === 'expired') return '登录凭据已失效，请刷新游戏页面后再试。';
    if (state === 'unsupported') return '抓到接口请求了，但凭据格式不是 Bearer，请刷新游戏页面后再试。';
    return '尚未拿到登录凭据：先在游戏里打开任意页面（触发一次接口请求），再点「刷新行情」。';
  }

  /** 429 多半是每日查询额度用尽，提示去换专用密钥。 */
  function quotaHint(err) {
    if (!err || err.code !== 'HTTP' || String(err.message) !== 'HTTP_429') return '';
    return '接口返回 429（请求过多或已达当日查询上限），可到「设置」页生成专用密钥后再试。';
  }

  /**
   * 失败原因给玩家看的一句话。
   * COOLDOWN 不是「接口挂了」，而是「刚失败过，冷却中」，要说清还有多久能重试，
   * 并把上一次的真实原因（例如 429）带出来，否则刷新按钮点下去只会看到无意义的英文码。
   */
  function fetchErrorText(err) {
    if (!err) return '未知错误';
    if (err.code === 'COOLDOWN') {
      const left = Math.max(1, Math.ceil(((err.retryAt || 0) - Date.now()) / 1000));
      const tail = String(err.reason) === 'HTTP_429' ? '（上次返回 429，可能已达当日查询上限）' : '';
      return '上次请求失败，冷却中，约 ' + left + ' 秒后可重试' + tail;
    }
    if (err.code === 'NO_LOADER') return '缓存条目缺少加载器，请刷新游戏页面';
    return err.message || '未知错误';
  }

  /** countries/summary → 只保留有独立法币的国家，跳过 Gold 与海盗/世界实体。 */
  function fxCurrencies(list) {
    const seen = new Map();
    (Array.isArray(list) ? list : []).forEach((country) => {
      const currency = country && country.currency;
      if (!currency || !currency.id || !currency.name) return;
      if (String(currency.name).toLowerCase() === 'gold') return;
      if (seen.has(currency.id)) return;
      seen.set(currency.id, {
        id: currency.id,
        code: String(currency.name),
        country: String(country.name || ''),
        avatar: country.avatar == null ? '' : String(country.avatar)
      });
    });
    return [...seen.values()];
  }

  /** 沿最优档位逐档吃单，凑够 goldBudget 黄金，给出成交量加权成本。 */
  function fxFill(levels, goldBudget) {
    let left = goldBudget;
    let currency = 0;
    let gold = 0;

    levels.forEach((level) => {
      if (left <= 1e-9) return;
      const take = Math.min(left, level.gold);
      if (!(take > 0)) return;
      currency += take / level.price;
      gold += take;
      left -= take;
    });

    return {
      gold,
      currency,
      avg: currency > 0 ? gold / currency : null,
      filled: left <= 1e-9
    };
  }

  /** 同上，但目标是「凑够 qtyBudget 单位法币」：换汇目标切成法币时用。 */
  function fxFillQty(levels, qtyBudget) {
    let left = qtyBudget;
    let currency = 0;
    let gold = 0;

    levels.forEach((level) => {
      if (left <= 1e-9) return;
      const take = Math.min(left, level.qty);
      if (!(take > 0)) return;
      currency += take;
      gold += take * level.price;
      left -= take;
    });

    return {
      gold,
      currency,
      avg: currency > 0 ? gold / currency : null,
      filled: left <= 1e-9
    };
  }

  function fxPrice(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value >= 1000) return value.toFixed(0);
    if (value >= 10) return value.toFixed(2);
    if (value >= 1) return value.toFixed(3);
    if (value >= 0.001) return value.toFixed(4);
    return value.toPrecision(3);
  }

  function fxQty(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value >= 10000) return value.toFixed(0);
    if (value >= 100) return value.toFixed(1);
    if (value >= 1) return value.toFixed(2);
    return value.toPrecision(3);
  }

  /** 黄金图标（游戏官方 CDN）：面板与页面标注里都用它代替「金」字。 */
  const GOLD_ICON_SRC = 'https://storage.eclesiar.com/medias/41.png';

  /** HTML 片段版：给 innerHTML 拼接用，尺寸走 .eh-gold-ico 系列类。 */
  const goldIconHtml = (cls) =>
    '<img class="eh-gold-ico' +
    (cls ? ' ' + cls : '') +
    '" src="' +
    GOLD_ICON_SRC +
    '" alt="金" decoding="async" loading="lazy">';

  /** 元素版（面板内）：样式来自 STYLES，加载失败由 ShadowRoot 上的委托兜底换成「金」字。 */
  function buildGoldIconEl(cls) {
    const img = document.createElement('img');
    img.className = 'eh-gold-ico' + (cls ? ' ' + cls : '');
    img.src = GOLD_ICON_SRC;
    img.alt = '金';
    img.decoding = 'async';
    img.loading = 'lazy';
    return img;
  }

  /** 元素版（游戏页面标注）：内联样式定尺寸，不依赖插件样式表。 */
  function buildGoldIcon(px) {
    const img = document.createElement('img');
    img.src = GOLD_ICON_SRC;
    img.alt = '金';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.style.cssText =
      'width:' +
      px +
      'px;height:' +
      px +
      'px;object-fit:contain;display:inline-block;flex:none;vertical-align:-' +
      Math.max(1, Math.round(px / 8)) +
      'px;';
    img.addEventListener(
      'error',
      () => {
        img.replaceWith(document.createTextNode('金'));
      },
      { once: true }
    );
    return img;
  }

  /** 面板里的图标加载失败时就地换成「金」字，别留破图（img 的 error 不冒泡，用捕获）。 */
  function onGoldIconError(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('eh-gold-ico')) return;
    img.replaceWith(document.createTextNode('金'));
  }

  /** 黄金单价可能很小（0.0000123），整数位少时多给几位小数，别都显示成 0.00。 */
  function fxGold(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value >= 1000) return value.toFixed(0);
    if (value >= 100) return value.toFixed(2);
    if (value >= 1) return value.toFixed(3);
    if (value >= 0.01) return value.toFixed(4);
    if (value >= 0.0001) return value.toFixed(6);
    if (value >= 0.000001) return value.toFixed(8);
    return value.toPrecision(3);
  }

  /** 国旗：优先用 summary 里的 avatar 图，加载失败再退回本地 emoji。 */
  function buildFlagEl(code, avatar) {
    const wrap = document.createElement('span');
    wrap.className = 'eh-fx-flag';
    const locale = fxLocale(code);

    const useGlyph = () => {
      const glyph = locale ? locale[1] : '';
      wrap.classList.add('eh-fx-flag--glyph');
      wrap.textContent = glyph;
      // 图没有、本地也没有兜底时不占位，免得留一个空框
      if (!glyph) wrap.hidden = true;
    };

    const src = fxAvatarUrl(avatar);
    if (!src) {
      useGlyph();
      return wrap;
    }

    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.addEventListener('error', useGlyph, { once: true });
    img.src = src;
    wrap.appendChild(img);
    return wrap;
  }

  /* -------- 9.2 汇率数据源：挂单簿 + 国家 / 税率 -------- */

  const COIN_PATH = '/market/coin/get';

  /**
   * 单侧挂单归一：价格一律换成「黄金 / 1 单位法币」，数量换成可成交黄金量。
   * SELL 单：rate 就是 黄金/法币，amount 是法币数量；
   * BUY 单：rate 是 法币/黄金，取倒数才是价格，amount 是黄金数量。
   */
  function fxLevels(orders, side) {
    const read = (Array.isArray(orders) ? orders : [])
      .map((order) => ({
        rate: Number(order && order.rate),
        amount: Number(order && order.amount)
      }))
      .filter(
        (order) =>
          Number.isFinite(order.rate) && order.rate > 0 && Number.isFinite(order.amount) && order.amount > 0
      );

    if (side === 'BUY') {
      return read
        .map((order) => ({ price: 1 / order.rate, qty: order.amount * order.rate, gold: order.amount }))
        .sort((a, b) => b.price - a.price);
    }
    return read
      .map((order) => ({ price: order.rate, qty: order.amount, gold: order.amount * order.rate }))
      .sort((a, b) => a.price - b.price);
  }

  /**
   * 单币种挂单簿：每个币种的买卖两侧各占一个 apiCache key（10 分钟、各自独立）。
   * - `quote(id)` / `side(id, transaction)`：同步读，不触发请求；
   * - `ensureMany(ids)`：补齐缺失的一侧（命中缓存就不发请求）；
   * - `load(ids, hooks)`：跑一轮（默认绕过 TTL），返回**批次句柄**驱动进度 / 重试 / 失败 / 429。
   * 批次句柄随调用栈消失，不常驻；「更新于」与「有没有挂单」都从 key 自身读。
   */
  const coinBook = (() => {
    const OPTS = { ttl: 'coin', namespace: 'coin' };
    /** 一轮里最多串行补跑几个失败项：失败面过大时是整体故障，逐个补只会拖长等待。 */
    const RETRY_LIMIT = 8;
    /** 最近一次**成功批**（失败项已剔除）：一条没成功就保留上一次，没成功过就是空的（只存内存）。 */
    let lastBatch = { startedAt: 0, okKeys: [], okAt: new Map() };
    /** 正在跑的批次句柄（同一时刻只有一轮）。 */
    let batch = null;

    const sideKey = (currencyId, side) =>
      apiCache.key(COIN_PATH, { currency_id: String(currencyId), transaction: side });

    const loaderFor = (currencyId, side) => () =>
      apiClient
        .call(COIN_PATH, { form: { currency_id: currencyId, transaction: side } })
        .then((orders) => fxLevels(orders, side));

    /** 单侧缓存条目 { value, at, empty, stale } 或 null。 */
    const side = (currencyId, transaction) => apiCache.peek(sideKey(currencyId, transaction));

    /** 合并两侧；两侧都还没拉过时返回 null（区分「没数据」与「没加载过」）。 */
    function quote(currencyId) {
      const sell = side(currencyId, 'SELL');
      const buy = side(currencyId, 'BUY');
      if (!sell && !buy) return null;
      const asks = sell ? sell.value : [];
      const bids = buy ? buy.value : [];
      const stamps = [sell, buy].filter(Boolean).map((entry) => entry.at);
      return {
        id: Number(currencyId),
        asks,
        bids,
        /** 两侧里较早的那份时间：这行数据最旧到此为止。 */
        at: Math.min.apply(null, stamps),
        empty: asks.length === 0 && bids.length === 0,
        /** 有一侧没拉到（失败 / 还没拉过），不代表那一侧没有挂单。 */
        partial: !sell || !buy,
        stale: Boolean((sell && sell.stale) || (buy && buy.stale))
      };
    }

    /** 最优买价（吃卖单）/ 最优卖价（吃买单）；没有该方向挂单时 null。 */
    function bestPrice(currencyId, transaction) {
      const entry = side(currencyId, transaction);
      if (!entry || !entry.value.length) return null;
      return entry.value[0].price;
    }

    /** 该国货币在当前买单里还能吃下多少（法币数量），用于提示换汇深度不足。 */
    function sellCapacity(currencyId) {
      const entry = side(currencyId, 'BUY');
      if (!entry) return 0;
      return entry.value.reduce((sum, level) => sum + level.qty, 0);
    }

    /**
     * 该币种买卖两侧是否都有**未过期**缓存。
     * 「全命中就别跑一轮」的快路径用它判断，避免每个币种仍走一遍 ensure + 60ms 间隔，
     * 让面板显示一轮根本不发请求的假进度。
     */
    function ready(currencyId) {
      return apiCache.fresh(sideKey(currencyId, 'SELL')) && apiCache.fresh(sideKey(currencyId, 'BUY'));
    }

    /** 并发跑一组任务（默认 3 并发 + 60ms 间隔，与接口的既有限速口径一致）。 */
    async function pool(tasks, worker) {
      let cursor = 0;
      const lanes = Array.from({ length: Math.min(FX_CONCURRENCY, tasks.length) }, async () => {
        while (cursor < tasks.length) {
          const task = tasks[cursor];
          cursor += 1;
          await worker(task);
          await fxSleep(FX_GAP);
        }
      });
      await Promise.all(lanes);
    }

    const tasksOf = (ids) => {
      const out = [];
      ids.forEach((id) => {
        out.push({ id, side: 'SELL' }, { id, side: 'BUY' });
      });
      return out;
    };

    /** 补齐若干货币的两侧挂单（命中 10 分钟缓存就不发请求）。返回失败集合。 */
    async function ensureMany(ids) {
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
      const failed = [];
      await pool(tasksOf(list), async (task) => {
        try {
          await apiCache.ensure(sideKey(task.id, task.side), loaderFor(task.id, task.side), OPTS);
        } catch (err) {
          if (err && err.code === 'UNAUTHORIZED') throw err;
          failed.push(sideKey(task.id, task.side));
        }
      });
      return { failedKeys: failed, limited: false };
    }

    /**
     * 跑一轮挂单刷新，返回批次句柄：
     * { startedAt, progress, failedIds, failedKeys, limited, cancelled, done, promise }。
     * mode='refresh' 绕过 TTL（「刷新行情」），mode='ensure' 命中缓存（打开面板）。
     * 失败项按旧口径串行补一轮；整批都成功才更新 lastBatch。
     */
    function load(ids, hooks) {
      if (batch) return batch;
      const options = hooks || {};
      const mode = options.mode === 'ensure' ? 'ensure' : 'refresh';
      const queue = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
      const handle = {
        startedAt: Date.now(),
        progress: { phase: 'fetch', done: 0, total: queue.length, retryIndex: 0, retryTotal: 0 },
        failedIds: [],
        failedKeys: [],
        limited: false,
        cancelled: false,
        done: false,
        promise: null
      };
      batch = handle;

      /**
       * force=true 时绕过 TTL 也绕过失败冷却（补跑阶段用）。
       * ensure 模式下的补跑必须走 refresh：ensure 会直接命中上一轮留下的冷却，
       * 补跑变成一次立即失败，「串行补一次」名存实亡。
       */
      const pull = (task, force) => {
        const key = sideKey(task.id, task.side);
        const loader = loaderFor(task.id, task.side);
        if (mode === 'ensure' && force !== true) return apiCache.ensure(key, loader, OPTS);
        return apiCache.refresh(key, loader, OPTS);
      };

      const attempt = async (id, force) => {
        await Promise.all(
          ['SELL', 'BUY'].map((one) => pull({ id, side: one }, force))
        );
      };

      const step = (id, failed) => {
        if (typeof options.onRow === 'function') {
          try {
            options.onRow(id, failed);
          } catch (err) {
            warn('汇率行回调异常', err);
          }
        }
      };

      handle.promise = (async () => {
        const failed = [];
        /** 本轮每个失败 id 的原始错误：补跑阶段据此跳过 429（额度已满，再补只会更糟）。 */
        const failureCodes = new Map();
        let cursor = 0;
        const worker = async () => {
          while (cursor < queue.length) {
            if (handle.cancelled) return;
            const id = queue[cursor];
            cursor += 1;
            // ensure 模式下两侧都命中缓存：不发请求，也不用等 60ms 的请求间隔
            const cached = mode === 'ensure' && ready(id);
            let ok = true;
            try {
              await attempt(id);
            } catch (err) {
              if (err && err.code === 'UNAUTHORIZED') throw err;
              if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') handle.limited = true;
              ok = false;
              failureCodes.set(id, err);
              failed.push(id);
            }
            handle.progress = Object.assign({}, handle.progress, { done: handle.progress.done + 1 });
            step(id, !ok);
            if (typeof options.onProgress === 'function') options.onProgress(handle);
            if (!cached) await fxSleep(FX_GAP);
          }
        };

        try {
          await Promise.all(
            Array.from({ length: Math.min(FX_CONCURRENCY, queue.length) }, () => worker())
          );

          // 失败多半是瞬时网络抖动 / 5xx：串行补一次，仍失败才计入结果。
          // 429 不补（额度已满，再发只会更糟）；失败面过大时也不补（多半是整体故障，
          // 逐个补会把「打开面板」拖成几分钟的等待）。
          if (!handle.cancelled && failed.length) {
            const skipped = failed.filter((id) => {
              const err = failureCodes.get(id);
              return err && err.code === 'HTTP' && String(err.message) === 'HTTP_429';
            });
            const retryable = failed.filter((id) => skipped.indexOf(id) === -1);
            const untouched = retryable.slice(RETRY_LIMIT);
            let left = retryable.slice(0, RETRY_LIMIT);
            handle.progress = Object.assign({}, handle.progress, {
              phase: 'retry',
              retryIndex: 0,
              retryTotal: left.length
            });
            if (typeof options.onProgress === 'function') options.onProgress(handle);
            for (let i = 0; i < left.length; i += 1) {
              if (handle.cancelled) break;
              const id = left[i];
              handle.progress = Object.assign({}, handle.progress, { retryIndex: i + 1 });
              try {
                await attempt(id, true);
                left = left.filter((item) => item !== id);
                step(id, false);
              } catch (err) {
                if (err && err.code === 'UNAUTHORIZED') throw err;
                if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') handle.limited = true;
                step(id, true);
              }
              if (typeof options.onProgress === 'function') options.onProgress(handle);
              await fxSleep(FX_GAP * 3);
            }
            failed.length = 0;
            // 补成功的从失败集合里摘掉；429 跳过的、超出补跑上限的仍算失败
            left.forEach((id) => failed.push(id));
            untouched.forEach((id) => failed.push(id));
            skipped.forEach((id) => failed.push(id));
          }

          handle.failedIds = handle.cancelled ? [] : failed.slice();
          handle.failedKeys = handle.failedIds.map((id) => sideKey(id, 'SELL'));

          // 「最近一次成功」按本轮真正成功的货币覆盖式更新：个别币种长期失败时，
          // 只把它们从集合里剔除，不能让「更新于」永远冻结在上一次整轮成功的时间。
          // batch !== handle 说明这一轮已经被 reset / 换成新批次，旧结果不许回写。
          if (!handle.cancelled && batch === handle) {
            const okIds = queue.filter((id) => failed.indexOf(id) === -1);
            if (okIds.length) {
              const okAt = new Map();
              okIds.forEach((id) => {
                const sell = side(id, 'SELL');
                const buy = side(id, 'BUY');
                const stamps = [sell, buy].filter(Boolean).map((entry) => entry.at);
                if (stamps.length) okAt.set(String(id), Math.min.apply(null, stamps));
              });
              lastBatch = {
                startedAt: handle.startedAt,
                okKeys: okIds.map((id) => sideKey(id, 'SELL')),
                okAt
              };
            }
          }
        } finally {
          // 无论正常结束还是被 UNAUTHORIZED 打断，都要把批次复位，
          // 否则 batch 永久非空，之后每次 load() 都会拿到这个已结束的旧句柄。
          handle.progress = Object.assign({}, handle.progress, {
            phase: 'idle',
            retryIndex: 0,
            retryTotal: 0
          });
          handle.done = true;
          if (batch === handle) batch = null;
        }
        return handle;
      })();

      return handle;
    }

    return {
      quote,
      side,
      bestPrice,
      sellCapacity,
      ensureMany,
      ready,
      load,
      cancel() {
        if (batch) batch.cancelled = true;
      },
      /** 凭据变化 / destroy：连「最近一次成功」的时间一起丢掉，别拿旧数据报「更新于」。 */
      reset() {
        // 同时标记旧批次取消：缓存已清空，继续跑只会把每一行都算成失败
        if (batch) batch.cancelled = true;
        batch = null;
        lastBatch = { startedAt: 0, okKeys: [], okAt: new Map() };
      },
      get last() {
        return lastBatch;
      },
      /**
       * 最近一次成功批里、当前这批货币中最旧的一份数据时间；一次都没成功过返回 0。
       * 长期失败 / 从未成功的货币不参与，免得把时间无限拉低。
       */
      oldestAt(ids) {
        let oldest = 0;
        (Array.isArray(ids) ? ids : []).forEach((id) => {
          const at = lastBatch.okAt.get(String(id));
          if (!at) return;
          if (!oldest || at < oldest) oldest = at;
        });
        return oldest;
      }
    };
  })();

  /**
   * 凭据变化（生成 / 保存 / 移除密钥、401）：丢掉会过期的接口缓存，
   * 连同「最近一次成功」的行情时间；页面级条目（国家清单 / 税率）与凭据无关，保留。
   * 展示快照与解析结果也要一起清：否则面板会同时挂着旧价格和「还没有行情数据」。
   */
  function dropSessionCache() {
    apiCache.clear(true);
    coinBook.reset();
    fxFeed.reset();
    playerFeed.reset();
    profileFeed.reset();
  }

  /**
   * 汇率数据源：国家清单 / 税率，以及「汇率」面板用的展示视图（quotes）。
   * quotes 只是 coinBook 的渲染快照，不是缓存：数据一律回 coinBook 读。
   * 订阅回调签名 (kind, quote)：
   *   reset —— quotes 整体替换，订阅方需要重建列表；
   *   row   —— 单个货币的数据 / 状态变化；
   *   drop  —— 该货币两侧都没有挂单，应从列表移除；
   *   state —— 加载中 / 进度 / 错误等整体状态变化；
   *   done  —— 本轮结束（含失败），订阅方可以排序。
   */
  const fxFeed = (() => {
    const listeners = new Set();
    /** 国家清单与税率都是页面级缓存：一次页面只拉一次，底层由 apiCache 去重与冷却。 */
    const COUNTRIES_KEY = '/countries/summary';
    const TAXES_KEY = '/countries';
    const PAGE_OPTS = { ttl: 'page', namespace: 'countries' };
    let countries = null;
    /** 解析结果用条目对象本身做「版本」：条目被 invalidate / 刷新后换成新对象，重新解析一次。 */
    let countriesEntry = null;
    /** 国家 id → { vat, importTax }（百分数，10 表示 10%）；只在「销售」视图用得到。 */
    let taxes = null;
    /** 国家 id → { workTax, minWage }；「税费」子面板用得到，和 taxes 来自同一次 /countries 请求。 */
    let wageLaws = null;
    let taxesEntry = null;
    /** 「汇率」面板的展示快照（含 pending 行）；数据本身在 coinBook 里，这里只做渲染。 */
    let quotes = [];
    /** 正在读行情（要发请求）：界面据此显示进度、禁用刷新按钮。 */
    let loading = false;
    /** 已有一轮在跑（含「全部命中缓存、不发请求」的快路径），用来防重入。 */
    let resolving = false;
    let error = null;
    /** 本次刷新国家清单失败、退回上一份清单时置位；只影响状态栏文案。 */
    let countriesStale = false;
    let progress = { phase: 'idle', done: 0, total: 0, retryIndex: 0, retryTotal: 0 };
    let promise = null;

    const notify = (kind, quote) => {
      [...listeners].forEach((fn) => {
        try {
          fn(kind, quote);
        } catch (err) {
          warn('汇率订阅回调异常', err);
        }
      });
    };

    const countriesLoader = () => apiClient.call(COUNTRIES_KEY);
    const taxesLoader = () => apiClient.call(TAXES_KEY);

    /**
     * 国家清单解析。页面级条目永不过期，所以空清单不能就这么留着——
     * 一次异常的空数组会让五个面板一起报「没有可用的国家清单」直到刷新整页，
     * 这里直接把条目丢掉，下次 ensure 重新问一次。
     */
    function applyCountries(entry) {
      if (!entry) return countries || [];
      if (entry !== countriesEntry) {
        countries = Array.isArray(entry.value) ? entry.value : [];
        countriesEntry = entry;
        if (!countries.length) apiCache.invalidate(COUNTRIES_KEY);
      }
      return countries;
    }

    /** 国家清单只取一次：两个标签都要用，短时间内也不会变（失效由 apiCache 负责）。 */
    function ensureCountries() {
      return apiCache.ensure(COUNTRIES_KEY, countriesLoader, PAGE_OPTS).then(applyCountries);
    }

    /** 「刷新」用：绕过页面级 TTL 重拉（失败保留旧值）。 */
    function refreshCountries() {
      return apiCache.refresh(COUNTRIES_KEY, countriesLoader, PAGE_OPTS).then(applyCountries);
    }

    /** 税率字段容错：正常是 10（=10%），个别实现会给 0.1 这种比例。 */
    const toPercent = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return null;
      if (num > 0 && num < 1) return num * 100;
      return num;
    };

    /** /countries → 税率与工资法两张表；与 summary 分开请求，解析结果跟着缓存条目走。 */
    function parseTaxes(list) {
      const map = new Map();
      const wageMap = new Map();
      (Array.isArray(list) ? list : []).forEach((country) => {
        if (!country || country.id == null) return;
        const laws = country.laws || {};
        const rawImport =
          laws.import_taxes != null
            ? laws.import_taxes
            : laws.import_tax != null
              ? laws.import_tax
              : laws.importTax;
        const vat = toPercent(laws.vat);
        const importTax = toPercent(rawImport);
        const workTax = toPercent(laws.work_tax != null ? laws.work_tax : laws.workTax);
        const rawWage = laws.minimum_wage != null ? laws.minimum_wage : laws.minimumWage;
        const wage = rawWage == null || rawWage === '' ? null : Number(rawWage);
        const minWage = Number.isFinite(wage) && wage >= 0 ? wage : null;

        if (vat != null || importTax != null) {
          map.set(String(country.id), {
            vat: vat == null ? 0 : vat,
            importTax: importTax == null ? 0 : importTax
          });
        }
        if (workTax != null || minWage != null) {
          wageMap.set(String(country.id), { workTax: workTax, minWage: minWage });
        }
      });
      return { taxes: map, wageLaws: wageMap };
    }

    /**
     * 各国税率：/countries 的 laws.vat / laws.import_taxes，顺带把工资法
     * （laws.work_tax / laws.minimum_wage）也存下来给「税费」子面板用，不多发请求。
     * 只在真正需要时拉一次，结果在页面内缓存，失败 60 秒内不重试（由 apiCache 冷却）。
     * 解析结果为空时同样把页面级条目丢掉：留着一个「什么都没有」的永久条目，
     * 销售视图会一直按 0 税率估算。
     */
    function applyTaxes(entry) {
      if (!entry) return taxes;
      if (entry !== taxesEntry) {
        const parsed = parseTaxes(entry.value);
        taxes = parsed.taxes;
        wageLaws = parsed.wageLaws;
        taxesEntry = entry;
        if (!taxes.size) apiCache.invalidate(TAXES_KEY);
      }
      return taxes;
    }

    function ensureTaxes() {
      return apiCache.ensure(TAXES_KEY, taxesLoader, PAGE_OPTS).then(applyTaxes);
    }

    /** 「刷新」用：绕过页面级 TTL 重拉税率 / 工资法（失败保留旧值）。 */
    function refreshTaxes() {
      return apiCache.refresh(TAXES_KEY, taxesLoader, PAGE_OPTS).then(applyTaxes);
    }

    /**
     * 统一的国家清单入口：mode='refresh' 绕过页面级 TTL。刷新失败但手里还有上一份清单时
     * 退回旧清单继续跑（行情本身没坏，别让「刷新」变成整页空白），只把 states 记成 stale。
     */
    async function loadCountries(mode) {
      try {
        const list = mode === 'refresh' ? await refreshCountries() : await ensureCountries();
        countriesStale = false;
        return list;
      } catch (err) {
        if (countries && countries.length) {
          countriesStale = true;
          return countries;
        }
        throw err;
      }
    }

    /**
     * 跑一轮行情。mode='refresh' 绕过 TTL（点「刷新行情」），'ensure' 命中 10 分钟缓存
     * （打开面板、别的标签要用汇率）。数据一律写进 coinBook，这里只维护 quotes 快照与状态。
     */
    function run(mode) {
      if (resolving) return promise;
      if (apiClient.state !== 'ok') {
        error = { code: 'NO_TOKEN' };
        notify('state');
        return null;
      }

      resolving = true;
      error = null;

      promise = (async () => {
        try {
          const list = fxCurrencies(await loadCountries(mode)).map((entry) =>
            Object.assign({}, entry, { asks: null, bids: null, status: 'pending' })
          );
          if (!list.length) {
            const empty = new Error('没有可用的法币清单');
            empty.code = 'EMPTY_CURRENCIES';
            throw empty;
          }

          // 全部命中 10 分钟缓存：直接从挂单簿拼快照。
          // 否则仍会逐币种走 ensure + 60ms 间隔，面板上显示一轮根本不发请求的假进度。
          if (mode === 'ensure' && list.every((item) => coinBook.ready(item.id))) {
            const filled = [];
            list.forEach((item) => {
              const book = coinBook.quote(item.id);
              if (!book || book.empty) return;
              filled.push(
                Object.assign({}, item, { asks: book.asks, bids: book.bids, status: 'ok' })
              );
            });
            // 行集合没变就只刷新状态，别整表重建（切回本页时几乎零动作）
            const same =
              quotes.length === filled.length &&
              filled.every((item, index) => quotes[index] && quotes[index].id === item.id);
            if (!same) {
              quotes = filled;
              notify('reset');
            }
            progress = {
              phase: 'idle',
              done: filled.length,
              total: filled.length,
              retryIndex: 0,
              retryTotal: 0
            };
            return;
          }

          loading = true;
          progress = { phase: 'fetch', done: 0, total: list.length, retryIndex: 0, retryTotal: 0 };
          notify('state');

          quotes = list;
          notify('reset');

          const handle = coinBook.load(list.map((item) => item.id), {
            mode,
            onRow: (id, failed) => applyBook(id, failed),
            onProgress: (current) => {
              progress = Object.assign({}, current.progress);
              notify('state');
            }
          });
          await handle.promise;
          progress = Object.assign({}, handle.progress, { phase: 'idle' });
          // 失败时旧值仍在 coinBook 里，面板继续显示上一次成功的数据，只报失败数量
          if (handle.failedIds.length) {
            error = { code: 'PARTIAL', count: handle.failedIds.length, limited: handle.limited };
          } else if (countriesStale) {
            // 行情本身没问题，只是国家清单这次没刷新成功（用了上一份）
            error = { code: 'STALE_COUNTRIES' };
          }
        } catch (err) {
          error = {
            code: (err && err.code) || 'ERROR',
            message: err && err.message,
            retryAt: (err && err.retryAt) || 0,
            reason: (err && err.reason) || ''
          };
          notify('reset');
        } finally {
          resolving = false;
          loading = false;
          promise = null;
          notify('done');
          notify('state');
        }
      })();

      return promise;
    }

    /**
     * 单个货币的数据到位：更新快照行；两侧都没挂单就从列表里拿掉。
     * 这次失败但手里还有上一次的数据时继续显示旧值（状态栏会报失败数量），
     * 只有一侧都没拉到才标「拉取失败」。
     */
    function applyBook(currencyId, failed) {
      const quote = quotes.find((item) => item.id === Number(currencyId));
      if (!quote) return;
      const book = coinBook.quote(currencyId);
      if (!book || (failed && book.partial)) {
        quote.status = 'error';
        notify('row', quote);
        return;
      }
      if (book.empty) {
        // 两侧都没有挂单：直接把这行拿掉，与「只显示有挂单的货币」一致
        const index = quotes.indexOf(quote);
        if (index !== -1) quotes.splice(index, 1);
        notify('drop', quote);
        return;
      }
      quote.asks = book.asks;
      quote.bids = book.bids;
      quote.status = 'ok';
      notify('row', quote);
    }

    return {
      get quotes() {
        return quotes;
      },
      get countries() {
        return countries || [];
      },
      get taxesKnown() {
        return Boolean(taxes);
      },
      get loading() {
        return loading;
      },
      get progress() {
        return progress;
      },
      /**
       * 这屏数据里最旧的一份有效数据时间：取最近一次整批成功中、当前列表里那些货币的最旧值。
       * 不用「本轮结束时刻」，否则比真实数据新；长期失败的货币不参与，不拉低时间。
       * 没有「整批成功」记录时（例如缓存是商品市场页标注单独补的）退回逐行取最旧。
       */
      get updatedAt() {
        const ids = quotes.map((item) => item.id);
        const fromBatch = coinBook.oldestAt(ids);
        if (fromBatch) return fromBatch;
        let oldest = 0;
        ids.forEach((id) => {
          const book = coinBook.quote(id);
          if (!book || !book.at) return;
          if (!oldest || book.at < oldest) oldest = book.at;
        });
        return oldest;
      },
      get error() {
        return error;
      },
      /** 国家清单这次是不是退回上一份了（状态栏用）。 */
      get countriesStale() {
        return countriesStale;
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      ensureCountries,
      refreshCountries,
      /** 统一入口：mode='refresh' 绕过页面级 TTL，刷新失败退回旧清单。 */
      loadCountries,
      ensureTaxes,
      refreshTaxes,
      /** 点「刷新行情」：绕过 TTL 重抓一遍。 */
      refresh: () => run('refresh'),
      /** 打开面板 / 别的标签要用汇率：命中 10 分钟缓存就不发请求。 */
      ensure: () => run('ensure'),
      /**
       * 凭据变化 / destroy：清掉展示快照与错误，别再显示「旧价格 + 没有行情数据」的混合状态。
       * 在途那一轮会自己收尾，这里不动 loading / promise。
       */
      reset() {
        quotes = [];
        error = null;
        countriesStale = false;
        progress = { phase: 'idle', done: 0, total: 0, retryIndex: 0, retryTotal: 0 };
        notify('reset');
      },
      /**
       * 国家 id → 该国法币（来自 /countries/summary）。
       * 「汇率」置顶玩家国籍 / 所在国时用它把国家换成货币；清单还没拉到或该国没有法币时返回 null。
       */
      currencyOfCountry(countryId) {
        if (!countries || countryId == null) return null;
        const id = Number(countryId);
        if (!id) return null;
        const row = countries.find((item) => item && Number(item.id) === id);
        const currency = row && row.currency;
        if (!currency || currency.id == null || !currency.name) return null;
        if (String(currency.name).toLowerCase() === 'gold') return null;
        return {
          id: currency.id,
          code: String(currency.name),
          country: String(row.name || ''),
          avatar: row.avatar == null ? '' : String(row.avatar)
        };
      },
      /** 法币 id → 最优卖单价（黄金 / 1 单位法币）；没有挂单返回 null。直接读挂单簿。 */
      rateFor: (currencyId) => coinBook.bestPrice(currencyId, 'SELL'),
      /**
       * 卖法币换黄金的最优价（黄金 / 1 单位法币）：吃的是别人的买单，
       * 与「买入价」（rateFor，吃卖单）不是一个方向，销售时必须用这个。
       */
      sellRateFor: (currencyId) => coinBook.bestPrice(currencyId, 'BUY'),
      /** 该国货币在当前买单里还能吃下多少（法币数量），用于提示换汇深度不足。 */
      sellCapacityFor: (currencyId) => coinBook.sellCapacity(currencyId),
      /** 国家 id → 税率（百分数）；还没拉到 / 该国没有 laws 时返回 null。 */
      taxFor(countryId) {
        if (!taxes || countryId == null) return null;
        return taxes.get(String(countryId)) || null;
      },
      /** 国家 id → 工资法 { workTax, minWage }；和 taxFor 来自同一次 /countries 请求。 */
      wageLawsFor(countryId) {
        if (!wageLaws || countryId == null) return null;
        return wageLaws.get(String(countryId)) || null;
      },
      /** 面板关掉 / 插件销毁：只停止继续发起新的 key，已发出且可能被共享的请求不 abort。 */
      cancel() {
        coinBook.cancel();
      }
    };
  })();

  /* -------- 9.2b 玩家信息：账号 id / 国籍 / 所在国家，以及公开资料里的经济技能 -------- */

  /**
   * playerFeed 只取三个字段，各模块共用同一份缓存：
   *  - accountId：账号 id，只用来拼公开资料地址；
   *  - nationalityId：玩家国籍，「销售」时用来判断本国免进口税；
   *  - countryId：当前所在国家（region.country.id），
   *    商品市场里的价格按「所在国市场的本币」计价（上架表单的单价 / 实收金额就是这种），
   *    折算成黄金必须知道这一条。
   * 固定用 POST /account/getuser（只认游戏登录凭据，带专用密钥会 401），
   * 结果只存内存，不展示原字段、不打印、不上报、不落盘；响应里的 bearer 等字段一律忽略。
   */
  const playerFeed = (() => {
    /**
     * 10 秒缓存：旅行 / 换国籍后最多 10 秒就会重新读一次；期间不重复打接口。
     * 失败冷却 60 秒由 apiCache 负责（凭据没捕获到时不冷却，登录后要能立刻再问）。
     */
    const KEY = '/account/getuser';
    const OPTS = { ttl: 'account', namespace: 'player' };

    let info = null;
    /** 解析结果用条目对象本身做「版本」，条目被清掉 / 刷新后重新解析。 */
    let infoEntry = null;

    const pick = (data) => {
      const account = data && data.user && typeof data.user === 'object' ? data.user : data;
      const nationality = account && account.nationality;
      const rawNationality =
        nationality && nationality.id != null ? nationality.id : account && account.nationality_id;
      const region = account && account.region;
      const country = region && typeof region === 'object' ? region.country : null;
      const rawCountry = country && country.id != null ? country.id : account && account.country_id;
      const rawId = account && account.id != null ? account.id : data && data.id;
      return {
        accountId: Number(rawId) || 0,
        nationalityId: Number(rawNationality) || 0,
        countryId: Number(rawCountry) || 0
      };
    };

    function ensure() {
      return apiCache
        .ensure(KEY, () => apiClient.call(KEY, { login: true, form: {}, object: true }), OPTS)
        .then((entry) => {
          if (!entry) return info;
          if (entry !== infoEntry) {
            info = pick(entry.value);
            infoEntry = entry;
          }
          return info;
        });
    }

    return {
      get info() {
        return info;
      },
      get accountId() {
        return info ? info.accountId : 0;
      },
      get nationalityId() {
        return info ? info.nationalityId : 0;
      },
      get countryId() {
        return info ? info.countryId : 0;
      },
      ensure,
      /**
       * 订阅账号字段变化：解析出新值或值被清空时回调（参数为 info 或 null）。
       * 直接挂在 apiCache 的 `/account/getuser` 这个 key 上——所有写入都经过它，
       * 通知与订阅统计因此只有一套（`cache.stats().watchers` 也看得到）。
       * 返回退订函数，必须挂到 ctx.onDestroy / stop()，否则面板销毁后还会被叫到。
       */
      watch(fn) {
        if (typeof fn !== 'function') return () => {};
        return apiCache.watch(KEY, () => fn(info));
      },
      /** 凭据变化 / destroy：丢掉解析结果，免得继续用旧凭据的身份做高亮与折算。 */
      reset() {
        info = null;
        infoEntry = null;
      }
    };
  })();

  /**
   * profileFeed：玩家经济技能在公开资料页里，getuser 与 attributes.stats.economic_aptitude 都不是它。
   * GET /user/profile/{account_id} 只取 economic_level，10 秒缓存、失败冷却 60 秒。
   * 公开资料接口支持专用密钥，所以这里沿用 apiClient.call 的默认凭据优先级，不强制 login。
   */
  const profileFeed = (() => {
    const PREFIX = '/user/profile/';
    const OPTS = { ttl: 'profile', namespace: 'profile' };

    /** 当前关心的账号：晚到的旧账号结果直接丢掉，不覆盖新账号的技能等级。 */
    let wantedId = 0;
    let level = null;
    let levelEntry = null;

    function ensure(accountId) {
      const id = Number(accountId);
      if (!Number.isFinite(id) || id <= 0) return Promise.resolve(null);
      const key = PREFIX + encodeURIComponent(String(id));
      wantedId = id;
      return apiCache
        .ensure(key, () => apiClient.call(key, { object: true, noMethodRetry: true }), OPTS)
        .then((entry) => {
          if (wantedId !== id) return level;
          if (!entry) return level;
          if (entry !== levelEntry) {
            const raw = entry.value && entry.value.economic_level;
            const value = Number(raw);
            level = raw != null && Number.isFinite(value) ? value : null;
            levelEntry = entry;
          }
          return level;
        });
    }

    return {
      get economicLevel() {
        return level;
      },
      ensure,
      /** 凭据变化 / destroy：清掉技能等级，别把上一个账号的值当成当前玩家。 */
      reset() {
        wantedId = 0;
        level = null;
        levelEntry = null;
      }
    };
  })();

  registerFeature({
    id: 'fx',
    title: '汇率',
    order: 20,
    mount(pane, ctx) {
      // 换汇目标固定在顶部，只有下方的全球汇率列表跟着滚
      pane.classList.add('eh-pane--stick');
      pane.innerHTML = `
        <div class="eh-section eh-stick-head">
          <div class="eh-h3">换汇目标</div>
          <div class="eh-fx-bar">
            <div class="eh-fx-field">
              <button class="eh-fx-unit" type="button" data-role="mode">
                <span data-role="unit">目标黄金</span>
                <svg class="eh-fx-unit__ico" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                  <path d="M3 6h9M9.5 3.5 12 6l-2.5 2.5M13 10H4M6.5 7.5 4 10l2.5 2.5"
                        fill="none" stroke="currentColor" stroke-width="1.4"
                        stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <input type="number" min="0.01" step="1" inputmode="decimal"
                     aria-label="目标额度" data-role="target" />
            </div>
            <button class="eh-btn" type="button" data-role="refresh">刷新行情</button>
          </div>
          <p class="eh-fx-note" data-role="mode-note"></p>
          <p class="eh-fx-status" data-role="status">…</p>
        </div>
        <div class="eh-stick-bar">
          <div class="eh-h3">全球汇率</div>
        </div>
        <div class="eh-stick-scroll">
          <p class="eh-fx-legend">
            买入 = 花黄金买该国法币（吃卖单，价越低越好）；卖出 = 卖法币换黄金（吃买单，价越高越好）。
            价格单位：黄金 / 1 单位法币。
          </p>
          <div class="eh-fx-pin" data-role="pins"></div>
          <div class="eh-fx-list" data-role="list"></div>
          <p class="eh-disclaimer">
            数据来自游戏公开挂单接口，仅供参考；实际下单请以游戏内实时行情为准。
          </p>
        </div>
      `;

      const targetInput = pane.querySelector('[data-role="target"]');
      const unitEl = pane.querySelector('[data-role="unit"]');
      const modeBtn = pane.querySelector('[data-role="mode"]');
      const modeNoteEl = pane.querySelector('[data-role="mode-note"]');
      const pinsEl = pane.querySelector('[data-role="pins"]');
      const listEl = pane.querySelector('[data-role="list"]');
      const statusEl = pane.querySelector('[data-role="status"]');
      const refreshBtn = pane.querySelector('[data-role="refresh"]');

      // 目标额度只有一个数字（默认 10）：切换黄金 / 法币只换口径，不改输入框里的值
      let mode = ctx.storage.get('mode', 'gold') === 'currency' ? 'currency' : 'gold';
      let target = Number(ctx.storage.get('target', 10));
      if (!Number.isFinite(target) || target <= 0) target = 10;
      targetInput.value = String(target);

      const rows = new Map(); // 法币 id → 行内节点，用于原地更新而不重建整块列表
      /** 置顶条目：[{ key, cls, label, currency }]。 */
      let pinEntries = [];
      const pinViews = new Map(); // key → { view, entry, quote }
      let pinLoaded = false;
      let pinHint = '';
      let alive = true;
      let targetTimer = 0;

      // 常驻的「暂无数据」提示，只在列表没有行时出现
      const emptyEl = document.createElement('p');
      emptyEl.className = 'eh-empty';
      emptyEl.textContent = '还没有行情数据，点「刷新行情」抓取一次。';
      emptyEl.hidden = true;
      listEl.appendChild(emptyEl);

      const setStatus = (text, tone) => {
        if (!alive) return;
        statusEl.textContent = text;
        if (tone) statusEl.dataset.tone = tone;
        else delete statusEl.dataset.tone;
      };

      /** 刷新失败但手里还有旧行情时，必须说清楚下方数据不是本次结果。 */
      const failStatus = (text, tone) => {
        setStatus(fxFeed.quotes.length ? text + ' · 下方为上次结果' : text, tone);
      };

      const tokenHint = authHint;

      const goldLabel = (value) => {
        const rounded = Math.round(value * 100) / 100;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
      };

      const syncEmpty = () => {
        emptyEl.hidden = fxFeed.quotes.length > 0 || fxFeed.loading;
      };

      const buildFlag = (quote) => buildFlagEl(quote.code, quote.avatar);

      /** 按当前目标口径（黄金 / 法币）沿挂单逐档吃单，数字都取输入框里的同一个值。 */
      const fillFor = (levels) => (mode === 'gold' ? fxFill(levels, target) : fxFillQty(levels, target));

      /**
       * 一行的骨架只建一次，之后数据回来只改内容，转圈动画不会被重建打断。
       * pin 非空时是置顶行：多一枚标签，配色由调用方给的 cls 决定。
       */
      const createRow = (quote, pin) => {
        const el = document.createElement('div');
        el.className = 'eh-fx-row' + (pin ? ' eh-fx-row--pin ' + pin.cls : '');

        const head = document.createElement('div');
        head.className = 'eh-fx-head';
        head.appendChild(buildFlag(quote));

        const codeEl = document.createElement('span');
        codeEl.className = 'eh-fx-code';
        codeEl.textContent = quote.code;
        head.appendChild(codeEl);

        const nameEl = document.createElement('span');
        nameEl.className = 'eh-fx-name';
        const locale = fxLocale(quote.code);
        if (locale) {
          const zhEl = document.createElement('b');
          zhEl.className = 'eh-fx-name__zh';
          zhEl.textContent = locale[0];
          nameEl.appendChild(zhEl);
        }
        const enEl = document.createElement('span');
        enEl.className = 'eh-fx-name__en';
        enEl.textContent = quote.country;
        enEl.title = quote.country;
        nameEl.appendChild(enEl);
        head.appendChild(nameEl);

        if (pin) {
          const labelEl = document.createElement('span');
          labelEl.className = 'eh-fx-pin-label';
          labelEl.textContent = pin.label;
          labelEl.title = pin.label;
          head.appendChild(labelEl);
        }

        // 去货币市场：URL 直接带货币 id（/monetary-market/{currency_id}）
        // 这行还在加载时先不露箭头，数据到了再显示
        const tail = document.createElement('span');
        tail.className = 'eh-fx-tail';
        const go = buildGoButton('去货币市场（' + quote.code + '）', '/monetary-market/' + quote.id);
        go.hidden = quote.status === 'pending';
        tail.appendChild(go);

        const spin = document.createElement('span');
        spin.className = 'eh-fx-spin';
        spin.setAttribute('aria-hidden', 'true');
        tail.appendChild(spin);
        head.appendChild(tail);

        const buyLine = document.createElement('div');
        buyLine.className = 'eh-fx-line';
        const sellLine = document.createElement('div');
        sellLine.className = 'eh-fx-line';

        el.appendChild(head);
        el.appendChild(buyLine);
        el.appendChild(sellLine);

        return { el, spin, buyLine, sellLine, go };
      };

      const buildRow = (quote) => {
        const view = createRow(quote, null);
        rows.set(quote.id, view);
        listEl.appendChild(view.el);
      };

      /**
       * 一个方向占一行：方向徽标里带最优质，后面直接跟这笔目标额度的成交结果。
       * 均价与最优质几乎一样时（只吃了一档）就不再重复写一遍；
       * 吃不满时徽标里的价格直接换成成交均价，行尾只留「深度不足」。
       */
      const paintLine = (el, side, best, fill, code, emptyText) => {
        const isBuy = side === 'buy';
        const label = isBuy ? '买' : '卖';

        if (best == null || fill.avg == null) {
          el.innerHTML =
            `<span class="eh-fx-tag eh-fx-tag--idle">${label}<b>—</b></span>` +
            `<span class="eh-fx-flow">${emptyText}</span>`;
          el.title = '';
          return;
        }

        const fiat = mode === 'currency';
        // 按法币算时黄金数是结果，可能很小，用 fxGold 保留足够位数
        const gold =
          goldIconHtml('eh-gold-ico--sm') + '<b>' + (fiat ? fxGold(fill.gold) : goldLabel(fill.gold)) + '</b>';
        const flow = isBuy
          ? gold + ' → <b>' + fxQty(fill.currency) + '</b> ' + code
          : '<b>' + fxQty(fill.currency) + '</b> ' + code + ' → ' + gold;
        // 只吃了一档时均价 == 最优质，没必要再写一遍
        const samePrice = Math.abs(fill.avg - best) / best <= 0.002;
        // 吃不满（深度不足）时行尾空间紧张：直接把徽标里的价格换成成交均价，
        // 不再在后面补一个「均价」，否则一行挤两三个价格、读起来太长。
        const deep = !fill.filled;
        const tagAvg = deep && !samePrice;

        el.innerHTML =
          `<span class="eh-fx-tag eh-fx-tag--${side}">${label}` +
          (tagAvg ? '<span class="eh-fx-tag__avg">均价</span>' : '') +
          `<b>${fxPrice(tagAvg ? fill.avg : best)}</b></span>` +
          `<span class="eh-fx-flow">${flow}</span>` +
          (deep || samePrice ? '' : `<span class="eh-fx-avg">均价 <b>${fxPrice(fill.avg)}</b></span>`) +
          (deep ? '<span class="eh-fx-deep">深度不足</span>' : '');

        el.title =
          label +
          '：' +
          (tagAvg
            ? '成交均价 ' +
              fxPrice(fill.avg) +
              '（最优 ' +
              fxPrice(best) +
              '，挂单不够，只成交了一部分）'
            : '最优 ' +
              fxPrice(best) +
              (mode === 'currency'
                ? '，换 ' + fxQty(target) + ' 单位的成交均价 '
                : '，目标额度成交均价 ') +
              fxPrice(fill.avg) +
              (deep ? '（挂单不够，只成交了一部分）' : ''));
      };

      const paintView = (view, quote) => {
        if (!view || !quote) return;

        const pending = quote.status === 'pending';
        const failed = quote.status === 'error';

        view.spin.hidden = !pending;
        view.go.hidden = pending;
        view.el.classList.toggle('is-error', failed);
        view.buyLine.hidden = pending;
        view.sellLine.hidden = pending;
        if (pending) return;

        if (failed) {
          view.sellLine.hidden = true;
          view.buyLine.innerHTML =
            '<span class="eh-fx-tag eh-fx-tag--idle">拉取失败</span>' +
            '<span class="eh-fx-flow">稍后点「刷新行情」会重新拉取</span>';
          view.buyLine.title = '';
          return;
        }

        view.sellLine.hidden = false;

        const code = escapeHtml(quote.code);
        const ask = quote.asks.length ? quote.asks[0].price : null;
        const bid = quote.bids.length ? quote.bids[0].price : null;
        const buy = fillFor(quote.asks);
        const sell = fillFor(quote.bids);

        paintLine(view.buyLine, 'buy', ask, buy, code, '暂无卖单');
        paintLine(view.sellLine, 'sell', bid, sell, code, '暂无买单');
      };

      const paintRow = (quote) => paintView(rows.get(quote.id), quote);

      /* -------- 置顶：玩家国籍 / 当前所在国的汇率 -------- */

      /** 置顶行用的行情：优先取共享行情，行情里没有（两侧都没挂单）就按国家清单拼个占位行。 */
      const pinQuote = (currency, found) => {
        if (found) {
          // 国名 / 国旗按玩家所在的那一国取，别用货币去重时留下的第一个国家
          return Object.assign({}, found, { country: currency.country, avatar: currency.avatar });
        }
        return {
          id: currency.id,
          code: currency.code,
          country: currency.country,
          avatar: currency.avatar,
          asks: [],
          bids: [],
          status: 'ok'
        };
      };

      const paintPin = (item) => {
        const currency = item.entry.currency;
        const found = fxFeed.quotes.find((quote) => quote.id === currency.id);
        item.quote = pinQuote(currency, found);

        // 还在拉：跟着转圈，别提前写「暂无卖单」
        if (!found && fxFeed.loading) {
          item.view.spin.hidden = false;
          item.view.el.classList.remove('is-error');
          item.view.buyLine.hidden = true;
          item.view.sellLine.hidden = true;
          return;
        }

        // 行情一次都没拉过：写「未加载」，不要把「没数据」说成「没挂单」
        if (!found && !fxFeed.updatedAt) {
          item.view.spin.hidden = true;
          item.view.el.classList.remove('is-error');
          item.view.buyLine.hidden = false;
          item.view.sellLine.hidden = true;
          item.view.buyLine.innerHTML =
            '<span class="eh-fx-tag eh-fx-tag--idle">未加载</span>' +
            '<span class="eh-fx-flow">点「刷新行情」后显示</span>';
          item.view.buyLine.title = '';
          return;
        }

        paintView(item.view, item.quote);
      };

      const repaintPins = () => pinViews.forEach((item) => paintPin(item));

      /** 已置顶的货币从全球列表里收起来，同一个汇率不出现两次。 */
      const syncPinnedInList = () => {
        const hide = new Set();
        if (pinLoaded) pinEntries.forEach((entry) => hide.add(String(entry.currency.id)));
        rows.forEach((view, id) => view.el.classList.toggle('is-pinned', hide.has(String(id))));
      };

      const renderPins = () => {
        if (!alive) return;
        pinViews.forEach((item) => item.view.el.remove());
        pinViews.clear();
        pinsEl.textContent = '';

        if (!pinLoaded) return;

        if (!pinEntries.length) {
          if (pinHint) {
            const hint = document.createElement('p');
            hint.className = 'eh-fx-pin-hint';
            hint.textContent = pinHint;
            pinsEl.appendChild(hint);
          }
          syncPinnedInList();
          return;
        }

        pinEntries.forEach((entry) => {
          const view = createRow(entry.currency, entry);
          pinsEl.appendChild(view.el);
          const item = { view, entry, quote: null };
          pinViews.set(entry.key, item);
          paintPin(item);
        });
        syncPinnedInList();
      };

      /**
       * 读一次账号的两个 id（与「市场」共用 playerFeed 缓存），
       * 再把国家换成法币，决定置顶哪两行。
       */
      const readPins = async () => {
        let info = null;
        let reason = '';
        try {
          info = await playerFeed.ensure();
        } catch (err) {
          info = playerFeed.info;
          const code = err && err.code;
          reason = code === 'NO_TOKEN' || code === 'UNAUTHORIZED' ? 'no-token' : 'missing';
        }
        if (!alive) return;

        if (info) {
          try {
            await fxFeed.ensureCountries();
          } catch (err) {
            /* 清单拉不到：下面按「没读到」处理 */
          }
        }
        if (!alive) return;

        const home = info && info.nationalityId ? fxFeed.currencyOfCountry(info.nationalityId) : null;
        const here = info && info.countryId ? fxFeed.currencyOfCountry(info.countryId) : null;

        const entries = [];
        if (home) entries.push({ key: 'home', cls: 'eh-fx-row--pin-home', label: '玩家国籍', currency: home });
        if (here) {
          // 国籍与所在国是同一种货币时合成一行，别并排显示两遍
          if (home && String(home.id) === String(here.id)) {
            entries[0].label = '玩家国籍 · 当前位置';
          } else {
            entries.push({ key: 'here', cls: 'eh-fx-row--pin-here', label: '当前位置', currency: here });
          }
        }

        pinEntries = entries;
        pinLoaded = true;
        pinHint = entries.length
          ? ''
          : reason === 'no-token'
            ? '还没拿到登录凭据，读到账号后会自动置顶本国汇率。'
            : '没读到你的国籍与所在国家，暂时无法置顶本国汇率。';
        renderPins();
        syncPinnedInList();
        ctx.ui.reposition();
      };

      /** 同一时刻只跑一次（挂载 / 一轮行情结束 / 点刷新可能同时触发）。 */
      let pinPromise = null;
      const loadPins = () => {
        if (pinPromise) return pinPromise;
        pinPromise = readPins().then(
          () => {
            pinPromise = null;
          },
          () => {
            pinPromise = null;
          }
        );
        return pinPromise;
      };

      /** 按买入均价升序；还没拿到数据 / 拉取失败的排最后。 */
      const sortList = () => {
        const keyed = fxFeed.quotes.map((quote) => ({
          quote,
          avg: quote.status === 'ok' ? fillFor(quote.asks).avg : null
        }));
        keyed.sort((a, b) => {
          const av = a.avg == null ? Infinity : a.avg;
          const bv = b.avg == null ? Infinity : b.avg;
          if (av !== bv) return av - bv;
          return a.quote.code.localeCompare(b.quote.code);
        });
        keyed.forEach((item) => {
          const view = rows.get(item.quote.id);
          if (view) listEl.appendChild(view.el);
        });
      };

      /** 把共享行情同步到本标签：只增删改必要的行，转圈动画不会被打断。 */
      const sync = (kind, quote) => {
        if (!alive) return;

        if (kind === 'reset') {
          rows.forEach((view) => view.el.remove());
          rows.clear();
          fxFeed.quotes.forEach((item) => {
            buildRow(item);
            paintRow(item);
          });
        } else if (kind === 'row' && quote) {
          if (rows.has(quote.id)) paintRow(quote);
          else {
            buildRow(quote);
            paintRow(quote);
          }
        } else if (kind === 'drop' && quote) {
          const view = rows.get(quote.id);
          if (view) view.el.remove();
          rows.delete(quote.id);
        }

        refreshBtn.disabled = fxFeed.loading;
        syncEmpty();
        updateStatus();
        // 置顶行跟着同一份行情走，并同步隐藏列表里的同种货币
        repaintPins();
        syncPinnedInList();
        // 加载中不动顺序，等收尾统一排，免得边填数边跳行
        if (!fxFeed.loading) sortList();
        if (kind === 'reset' || kind === 'done') ctx.ui.reposition();
      };

      const updateStatus = () => {
        if (!alive) return;
        const feed = fxFeed;

        if (feed.loading) {
          const step = feed.progress;
          if (step.phase === 'retry' && step.retryTotal) {
            setStatus(`正在重试 ${step.retryIndex}/${step.retryTotal}…`);
          } else if (!step.total) {
            setStatus('正在读取国家与货币清单…');
          } else {
            setStatus(`正在拉取挂单 ${step.done}/${step.total}…`);
          }
          return;
        }

        const err = feed.error;
        if (err && err.code === 'PARTIAL') {
          const okCount = feed.quotes.filter((item) => item.status === 'ok').length;
          const tail = err.limited ? '（含 429，可能已达当日查询上限，可到「设置」页生成专用密钥）' : '';
          setStatus(
            `${okCount} 种货币有挂单 · 更新于 ${formatClock(feed.updatedAt)} · ${err.count} 个拉取失败${tail}`,
            err.limited ? 'error' : undefined
          );
          return;
        }
        if (err && err.code === 'STALE_COUNTRIES') {
          // 行情本身是成功的，只是国家清单这次没刷新成功
          const okCount = feed.quotes.filter((item) => item.status === 'ok').length;
          setStatus(
            `${okCount} 种货币有挂单 · 更新于 ${formatClock(feed.updatedAt)} · 国家清单本次刷新失败，用的是上次结果`,
            'warn'
          );
          return;
        }
        if (err) {
          if (err.code === 'NO_TOKEN') failStatus(tokenHint(), 'warn');
          else if (err.code === 'UNAUTHORIZED') failStatus(tokenHint(), 'error');
          else if (err.code === 'TIMEOUT') failStatus('请求超时，请稍后重试。', 'error');
          else if (quotaHint(err)) failStatus(quotaHint(err), 'error');
          else failStatus('拉取失败：' + fetchErrorText(err), 'error');
          return;
        }

        if (!feed.updatedAt) {
          setStatus('还没有行情数据，点「刷新行情」抓取一次。');
          return;
        }
        const okCount = feed.quotes.filter((item) => item.status === 'ok').length;
        setStatus(`${okCount} 种货币有挂单 · 更新于 ${formatClock(feed.updatedAt)}`);
      };

      /** 切换口径只换标签与说明（图标保留在按钮里），输入框里的数字保持原样。 */
      const applyModeUi = () => {
        const gold = mode === 'gold';
        unitEl.textContent = gold ? '目标黄金' : '目标法币';
        modeBtn.title = gold
          ? '点击切换为「目标法币」：按要换到的法币数量反算需要多少黄金'
          : '点击切换为「目标黄金」：按要花的黄金数量算能换到多少法币';
        modeBtn.setAttribute('aria-label', modeBtn.title);
        modeNoteEl.textContent = gold
          ? '按黄金算：每种货币各花这么多黄金，能换到多少法币。'
          : '按法币算：每种货币各换这么多单位，需要花多少黄金。';
      };

      const repaintAll = () => {
        fxFeed.quotes.forEach((quote) => paintRow(quote));
        repaintPins();
        // 加载中不动顺序，等收尾统一排，免得边填数边跳行
        if (!fxFeed.loading) sortList();
        ctx.ui.reposition();
      };

      /**
       * 把输入框里的数字落定（可能还在防抖里），不发请求。
       * 空串 / 0 / 只打了个负号时**不落定、也不改写输入框**：玩家清空多半是准备重打，
       * 这时塞回「10」会逼着他先删掉再输入。返回是否拿到了新的有效值。
       */
      const commitTarget = () => {
        const value = Number(targetInput.value);
        if (!Number.isFinite(value) || value <= 0) return false;
        target = value;
        ctx.storage.set('target', target);
        return true;
      };

      /** 空着 / 不合法时才在收尾时机（失焦、回车、切口径）把上一次的有效值补回去。 */
      const restoreTarget = () => {
        if (commitTarget()) return;
        targetInput.value = String(target);
      };

      const applyTarget = () => {
        if (!commitTarget()) return; // 还没输完就保持现状，别用旧值重算、更别改输入框
        repaintAll();
      };

      on(targetInput, 'input', () => {
        clearTimeout(targetTimer);
        targetTimer = window.setTimeout(applyTarget, 220);
      });
      // change 在失焦 / 回车时触发：这时才把留空的输入框补回有效值
      on(targetInput, 'change', () => {
        clearTimeout(targetTimer);
        restoreTarget();
        repaintAll();
      });
      on(targetInput, 'blur', restoreTarget);

      // 面板在 Shadow DOM 内，游戏若在 document 上监听事件，拿到的 target 会被重定向成宿主元素，
      // 很容易被当成「在页面里按键」；这里把输入框的按键拦在组件内部，避免打字误触游戏快捷键。
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        on(targetInput, type, (event) => event.stopPropagation());
      });

      on(modeBtn, 'click', () => {
        // 先落定输入框里可能还在防抖中的数字（空着就补回上一次的有效值），
        // 再换口径重算，避免界面上是 20 却按 10 算
        clearTimeout(targetTimer);
        restoreTarget();
        mode = mode === 'gold' ? 'currency' : 'gold';
        ctx.storage.set('mode', mode);
        applyModeUi();
        repaintAll();
      });

      on(refreshBtn, 'click', () => {
        fxFeed.refresh();
        loadPins();
      });

      // 凭据晚到（面板先开、游戏还没发过请求）：账号能读到后补一次置顶，行情仍由玩家点刷新
      const offAuth = apiClient.onAuth(() => {
        if (alive && !pinEntries.length) loadPins();
      });

      // 账号字段（国籍 / 所在国）变了就重建置顶行：别的页面刷新到的位置，这里立刻跟上，
      // 不再靠「本条页自己再 ensure 一次」这种各写一套的时机
      const offPlayer = playerFeed.watch(() => {
        if (alive) loadPins();
      });

      applyModeUi();

      // 挂载即同步：已有缓存（例如刚在「市场」里拉过）就直接复用，不再重复请求
      const off = fxFeed.subscribe((kind, quote) => {
        sync(kind, quote);
        // 一轮抓取结束后补读账号信息：国籍 / 所在国此时才可读时也能置顶
        if (kind === 'done') loadPins();
      });
      if (fxFeed.quotes.length || fxFeed.loading) sync('reset');
      else sync('state');
      fxFeed.ensure();
      loadPins();

      // 每次显示本标签：账号超过 10 秒就重问一次，行情超过 10 分钟才重拉
      ctx.onShow(() => {
        loadPins();
        if (!fxFeed.loading) fxFeed.ensure();
      });

      ctx.onDestroy(() => {
        alive = false;
        clearTimeout(targetTimer);
        off();
        offAuth();
        offPlayer();
      });
    }
  });

  /* -------- 9.3 商品比价：各国市场挂单折算成黄金 -------- */

  /**
   * 商品目录：第一行是四种成品（Q1–Q5 各自独立挂单），第二行是四种原材料（无品质）。
   * icon 是接口没给商品图时的兜底，真实图片见 GOODS_AVATARS。
   */
  const GOODS_GROUPS = [
    {
      id: 'product',
      items: [
        { api: 'Food', zh: '食物', icon: '🍞' },
        { api: 'Weapon', zh: '武器', icon: '⚔️' },
        { api: 'Aircraft', zh: '飞机', icon: '✈️' },
        { api: 'Airplane ticket', zh: '机票', icon: '🎫' }
      ]
    },
    {
      id: 'material',
      items: [
        { api: 'Grain', zh: '谷物', icon: '🌾' },
        { api: 'Iron', zh: '铁', icon: '⛏️' },
        { api: 'Fuel', zh: '燃料', icon: '🛢️' },
        { api: 'Titanium', zh: '钛', icon: '💠' }
      ]
    }
  ];

  const GOODS_META = new Map();
  GOODS_GROUPS.forEach((group) => {
    group.items.forEach((item) => GOODS_META.set(item.api, item));
  });

  const GOODS_QUALITIES = [1, 2, 3, 4, 5];

  /** 按键索引：原材料 quality=0，成品 Q1–Q5。 */
  const GOODS_ITEMS = (() => {
    const list = [];
    GOODS_GROUPS.forEach((group) => {
      group.items.forEach((item) => {
        const qualities = group.id === 'product' ? GOODS_QUALITIES : [0];
        qualities.forEach((quality) => {
          list.push({
            key: item.api + '#' + quality,
            api: item.api,
            zh: item.zh,
            icon: item.icon,
            quality,
            label: quality ? item.zh + ' Q' + quality : item.zh
          });
        });
      });
    });
    return list;
  })();

  const GOODS_BY_KEY = new Map(GOODS_ITEMS.map((item) => [item.key, item]));

  /** 中文商品名 → 接口 api 名：游戏市场页只有中文名，靠它反查回挂单里的键。 */
  const GOODS_API_BY_ZH = new Map(
    GOODS_GROUPS.reduce((list, group) => list.concat(group.items.map((item) => [item.zh, item.api])), [])
  );

  /**
   * 各国商品行情的共享缓存。
   * 面板「市场」页抓完后写进这里，游戏市场页的金价标注读它算「比全球最低贵多少」。
   * 这里绝不主动发请求：为一个参考值把 45 个国家的市场再拉一遍不划算，
   * 没有数据时标注就只显示本国金价。
   */
  const goodsFeed = (() => {
    const listeners = new Set();
    let markets = [];

    const notify = () => {
      [...listeners].forEach((fn) => {
        try {
          fn();
        } catch (err) {
          warn('商品行情订阅回调异常', err);
        }
      });
    };

    return {
      get markets() {
        return markets;
      },
      get ready() {
        return markets.some((entry) => entry && entry.items && entry.items.size);
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      /** 面板市场页拉完后写入（含流亡政府标记，算最低价时要跳过）。 */
      publish(list) {
        markets = Array.isArray(list) ? list : [];
        notify();
      },
      /**
       * 某个商品（api#quality）的全球最低黄金单价。
       * 汇率只认「汇率」页已有的缓存，缺汇率的国家跳过，不额外请求。
       */
      bestGold(key) {
        let best = null;
        markets.forEach((entry) => {
          if (!entry || entry.exiled) return;
          const item = entry.items && entry.items.get(key);
          if (!item || !(item.price > 0)) return;
          const rate = fxFeed.rateFor(entry.currency.id);
          if (!(rate > 0)) return;
          const gold = item.price * rate;
          if (!best || gold < best.gold) {
            best = { gold, country: entry.name, code: entry.currency.code };
          }
        });
        return best;
      }
    };
  })();

  /** api 名 → 商品图地址：从挂单里顺手收集，同一件商品各国各品质共用一个图标。 */
  const GOODS_AVATARS = new Map();

  /**
   * 领土：GET /country/regions?country_id=…，返回该国目前实际占有的地区。
   * 已失去全部领土的国家不会返回空数组，而是只有 { code: 200, description: '成功' }、没有 data，
   * 所以这里要 allowEmpty 放行，由调用方把「没有 data」当成没有领土。
   * 这个接口只认 GET（同地址的 POST 是 404，路由根本不存在），所以只发 GET：
   * noMethodRetry 挡掉通用逻辑里「GET 404/405 就改发空表单 POST」的兜底，
   * 失败直接上报，由调用方按「领土未知」处理，不浪费额度也不制造假的 POST。
   */
  async function goodsFetchRegions(countryId) {
    const path = '/country/regions?country_id=' + encodeURIComponent(String(countryId));
    return apiClient.call(path, { noMethodRetry: true, allowEmpty: true });
  }

  /**
   * 地区清单的唯一数据源（GET /country/regions?country_id=…），底层走 apiCache：
   * 「市场」的领土检查、市场页的地区快捷跳转、工商面板的工业 / 税费都用这一份，
   * 同一国家 10 分钟内只请求一次，并发调用由 apiCache 合并成同一个请求。
   * 失效只有两个入口：`refresh`（绕过 TTL，失败保留旧值）与 `clear`（destroy）。
   */
  const regionFeed = (() => {
    const PREFIX = '/country/regions';
    /**
     * 领土 10 分钟：战争不会每分钟易手，但面板上的「刷新」能立刻看到新结果。
     * 空结果谓词要单独给：失土国家的载荷是「没有 data」，默认规则（空数组）认不出来，
     * 那条 entry 会被标成「非空」，将来按 empty 判流亡就会判错。
     */
    const OPTS = {
      ttl: 'regions',
      namespace: 'regions',
      empty: (value) => !Array.isArray(value) || value.length === 0
    };

    const cacheKey = (countryId) => apiCache.key(PREFIX, { country_id: String(countryId) });
    const loaderFor = (countryId) => () => goodsFetchRegions(countryId);

    /**
     * 载荷归一：没有 data（已失去全部领土）与空数组都算空清单。
     * 拿到 null 说明缓存被整体清空（换凭据 / destroy），本轮结果作废、按失败上报，
     * 不能当成「没有领土」，否则会把国家误判成流亡政府。
     */
    const toList = (entry) => {
      if (!entry) {
        const error = new Error('DROPPED');
        error.code = 'DROPPED';
        throw error;
      }
      return Array.isArray(entry.value) ? entry.value : [];
    };

    /** 已缓存且未过期时返回清单，否则 null（同步读取，界面可以先用旧数据顶上）。 */
    function get(countryId) {
      const key = cacheKey(countryId);
      if (!apiCache.fresh(key)) return null;
      const entry = apiCache.peek(key);
      return entry && Array.isArray(entry.value) ? entry.value : [];
    }

    /**
     * 该国家地区清单的缓存时间；没拉过 / 已被清掉返回 0。
     * 「更新于」按这屏里最旧的一份数据算，不能拿「本轮结束时刻」冒充新鲜度。
     */
    function atOf(countryId) {
      const entry = apiCache.peek(cacheKey(countryId));
      return entry ? entry.at : 0;
    }

    /** 拉一个国家的地区清单：10 分钟内命中缓存，并发共享同一请求，失败 60 秒内不重试。 */
    function ensure(countryId) {
      return apiCache.ensure(cacheKey(countryId), loaderFor(countryId), OPTS).then(toList);
    }

    /**
     * 忽略 TTL 重抓一个国家（面板上的「刷新」）。已有在途请求时先等它结束，
     * 再补一次真正的刷新，不会因为 in-flight 而把这次刷新静默吞掉。
     */
    async function refresh(countryId) {
      const key = cacheKey(countryId);
      const loader = loaderFor(countryId);
      if (apiCache.busy(key)) {
        try {
          await apiCache.ensure(key, loader, OPTS);
        } catch (err) {
          /* 在途那轮失败也要补一次刷新 */
        }
      }
      return toList(await apiCache.refresh(key, loader, OPTS));
    }

    return {
      get,
      atOf,
      ensure,
      refresh,
      /** 领土已知且为空 = 流亡政府；还没查过时返回 null，由调用方决定怎么处理。 */
      exiled(countryId) {
        const list = get(countryId);
        return list ? list.length === 0 : null;
      },
      clear() {
        apiCache.invalidate(PREFIX);
      }
    };
  })();

  /**
   * 一个市场里同一件商品可能有多档挂单，只留最便宜的一档。
   * 买家只付挂单价：进口税是境外卖家在成交后被扣的，不加到买方成本里
   * （所以这里也不看 import_tax）。
   */
  function goodsIndex(offers) {
    const byItem = new Map();
    (Array.isArray(offers) ? offers : []).forEach((offer) => {
      if (!offer) return;
      const key = String(offer.name) + '#' + Number(offer.quality || 0);

      // 顺手记下商品图（放在价格过滤之前：即使这条挂单被跳过，图也有用）
      if (offer.avatar && !GOODS_AVATARS.has(String(offer.name))) {
        const src = fxAvatarUrl(offer.avatar);
        if (src) GOODS_AVATARS.set(String(offer.name), src);
      }

      const price = Number(offer.value);
      const supply = Number(offer.supply);
      if (!(price > 0) || !(supply > 0)) return;

      const best = byItem.get(key);
      if (!best || price < best.price) byItem.set(key, { price, supply });
    });
    return byItem;
  }

  /* -------- 9.3a 全球商品行情快照：面板与自动比价共用 -------- */

  /** 行情快照的有效期：与汇率一致（10 分钟）；自动模式据此决定什么时候重拉。 */
  const GOODS_CACHE_MS = 10 * 60 * 1000;
  const GOODS_PATH = '/market/get';
  /** 单国市场挂单：10 分钟；没有挂单的国家也记成空结果，别反复问。 */
  const GOODS_OPTS = {
    ttl: 'goods',
    namespace: 'goods',
    empty: (value) => value instanceof Map && value.size === 0
  };

  /**
   * 全球商品行情快照：面板「市场」页与「商品市场自动加载比价数据」共用同一份。
   * 统一负责抓取、并发去重、TTL 判断与过期重拉；抓完自动 publish 给 goodsFeed，
   * 游戏市场页的金价标注据此算「比全球最低贵多少」。
   *
   * 订阅回调签名 (kind, payload)：
   *   reset —— 新一轮开始，entries 重建为待抓清单；
   *   entry —— 某个市场拉完（payload 为该 entry，items 已就绪）；
   *   drop  —— 该市场拉取失败（payload 为该 entry）；
   *   done  —— 本轮结束，entries 只保留拉成功的市场；
   *   error —— 整轮失败（payload 为 err），已回滚上一份结果；
   *   state —— 加载状态 / 进度 / 错误变化。
   */
  const goodsSnapshot = (() => {
    const listeners = new Set();
    /** 抓取中：全部国家（含 pending / error）；结束后只保留成功的市场。 */
    let entries = [];
    /** 这屏数据里最旧的一份：命中缓存时要如实报旧，不能拿「本轮结束时刻」冒充。 */
    let updatedAt = 0;
    /** 最近一次整轮检查结束的时刻：只用于「多久之后再自动拉一轮」的调度。 */
    let checkedAt = 0;
    let loading = false;
    let error = null;
    /** 上一次失败的时间：面板反复切标签时不要每次都重打一轮。 */
    let errorAt = 0;
    let progress = { done: 0, total: 0 };
    let failures = 0;
    let landFailures = 0;
    let limited = false;
    let cancelled = false;
    let promise = null;

    const notify = (kind, payload) => {
      [...listeners].forEach((fn) => {
        try {
          fn(kind, payload);
        } catch (err) {
          warn('商品行情订阅回调异常', err);
        }
      });
    };

    /**
     * 领土检查：地区清单为空即流亡政府（已失去全部领土）。
     * 只查有挂单的国家——没挂单的市场本来就不进列表，没必要多打请求。
     * 走 regionFeed 缓存，与地区快捷跳转、工商面板共用，同一国家 10 分钟内只请求一次；
     * 请求本身失败（超时 / 4xx / 429）才按「有领土」处理，宁可留在主列表也不误判。
     */
    const checkLand = async (entry) => {
      const list = await regionFeed.ensure(entry.id);
      entry.exiled = list.length === 0;
    };

    /**
     * 凭据晚到的场景：面板可能在游戏还没发过任何接口请求时就打开了，
     * 这时先挂一次 apiClient.onAuth，等登录凭据被捕获后自动补一轮，
     * 而不是让面板停在空列表上等玩家手动点「刷新行情」。
     * （与「商品市场自动加载比价数据」无关：那个开关只管游戏市场页的自动刷新。）
     */
    let offAuthRetry = null;
    const armAuthRetry = () => {
      if (offAuthRetry) return;
      offAuthRetry = apiClient.onAuth(() => {
        offAuthRetry = null;
        if (!loading && !updatedAt) load();
      });
    };

    /**
     * 拉一轮全球行情。mode='ensure' 命中 10 分钟缓存（打开面板、自动比价），
     * 'refresh' 绕过 TTL（「刷新行情」）。单国市场的解析结果存在 apiCache 里，
     * 本轮只维护编排（entries / 进度 / 流亡标记 / publish）。
     */
    function run(mode) {
      if (loading) return promise;
      if (apiClient.state !== 'ok') {
        error = { code: 'NO_TOKEN' };
        errorAt = Date.now();
        armAuthRetry();
        notify('state');
        return Promise.resolve(null);
      }

      // 真正开始抓了：之前挂着的「等凭据」回调可以摘掉了
      if (offAuthRetry) {
        offAuthRetry();
        offAuthRetry = null;
      }

      loading = true;
      error = null;
      failures = 0;
      landFailures = 0;
      limited = false;
      progress = { done: 0, total: 0 };
      // 本次失败时放回去，别让已有结果凭空消失
      const previous = entries.filter((entry) => entry.status === 'ok');
      cancelled = false;
      notify('state');

      promise = (async () => {
        try {
          // 汇率与市场并行：汇率优先吃缓存，只有缓存过期才真的去拉
          fxFeed.ensure().catch(() => null);
          // 「刷新行情」连国家清单一起绕过页面级 TTL，否则清单刚拉过的话刷新等于没刷
          const countries = await fxFeed.loadCountries(mode === 'refresh' ? 'refresh' : 'ensure');
          if (cancelled) return;

          const list = (Array.isArray(countries) ? countries : [])
            .filter((country) => {
              const currency = country && country.currency;
              if (!currency || !currency.id || !currency.name) return false;
              if (String(currency.name).toLowerCase() === 'gold') return false;
              return country.is_available !== 0;
            })
            .map((country) => ({
              id: country.id,
              name: String(country.name || ''),
              avatar: country.avatar == null ? '' : String(country.avatar),
              currency: { id: country.currency.id, code: String(country.currency.name) },
              items: null,
              status: 'pending',
              exiled: false // 领土检查结果：true = 已失去全部领土
            }));

          if (!list.length) {
            const empty = new Error('没有可用的国家清单');
            empty.code = 'EMPTY_COUNTRIES';
            throw empty;
          }

          entries = list;
          progress = { done: 0, total: list.length };
          notify('reset');

          let cursor = 0;
          const worker = async () => {
            while (cursor < entries.length) {
              if (cancelled) return;
              const entry = entries[cursor];
              cursor += 1;

              // 不带 type/quality 时接口一次返回该国全部商品，一个市场只需一次请求
              const key = apiCache.key(GOODS_PATH, { countryid: String(entry.id) });
              const loader = () =>
                apiClient
                  .call(GOODS_PATH, { form: { countryid: entry.id }, object: true })
                  .then((data) => goodsIndex(data && data.offers));

              try {
                const cached =
                  mode === 'refresh'
                    ? await apiCache.refresh(key, loader, GOODS_OPTS)
                    : await apiCache.ensure(key, loader, GOODS_OPTS);
                // null 只有一种来由：请求在途期间缓存被换凭据 / destroy 清空了（结果作废）。
                // 这时不能当成「这个国家没有挂单」，要按这一国度失败处理。
                if (!cached) {
                  const dropped = new Error('DROPPED');
                  dropped.code = 'DROPPED';
                  throw dropped;
                }
                entry.items = cached.value instanceof Map ? cached.value : new Map();
                entry.status = 'ok';
              } catch (err) {
                if (err && err.code === 'UNAUTHORIZED') throw err;
                if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
                // 刷新失败但手里有上一次的数据：继续显示旧值，只在状态栏报失败数量
                const stale = apiCache.peek(key);
                if (stale && stale.value instanceof Map) {
                  entry.items = stale.value;
                  entry.status = 'ok';
                } else {
                  entry.status = 'error';
                }
                failures += 1;
              }

              // 市场拉回来之后再核对领土：没挂单的国家根本不进列表，省一次请求
              if (entry.status === 'ok' && entry.items && entry.items.size) {
                try {
                  await checkLand(entry);
                } catch (err) {
                  if (cancelled) return;
                  if (err && err.code === 'UNAUTHORIZED') throw err;
                  if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
                  landFailures += 1;
                  log(
                    '领土读取失败',
                    entry.name + ' · ' + ((err && err.code) || 'ERROR') + ' ' + ((err && err.message) || '')
                  );
                }
              }

              progress = { done: progress.done + 1, total: progress.total };
              notify(entry.status === 'ok' ? 'entry' : 'drop', entry);
              await fxSleep(FX_GAP);
            }
          };

          await Promise.all(
            Array.from({ length: Math.min(FX_CONCURRENCY, entries.length) }, () => worker())
          );
          if (cancelled) return;

          // 领土查不到不影响结果展示（这些国家按「有领土」留在主列表），只在调试日志里留个汇总
          if (landFailures) log('领土检查部分失败', landFailures + ' 个国家按「有领土」处理');

          errorAt = 0;
          checkedAt = Date.now();
          entries = entries.filter((entry) => entry.status === 'ok');
          // 「更新于」取各市场 key 里最旧的一份：这一轮大部分可能直接命中 10 分钟缓存
          const stamps = entries
            .map((entry) => {
              const hit = apiCache.peek(apiCache.key(GOODS_PATH, { countryid: String(entry.id) }));
              return hit ? hit.at : 0;
            })
            .filter(Boolean);
          updatedAt = stamps.length ? Math.min.apply(null, stamps) : checkedAt;
          // 共享给游戏市场页的金价标注：它要拿这份数据算「比全球最低贵多少」
          goodsFeed.publish(entries);
        } catch (err) {
          entries = previous;
          if (err && err.code === 'UNAUTHORIZED') cancelled = true;
          error = {
            code: (err && err.code) || 'ERROR',
            message: err && err.message,
            // 保留冷却信息：状态栏要据此说明「还要等多久」，别只显示 COOLDOWN
            retryAt: (err && err.retryAt) || 0,
            reason: (err && err.reason) || '',
            limited
          };
          errorAt = Date.now();
        } finally {
          loading = false;
          promise = null;
          // 中止（destroy）不算结束：只更新状态，不发 done
          if (!cancelled) notify(error ? 'error' : 'done');
          notify('state');
        }
      })();

      return promise;
    }

    return {
      get entries() {
        return entries;
      },
      get updatedAt() {
        return updatedAt;
      },
      /** 最近一次整轮检查结束的时刻（调度用，不用于展示）。 */
      get checkedAt() {
        return checkedAt;
      },
      get loading() {
        return loading;
      },
      get error() {
        return error;
      },
      get progress() {
        return progress;
      },
      get failures() {
        return failures;
      },
      get landFailures() {
        return landFailures;
      },
      get limited() {
        return limited;
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      /** 缓存还在有效期内就直接用，否则拉一轮；并发调用共享同一个请求。 */
      ensure(maxAge) {
        if (loading) return promise;
        const age = maxAge == null ? GOODS_CACHE_MS : maxAge;
        const now = Date.now();
        // 用「上次检查时刻」而不是「最旧数据时刻」判要不要再跑一轮，
        // 否则某个国家一直失败会把时间拖旧，切一次标签就重跑一轮
        if (checkedAt && now - checkedAt < age && entries.length) return Promise.resolve(entries);
        // 刚失败过：一分钟内不自动重试（手动点「刷新行情」走 refresh，不受此限）
        if (error && errorAt && now - errorAt < 60 * 1000) return Promise.resolve(null);
        return run('ensure');
      },
      /** 命中单国市场缓存（10 分钟），只补缺失的国家。 */
      load: () => run('ensure'),
      /** 「刷新行情」：绕过 TTL 重抓，失败保留旧值。 */
      refresh: () => run('refresh'),
      cancel() {
        if (offAuthRetry) {
          offAuthRetry();
          offAuthRetry = null;
        }
        // 只停止继续发起新的国家，已发出且可能被别的面板共享的请求不 abort
        cancelled = true;
      }
    };
  })();

  /* -------- 9.3b 自动比价：启动即抓、按缓存有效期自动更新 -------- */

  /**
   * 「商品市场自动加载比价数据」开关（默认关闭）。
   * 开启后插件启动就抓一次全球汇率与商品行情，之后每分钟在本地看一次快照年龄，
   * 超过 GOODS_CACHE_MS 才真正重拉；后台标签页不刷新，凭据没到手时等 onAuth 再补。
   * 一轮要 45 个国家的市场 + 换汇 + 领土请求，所以默认关闭，
   * 开启前会在「市场」页明确提示请求量与启动变慢的风险。
   * 它只负责游戏市场页的「不打开面板也能比价」，面板本身始终会自己抓取行情。
   */
  const goodsAuto = (() => {
    /** 本地检查间隔：只比时间戳，不发请求。 */
    const CHECK_MS = 60 * 1000;
    /** 启动后稍等再抓：先让游戏自己的首屏请求跑完，避免明显拖慢加载。 */
    const BOOT_DELAY_MS = 3000;
    /** 失败退避：接口异常时别每分钟都打一轮上百次请求。 */
    const RETRY_MS = 5 * 60 * 1000;

    const listeners = new Set();
    let enabled = storage.read('autoCompare', false) === true;
    let timer = 0;
    let kick = 0;
    let lastAttemptAt = 0;
    let offAuth = null;

    const notify = () => {
      [...listeners].forEach((fn) => {
        try {
          fn(enabled);
        } catch (err) {
          warn('自动比价订阅回调异常', err);
        }
      });
    };

    const sync = () => {
      if (!enabled || destroyed || !booted) return;
      if (document.visibilityState === 'hidden') return;
      // 凭据还没捕获到时先不动，由 apiClient.onAuth 触发一次
      if (apiClient.state !== 'ok') return;
      if (goodsSnapshot.loading) return;

      const now = Date.now();
      // 缓存还没过期：什么都不做（下次检查继续等）
      if (goodsSnapshot.checkedAt && now - goodsSnapshot.checkedAt < GOODS_CACHE_MS) return;
      // 上一轮失败过：至少隔 5 分钟再试，避免烧光额度
      if (lastAttemptAt && now - lastAttemptAt < RETRY_MS) return;
      lastAttemptAt = now;
      goodsSnapshot.load();
    };

    function start(immediate) {
      if (!enabled || destroyed) return;
      if (!offAuth) offAuth = apiClient.onAuth(sync);
      if (!timer) timer = window.setInterval(sync, CHECK_MS);
      clearTimeout(kick);
      kick = window.setTimeout(sync, immediate ? 0 : BOOT_DELAY_MS);
    }

    function stop() {
      clearTimeout(kick);
      clearInterval(timer);
      kick = 0;
      timer = 0;
      if (offAuth) {
        offAuth();
        offAuth = null;
      }
    }

    // 从后台切回来时补一次：浏览器可能已经把定时器节流了
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') sync();
    });

    return {
      get enabled() {
        return enabled;
      },
      setEnabled(next) {
        const value = next === true;
        if (value === enabled) return value;
        enabled = value;
        storage.write('autoCompare', value);
        if (value) start(true);
        else stop();
        notify();
        return value;
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      start,
      stop,
      sync
    };
  })();

  /** 当地货币金额：去掉没意义的尾随 0（0.190 → 0.19）。 */
  function goodsAmount(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value < 0.001) return value.toPrecision(3);
    const rounded = value >= 1000 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(4);
    return String(Number(rounded));
  }

  /** 税率：接口给的是百分数，展示时最多一位小数。 */
  const goodsPercent = (value) => Number(Number(value).toFixed(1)) + '%';

  registerFeature({
    id: 'goods',
    title: '市场',
    order: 30,
    mount(pane, ctx) {
      // 顶部选择区（模式 / 商品 / 品质 / 开关）固定，只有下方各国市场列表跟着滚，
      // 翻到列表中间也能随时换一个商品看
      pane.classList.add('eh-pane--stick');
      pane.innerHTML = `
        <div class="eh-section eh-stick-head">
          <div class="eh-h3">商品</div>
          <div class="eh-gd-modes" data-role="modes">
            <button class="eh-gd-mode" type="button" data-mode="buy">采购</button>
            <button class="eh-gd-mode" type="button" data-mode="sell">销售</button>
          </div>
          <div class="eh-gd-picker">
            <div class="eh-gd-picks" data-role="products"></div>
            <div class="eh-gd-picks" data-role="materials"></div>
            <div class="eh-gd-quals" data-role="quals" hidden>
              <span>品质</span>
            </div>
          </div>
          <div class="eh-gd-own" data-role="sellopts" hidden>
            <p class="eh-gd-hint" data-role="taxhint"></p>
          </div>
          <div class="eh-gd-bar">
            <p class="eh-fx-status" data-role="status">…</p>
            <button class="eh-btn" type="button" data-role="refresh">刷新行情</button>
          </div>
        </div>
        <div class="eh-stick-bar">
          <div class="eh-h3" data-role="listtitle">各国市场 · 黄金单价</div>
        </div>
        <div class="eh-stick-scroll">
          <p class="eh-fx-legend" data-role="legend">
            按 1 件商品的黄金单价从低到高排列。黄金单价 = 该国最低挂单价
            × 用黄金换该国货币的最优价。
          </p>
          <div class="eh-gd-list" data-role="list"></div>
          <div class="eh-gd-exile" data-role="exile" hidden>
            <div class="eh-gd-exile-head">
              <p class="eh-gd-exile-title">流亡政府 · 已失去全部领土</p>
              <p class="eh-gd-exile-note">
                这些国家目前没有任何领土，玩家无法抵达，所列挂单事实上无法成交（战争导致政权变更后才会出现）。
                仍按同一套规则单独排序，只作存档参考，请不要据此规划交易。
              </p>
            </div>
            <div class="eh-gd-list" data-role="exilelist"></div>
          </div>
          <p class="eh-disclaimer">
            报价来自各国市场的公开挂单，未计入可能的手续费；汇率取自「汇率」标签的最近一次结果。
          </p>
        </div>
      `;

      const listEl = pane.querySelector('[data-role="list"]');
      const exileEl = pane.querySelector('[data-role="exile"]');
      const exileListEl = pane.querySelector('[data-role="exilelist"]');
      const statusEl = pane.querySelector('[data-role="status"]');
      const refreshBtn = pane.querySelector('[data-role="refresh"]');
      const productBox = pane.querySelector('[data-role="products"]');
      const materialBox = pane.querySelector('[data-role="materials"]');
      const qualsEl = pane.querySelector('[data-role="quals"]');
      const modesEl = pane.querySelector('[data-role="modes"]');
      const sellOptsEl = pane.querySelector('[data-role="sellopts"]');
      const taxHintEl = pane.querySelector('[data-role="taxhint"]');
      const listTitleEl = pane.querySelector('[data-role="listtitle"]');
      const legendEl = pane.querySelector('[data-role="legend"]');

      const emptyEl = document.createElement('p');
      emptyEl.className = 'eh-empty';
      emptyEl.textContent = '还没有市场行情，点「刷新行情」抓取一次。';
      emptyEl.hidden = true;
      listEl.appendChild(emptyEl);

      const PRODUCT_APIS = GOODS_GROUPS[0].items.map((meta) => meta.api);
      const isProductApi = (api) => PRODUCT_APIS.indexOf(api) !== -1;

      // 键形如 Food#1（成品）/ Grain#0（原材料），沿用旧的本地存储键名，老设置照样能用
      const savedKey = String(ctx.storage.get('item', 'Grain#0'));
      const initial = GOODS_BY_KEY.get(savedKey) || GOODS_BY_KEY.get('Grain#0');
      let pickedApi = initial.api;
      let pickedQuality = initial.quality || 1; // 记住成品的品质，切来切去不用重选
      let item = initial;

      // 采购 = 花黄金买商品；销售 = 在各国市场卖出，扣税后换回黄金
      let mode = ctx.storage.get('mode', 'buy') === 'sell' ? 'sell' : 'buy';
      // 玩家国籍：从 /account 的 nationality_id 读，只用于判断本国销售免进口税
      let myCountryId = 0;
      // 当前所在国家：只用来给列表里对应国家换一套配色，不置顶、不改排序、不参与计算
      let hereCountryId = 0;
      let hereLoading = false;
      let playerLoading = false;
      let playerFailed = false;
      let playerError = null;
      let taxesLoading = false;
      let taxesFailed = false;
      let taxesError = null;

      const BUY_TITLE = '各国市场 · 黄金单价';
      const SELL_TITLE = '各国市场 · 税后黄金收入';
      const BUY_LEGEND =
        '黄金单价 = 该国最低挂单价 × 用黄金换该国货币的最优价。';
      const SELL_LEGEND =
        '收入 = 该国最低挂单价 ×（100% − 增值税 − 进口税）× 用该国货币换黄金的最优价。';

      const syncTaxHint = () => {
        if (!alive || !taxHintEl) return;
        let text = '';
        let tone = '';
        if (playerLoading && taxesLoading) {
          text = '正在读取各国税率与玩家国籍…';
        } else if (playerLoading) {
          text = '正在读取玩家国籍…';
        } else if (taxesLoading) {
          text = '正在读取各国税率…';
        } else if (taxesFailed) {
          const code = taxesError && taxesError.code;
          text =
            code === 'NO_TOKEN' || code === 'UNAUTHORIZED'
              ? authHint()
              : '税率读取失败，暂按 0 税估算；再点一次「销售」会重试。';
          tone = 'warn';
        } else if (!fxFeed.taxesKnown) {
          text = '税率还没读到，点「销售」再试一次。';
        } else if (playerFailed) {
          const code = playerError && playerError.code;
          if (code === 'NO_TOKEN') {
            text =
              '未获取到玩家国籍：该信息只认游戏登录凭据，先在游戏里打开任意页面（触发一次接口请求）再点「销售」重试；暂按外国卖家计税。';
          } else if (code === 'UNAUTHORIZED') {
            text = '未获取到玩家国籍：游戏登录凭据已失效，刷新游戏页面后再点「销售」重试；暂按外国卖家计税。';
          } else {
            text = '未获取到玩家国籍（接口读取失败），按外国卖家计税：增值税与进口税都扣。';
          }
          tone = 'warn';
        } else if (!myCountryId) {
          text = '账号没有国籍信息，按外国卖家计税：增值税与进口税都扣。';
          tone = 'warn';
        }
        // 正常态不再重复「国籍 / 免进口税」：列表行里已经按国家标了税率与税后收入
        taxHintEl.textContent = text;
        if (tone) taxHintEl.dataset.tone = tone;
        else delete taxHintEl.dataset.tone;
        sellOptsEl.hidden = mode !== 'sell' || !text;
      };

      /** 税率只在进入「销售」时拉一次（/countries 的 laws），失败可重试；force 走刷新入口。 */
      const loadTaxes = (force) => {
        if (!alive || taxesLoading) return;
        if (fxFeed.taxesKnown && force !== true) return;
        taxesLoading = true;
        taxesFailed = false;
        taxesError = null;
        syncTaxHint();
        (force === true ? fxFeed.refreshTaxes() : fxFeed.ensureTaxes())
          .catch((err) => {
            if (!alive) return;
            taxesFailed = true;
            taxesError = err || null;
            ctx.log('税率读取失败', err && err.message ? err.message : err);
          })
          .then(() => {
            if (!alive) return;
            taxesLoading = false;
            syncTaxHint();
            render();
            ctx.ui.reposition();
          });
      };

      /**
       * 玩家国籍：取自 playerFeed（POST /account/getuser 的 nationality.id / nationality_id）。
       * 只取国籍 id、仅存内存，不展示原始字段、不落盘、不打日志（账号信息仍不外泄）。
       */
      const loadPlayer = () => {
        if (!alive || playerLoading || myCountryId) return;
        playerLoading = true;
        playerFailed = false;
        playerError = null;
        syncTaxHint();
        // 与「市场列表金价标注」共用 playerFeed：一次 /account/getuser 两边都够用
        playerFeed
          .ensure()
          .then((info) => {
            if (!alive) return;
            myCountryId = (info && info.nationalityId) || 0;
          })
          .catch((err) => {
            if (!alive) return;
            playerFailed = true;
            playerError = err || null;
            ctx.log('玩家国籍读取失败', err && err.message ? err.message : err);
          })
          .then(() => {
            if (!alive) return;
            playerLoading = false;
            syncTaxHint();
            render();
            ctx.ui.reposition();
          });
      };

      /**
       * 当前所在国家（playerFeed 的 countryId）：
       * 只取 id、只存内存，用来给列表里对应国家换一套配色（不置顶、不改排序）。
       * 只负责「把值画出来」：数据从哪来由 playerFeed.watch 统一推送，不在这里再挑时机。
       */
      const applyHere = (info) => {
        if (!alive) return;
        const next = (info && info.countryId) || 0;
        if (next === hereCountryId) return;
        hereCountryId = next;
        render();
        ctx.ui.reposition();
      };

      /** 首次读一次（挂载 / 凭据晚到）；之后一律靠 playerFeed 的通知。 */
      const loadHere = () => {
        if (!alive || hereLoading) return;
        hereLoading = true;
        playerFeed
          .ensure()
          .then(applyHere)
          .catch((err) => {
            if (!alive) return;
            // 读不到就静默不标，只在调试日志里留一条
            ctx.log('当前所在国家读取失败', err && err.message ? err.message : err);
          })
          .then(() => {
            hereLoading = false;
          });
      };

      const syncMode = () => {
        modesEl.querySelectorAll('.eh-gd-mode').forEach((btn) => {
          const active = btn.dataset.mode === mode;
          btn.classList.toggle('is-on', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        sellOptsEl.hidden = mode !== 'sell';
        listTitleEl.textContent = mode === 'sell' ? SELL_TITLE : BUY_TITLE;
        legendEl.textContent = mode === 'sell' ? SELL_LEGEND : BUY_LEGEND;
        if (mode === 'sell') {
          loadPlayer();
          loadTaxes();
        }
        syncTaxHint();
      };

      const setMode = (next) => {
        if (next !== 'sell' && next !== 'buy') return;
        if (mode === next) {
          // 再点一次「销售」＝重试失败的税率 / 国籍请求（已拿到时直接返回，不发请求）
          if (next === 'sell') {
            loadPlayer();
            loadTaxes();
          }
          return;
        }
        mode = next;
        ctx.storage.set('mode', mode);
        syncMode();
        render();
        ctx.ui.reposition();
      };

      modesEl.querySelectorAll('.eh-gd-mode').forEach((btn) => {
        on(btn, 'click', () => setMode(btn.dataset.mode));
      });

      const pickBtns = new Map(); // api → 商品按钮
      const qualBtns = new Map(); // 品质 → 按钮

      /** 商品图只在接口给过之后才换成图片，其余情况用内置 emoji。 */
      const paintIcon = (btn, meta) => {
        const slot = btn.querySelector('.eh-gd-pick-icon');
        const src = GOODS_AVATARS.get(meta.api);
        if (!slot || !src || slot.querySelector('img')) return;
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.addEventListener(
          'error',
          () => {
            // 图挂了就退回 emoji，别留一个空框
            img.remove();
            slot.textContent = meta.icon;
          },
          { once: true }
        );
        img.src = src;
        slot.textContent = '';
        slot.appendChild(img);
      };

      const buildPick = (meta, host) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-gd-pick';
        btn.dataset.api = meta.api;
        btn.title = meta.zh;
        const icon = document.createElement('span');
        icon.className = 'eh-gd-pick-icon';
        icon.textContent = meta.icon;
        const name = document.createElement('span');
        name.textContent = meta.zh;
        btn.appendChild(icon);
        btn.appendChild(name);
        host.appendChild(btn);
        pickBtns.set(meta.api, btn);
        on(btn, 'click', () => selectItem(meta.api, pickedQuality));
      };

      GOODS_GROUPS[0].items.forEach((meta) => buildPick(meta, productBox));
      GOODS_GROUPS[1].items.forEach((meta) => buildPick(meta, materialBox));

      GOODS_QUALITIES.forEach((quality) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-gd-q';
        btn.dataset.q = String(quality);
        btn.title = 'Q' + quality;
        const bar = document.createElement('i');
        const text = document.createElement('span');
        text.textContent = 'Q' + quality;
        btn.appendChild(bar);
        btn.appendChild(text);
        qualsEl.appendChild(btn);
        qualBtns.set(quality, btn);
        on(btn, 'click', () => selectItem(pickedApi, quality));
      });

      /** 商品图是边拉边到的：每拉完一个市场就补一次，谁先到就先换谁。 */
      const paintIcons = () => {
        if (!alive) return;
        pickBtns.forEach((btn, api) => {
          paintIcon(btn, GOODS_META.get(api) || { api, icon: '' });
        });
      };

      /** 选中态、品质行的显隐都从这里统一刷新。 */
      const syncPicker = () => {
        pickBtns.forEach((btn, api) => {
          const active = api === pickedApi;
          btn.classList.toggle('is-on', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        paintIcons();
        const product = isProductApi(pickedApi);
        qualsEl.hidden = !product;
        qualBtns.forEach((btn, quality) => {
          const active = product && quality === pickedQuality;
          btn.classList.toggle('is-on', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      };

      const selectItem = (api, quality) => {
        const key = api + '#' + (isProductApi(api) ? quality : 0);
        const next = GOODS_BY_KEY.get(key);
        if (!next) return;
        item = next;
        pickedApi = next.api;
        if (next.quality) pickedQuality = next.quality;
        ctx.storage.set('item', next.key);
        syncPicker();
        render();
        ctx.ui.reposition();
      };

      // 行情与状态全部来自共享快照：面板关着时「商品市场自动加载比价数据」也会用它抓
      let alive = true;

      const setStatus = (text, tone) => {
        if (!alive) return;
        statusEl.textContent = text;
        if (tone) statusEl.dataset.tone = tone;
        else delete statusEl.dataset.tone;
      };

      const tokenHint = authHint;

      const paintStatus = () => {
        if (!alive) return;

        const snap = goodsSnapshot;
        refreshBtn.disabled = snap.loading;

        if (snap.loading) {
          const step = snap.progress;
          if (!step.total) {
            setStatus('正在读取国家清单…');
            return;
          }
          const parts = [];
          if (fxFeed.loading) {
            const fx = fxFeed.progress;
            parts.push('汇率 ' + (fx.total ? fx.done + '/' + fx.total : '…'));
          }
          parts.push('市场 ' + step.done + '/' + step.total);
          setStatus('正在拉取 ' + parts.join(' · ') + '…');
          return;
        }

        if (apiClient.state !== 'ok') {
          setStatus(tokenHint(), 'warn');
          return;
        }

        if (snap.error) {
          const err = snap.error;
          if (err.code === 'NO_TOKEN' || err.code === 'UNAUTHORIZED') {
            setStatus(tokenHint(), err.code === 'UNAUTHORIZED' ? 'error' : 'warn');
          } else if (err.code === 'TIMEOUT') {
            setStatus('请求超时，请稍后重试。', 'error');
          } else if (quotaHint(err) || err.limited) {
            setStatus(quotaHint(err) || '接口返回 429（请求过多或已达当日查询上限），请稍后再试。', 'error');
          } else {
            setStatus('拉取失败：' + fetchErrorText(err), 'error');
          }
          return;
        }

        if (!snap.updatedAt) {
          setStatus('还没有市场行情，点「刷新行情」抓取一次。');
          return;
        }

        const fxNote = fxFeed.updatedAt ? ' · 汇率 ' + formatClock(fxFeed.updatedAt) : ' · 暂无汇率';
        const exiledCount = snap.entries.filter((entry) => entry.exiled).length;
        const exileNote = exiledCount ? `（含 ${exiledCount} 个流亡政府）` : '';
        const suffix = snap.failures
          ? ` · ${snap.failures} 个市场拉取失败` + (snap.limited ? '（含 429，可到「设置」页生成专用密钥）' : '')
          : '';
        setStatus(
          `${snap.entries.length} 个市场${exileNote}\n更新于 ${formatClock(snap.updatedAt)}${fxNote}${suffix}`,
          snap.limited ? 'error' : undefined
        );
      };

      const buildRow = (row, index) => {
        const el = document.createElement('div');
        el.className = 'eh-gd-row';
        if (row.sortGold == null) el.classList.add('is-idle');
        // 流亡政府单独成栏：不参与主列表排名，也不抢「最优」高亮
        if (row.exiled) el.classList.add('is-exile');
        else if (index === 0 && row.sortGold != null) el.classList.add('is-best');
        // 玩家当前所在国家：只换配色 + 加标签，名字与位置仍按行情排序，不置顶
        const isHere = Boolean(hereCountryId) && Number(row.entry.id) === hereCountryId;
        if (isHere) el.classList.add('is-here');

        const locale = fxLocale(row.entry.currency.code);

        el.appendChild(buildFlagEl(row.entry.currency.code, row.entry.avatar));

        const place = document.createElement('span');
        place.className = 'eh-gd-place';
        const englishName = String(row.entry.name || '');
        const nameEl = document.createElement('b');
        nameEl.textContent = locale ? locale[0] : englishName;
        nameEl.title = locale ? locale[0] + ' · ' + englishName : englishName;
        place.appendChild(nameEl);
        // 中文名后面补英文国名；没有中文对照时上面显示的就是英文，不重复
        if (locale && englishName && englishName !== locale[0]) {
          const enEl = document.createElement('span');
          enEl.className = 'eh-gd-en';
          enEl.textContent = englishName;
          enEl.title = englishName;
          place.appendChild(enEl);
        }
        // 国名后面的状态标签：玩家国籍 / 当前位置；两者重合时合成一个，同一行不说两遍
        const ownCountry = row.channel === 'sell' && Boolean(row.own);
        const marks = [];
        if (ownCountry) marks.push('玩家国籍');
        if (isHere) marks.push('当前位置');
        if (marks.length) {
          const markEl = document.createElement('span');
          markEl.className = 'eh-gd-mark';
          markEl.textContent = marks.join(' · ');
          markEl.title =
            ownCountry && isHere
              ? '你的国籍国，也是你当前所在的国家'
              : ownCountry
                ? '你的国籍国：在本国销售免进口税'
                : '你当前所在的国家：该市场的价格按本国货币计价';
          place.appendChild(markEl);
        }
        el.appendChild(place);

        const goldEl = document.createElement('span');
        goldEl.className = 'eh-gd-gold';
        if (row.gold != null) goldEl.appendChild(buildGoldIconEl('eh-gold-ico--lg'));
        const goldValue = document.createElement('b');
        goldValue.textContent = row.gold == null ? '—' : fxGold(row.gold);
        goldEl.appendChild(goldValue);
        el.appendChild(goldEl);

        // 去该国商品市场：URL 只带国家（/market/{country_id}），商品与品质走 sessionStorage 意图。
        // 流亡政府已无领土，玩家到不了；还没拉到数据的行也先不给入口。
        if (!row.exiled && row.entry.id != null && row.sortGold != null) {
          el.appendChild(
            buildGoButton(
              '去' + (locale ? locale[0] : String(row.entry.name || '')) + '的商品市场',
              '/market/' + row.entry.id,
              {
                countryId: Number(row.entry.id),
                api: pickedApi,
                quality: isProductApi(pickedApi) ? pickedQuality : 0
              }
            )
          );
        }

        const meta = document.createElement('span');
        meta.className = 'eh-gd-meta';
        const code = escapeHtml(row.entry.currency.code);
        const priceText = goodsAmount(row.best.price);
        const supplyText = goodsAmount(row.best.supply);

        if (row.channel === 'sell') {
          meta.innerHTML =
            `<b>${priceText}</b> ${code}/件 · 税后 <b>${goodsAmount(row.netPrice)}</b> ${code}` +
            (row.rate == null
              ? '<span class="eh-gd-tax">该国货币暂无换汇买单</span>'
              : !row.taxKnown
                ? '<span class="eh-gd-tax">税率未知，按 0 税估算</span>'
                : '') +
            (row.depthShort ? '<span class="eh-gd-tax">换汇深度不足</span>' : '') +
            (row.exiled ? '<span class="eh-gd-exile-tag">流亡政府 · 无法抵达</span>' : '');
          meta.title =
            row.rate == null
              ? '缺少该国货币的买单挂单，销售所得无法换回黄金'
              : priceText +
                ' ' +
                row.entry.currency.code +
                '/件 ×（1 − ' +
                (row.taxKnown
                  ? [
                      '增值税 ' + goodsPercent(row.vat),
                      row.own ? '进口税 0%（本国免）' : '进口税 ' + goodsPercent(row.importTax)
                    ].join(' − ')
                  : '税率未知，按 0%') +
                '）= ' +
                goodsAmount(row.netPrice) +
                ' ' +
                row.entry.currency.code +
                ' × ' +
                fxPrice(row.rate) +
                ' 金/单位货币 = ' +
                fxGold(row.gold) +
                ' 金';

          const sub = document.createElement('span');
          sub.className = 'eh-gd-meta eh-gd-meta--sub';
          if (row.rate == null) {
            sub.textContent = '缺卖出方向的汇率，无法估算实际收入。';
          } else if (!row.taxKnown) {
            sub.innerHTML =
              '税前 ' + goldIconHtml('eh-gold-ico--sm') + '<b>' + fxGold(row.goldBefore) + '</b> · 税率未知（暂按 0 税估算）';
          } else {
            const parts = ['增值税 ' + goodsPercent(row.vat)];
            parts.push(row.own ? '进口税 0%（本国免）' : '进口税 ' + goodsPercent(row.importTax));
            sub.innerHTML =
              '税前 ' + goldIconHtml('eh-gold-ico--sm') + '<b>' + fxGold(row.goldBefore) + '</b> · ' + parts.join(' · ');
          }
          el.appendChild(meta);
          el.appendChild(sub);
          return el;
        }

        let text =
          `<b>${priceText}</b> ${code}/件 · 可买 ` + `<b>${supplyText}</b>`;
        if (row.rate == null) text += '<span class="eh-gd-tax">该国货币暂无换汇挂单</span>';
        if (row.exiled) text += '<span class="eh-gd-exile-tag">流亡政府 · 无法抵达</span>';
        meta.innerHTML = text;
        meta.title =
          row.rate == null
            ? '缺少该国货币的换汇挂单，无法折算成黄金'
            : priceText +
              ' ' +
              row.entry.currency.code +
              ' × ' +
              fxPrice(row.rate) +
              ' 金/单位货币 = ' +
              fxGold(row.gold) +
              ' 金';
        el.appendChild(meta);

        return el;
      };

      /** 用当前选中的商品重排列表：采购按黄金单价升序，销售按税后收入降序，缺汇率的排最后。 */
      const render = () => {
        if (!alive) return;
        const entries = [];
        const selling = mode === 'sell';

        goodsSnapshot.entries.forEach((entry) => {
          const best = entry.items && entry.items.get(item.key);
          if (!best) return;

          if (!selling) {
            const rate = fxFeed.rateFor(entry.currency.id);
            const gold = rate ? best.price * rate : null;
            entries.push({
              channel: 'buy',
              entry,
              best,
              rate,
              gold,
              sortGold: gold,
              exiled: Boolean(entry.exiled)
            });
            return;
          }

          // 销售：先扣增值税 + 进口税（本国免进口税），再按「卖法币换黄金」的最优价折算
          const tax = fxFeed.taxFor(entry.id);
          const own = Boolean(myCountryId) && Number(entry.id) === myCountryId;
          const vat = tax ? tax.vat : 0;
          const importTax = tax ? (own ? 0 : tax.importTax) : 0;
          const keep = Math.max(0, 1 - (vat + importTax) / 100);
          const rate = fxFeed.sellRateFor(entry.currency.id);
          const netPrice = best.price * keep;
          const capacity = rate ? fxFeed.sellCapacityFor(entry.currency.id) : 0;
          entries.push({
            channel: 'sell',
            entry,
            best,
            rate,
            vat,
            importTax,
            keep,
            own,
            taxKnown: Boolean(tax),
            netPrice,
            goldBefore: rate ? best.price * rate : null,
            gold: rate ? netPrice * rate : null,
            // 税率未知的行只做参考，不参与排名（否则 0 税会让它虚高）
            sortGold: tax && rate ? netPrice * rate : null,
            // 商品市场只有卖单：只核对「1 件的换汇所得」买盘吃不吃得下
            depthShort: Boolean(rate) && capacity > 0 && netPrice > capacity,
            exiled: Boolean(entry.exiled)
          });
        });

        entries.sort((a, b) => {
          const av = a.sortGold == null ? Infinity : a.sortGold;
          const bv = b.sortGold == null ? Infinity : b.sortGold;
          if (av !== bv) return selling ? bv - av : av - bv;
          return a.entry.name.localeCompare(b.entry.name);
        });

        // 流亡政府（已失去全部领土）没法抵达，单独放到底部一栏，各自内部照旧排序
        const active = entries.filter((row) => !row.exiled);
        const exiled = entries.filter((row) => row.exiled);

        listEl.textContent = '';
        listEl.appendChild(emptyEl);
        active.forEach((row, index) => listEl.appendChild(buildRow(row, index)));

        exileListEl.textContent = '';
        exiled.forEach((row, index) => exileListEl.appendChild(buildRow(row, index)));
        exileEl.hidden = exiled.length === 0;

        if (goodsSnapshot.updatedAt) {
          emptyEl.textContent = `所有市场都没有「${item.label}」的挂单。`;
        } else {
          emptyEl.textContent = '还没有市场行情，点「刷新行情」抓取一次。';
        }
        emptyEl.hidden = entries.length > 0 || goodsSnapshot.loading;
        // 可抵达的国家全都没货、只剩流亡政府的存档报价时，主列表也要说一声
        if (!goodsSnapshot.loading && !active.length && exiled.length) {
          emptyEl.textContent = `所有可抵达的国家都没有「${item.label}」的挂单，只有流亡政府还留着报价。`;
          emptyEl.hidden = false;
        }
      };

      /**
       * 抓一轮行情。状态、进度与结果都在 goodsSnapshot 里：
       * 「商品市场自动加载比价数据」可能已经在抓，这里直接复用同一轮请求。
       */
      const load = () => {
        if (!alive) return;
        // 人可能已经换了国家：刷新时顺手重读一次（playerFeed 自带 10 秒缓存）
        loadHere();
        if (mode === 'sell') {
          loadPlayer();
          loadTaxes(true);
        }
        // 面板上的按钮：绕过 TTL 重抓（失败保留旧值），不是「清缓存」
        goodsSnapshot.refresh();
      };

      on(refreshBtn, 'click', () => load());

      const off = fxFeed.subscribe((kind) => {
        if (!alive) return;
        if (kind === 'done') {
          // 汇率到位（或刷新完）后补上黄金单价
          paintStatus();
          render();
          if (!goodsSnapshot.loading) ctx.ui.reposition();
        } else if (kind === 'state') {
          paintStatus();
        }
      });

      // 快照抓取 → 面板：逐市场只补商品图与进度，整表重建留到本轮结束，避免抓取中反复重排
      const offSnap = goodsSnapshot.subscribe((kind) => {
        if (!alive) return;
        if (kind === 'entry' || kind === 'drop') {
          paintIcons();
          paintStatus();
          return;
        }
        if (kind === 'reset') {
          paintStatus();
          syncTaxHint(); // 国家清单到位后补上国籍中文名
          render();
          return;
        }
        if (kind === 'done' || kind === 'error') {
          paintStatus();
          paintIcons(); // 收尾再补一次，兜住最后一批市场的图
          syncTaxHint();
          render();
          ctx.ui.reposition();
          return;
        }
        paintStatus();
      });

      syncPicker();
      syncMode();
      paintStatus();
      render();
      // 当前所在国家：挂载就读一次，读到后给对应行换配色（采购 / 销售都标）
      loadHere();
      // 凭据晚到（面板先开、游戏还没发过请求）：读到账号后再补一次高亮
      const offAuth = apiClient.onAuth(() => {
        if (alive && !hereCountryId) loadHere();
      });
      // 位置变化由 playerFeed 统一推送：别的页面读到新位置时，这里立刻换配色
      const offPlayer = playerFeed.watch(applyHere);
      // 面板自己做主：有新鲜快照就直接复用，否则拉一轮。与「商品市场自动加载比价数据」无关
      goodsSnapshot.ensure(GOODS_CACHE_MS);

      // 每次切回本页也检查一次：快照过期就补一轮，不需要玩家记得点「刷新行情」
      const watchPane = new MutationObserver(() => {
        if (!alive || pane.hidden) return;
        goodsSnapshot.ensure(GOODS_CACHE_MS);
      });
      watchPane.observe(pane, { attributes: true, attributeFilter: ['hidden'] });

      // 每次显示本标签：重读一次所在国（10 秒过期才真请求），快照过期则补一轮
      ctx.onShow(() => {
        loadHere();
        goodsSnapshot.ensure(GOODS_CACHE_MS);
      });

      ctx.onDestroy(() => {
        alive = false;
        off();
        offSnap();
        offAuth();
        offPlayer();
        watchPane.disconnect();
      });
    }
  });

  /* -------- 9.4 商品市场列表金价标注 -------- */

  /**
   * 在游戏自己的商品市场里补两层只读标注：
   *  1. 列表里每行的「起价」下面，补一行换算后的黄金单价；
   *  2. 上架表单底部的「实收金额」右边，补一行税后实收折算成黄金的值。
   *
   * 这是插件唯一会写游戏 DOM 的地方，规则（AGENTS.md「硬约束 2」的例外）：
   *  - 只往价格单元格追加一个只读徽标，不改游戏原有节点、文本、按钮与事件；
   *  - 徽标带 data-eh-gold 标记，注入前先查重，React 重渲染后自动补回；
   *  - 关闭开关或 destroy() 时全部移除，MutationObserver、订阅一起断开；
   *  - 认不出货币、拿不到汇率、没有凭据时静默跳过，不弹提示、不循环重试。
   *
   * 列表行的价格自带货币代码，直接用；上架表单的价格没有币种，
   * 按「当前所在国家市场的本币」处理（playerFeed 的 region.country.id → currency.id），
   * 实收金额是卖币所得，所以用「卖币换金」的买单方向报价（fxFeed.sellRateFor）。
   *
   * 汇率直接读挂单簿 coinBook（与「汇率」面板共用同一套 key，10 分钟）：
   * 缺哪一侧才补一次请求，之后不会再问；不轮询、不自建缓存。
   */
  const marketBadge = (() => {
    const ATTR = 'data-eh-gold';
    const SCAN_DELAY = 150;
    const WARMUP_GAP = 2000;
    const WARMUP_TRIES = 15;
    const PRICE_RE = /^\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?$/;
    const CODE_RE = /^[A-Z]{3,5}$/;
    /** 上架表单的「单价」输入框：只出现在商品市场的上架面板里，拿它当定位锚点。 */
    const UNIT_INPUT = 'input[inputmode="decimal"]';
    /** 上架表单底部那行的标签；数值是它的下一个兄弟节点。 */
    const GROSS_LABEL = '实收金额';

    let enabled = storage.read('marketBadge', true) !== false;
    let running = false;
    let observer = null;
    let timer = 0;
    let retryTimer = 0;
    /**
     * 页面静止时的低频重扫（只重算本地 DOM，不直接发请求）：
     * 没有它，标注的「10 分钟过期才重拉」就永远等不到触发——扫描平时只由页面的 DOM 变化驱动。
     */
    const IDLE_SCAN_MS = 60 * 1000;
    let idleTimer = 0;
    let credentialTries = 0;
    let currencyMap = null;
    let currencyByCountry = null;
    /** 当前认定的商品列表容器；离开页面或它被移除后重新找。 */
    let scope = null;
    /** 上架面板容器（含「上架身份」与「实收金额」的那一栏）；同样会失效重找。 */
    let listingRoot = null;
    /** 已为「当前所在国家」发过请求，避免每轮扫描都问一次。 */
    let playerAsked = false;
    /** playerFeed 的订阅：只在本页标注运行期间持有，stop() 里退订。 */
    let offPlayer = null;
    /** 换汇挂单的订阅：别的页面刷新了汇率，这边立刻重画，不用等下一次时间复核。 */
    let offRates = null;
    /** 两类标注各自是否画成功过：决定热身重试何时收工。 */
    let rowPainted = false;
    let grossPainted = false;

    /** 已在调试日志里报过「未识别」的货币代码，避免同一批行反复刷屏。 */
    const unknownCodes = new Set();

    /** 只在游戏的商品市场页标注；别的页面就算出现「价格 + 货币」也不碰。 */
    const routeIsMarket = () => /(^|\/)market(\/|$)/.test(route.current.split(/[?#]/)[0]);

    /**
     * 价格单元格：价格 span 的同级里必须有货币代码（USD/CNY…），
     * 靠这个把「起价」和数量、报价数之类的纯数字区分开，不依赖游戏的 class。
     */
    function readPrice(span) {
      const parent = span.parentElement;
      if (!parent) return null;
      const text = (span.textContent || '').trim();
      if (!PRICE_RE.test(text)) return null;

      let code = '';
      for (let i = 0; i < parent.children.length; i += 1) {
        const sib = parent.children[i];
        if (sib === span) continue;
        const value = (sib.textContent || '').trim();
        if (CODE_RE.test(value)) code = value;
      }
      if (!code) return null;

      const host = parent.parentElement;
      if (!host) return null;

      const price = Number(text.replace(/[,\s]/g, ''));
      if (!(price > 0)) return null;
      return { host, row: host.parentElement, code, price, text };
    }

    /**
     * 行 → 商品键（api#quality）：游戏只给中文名和 Q1–Q5 角标，
     * 用内置对照表反查回挂单接口里的英文 api 名，查不到（新商品）就返回空。
     */
    function itemKeyOf(row) {
      if (!row) return '';
      const img = row.querySelector('img[alt]');
      let name = img ? String(img.getAttribute('alt') || '').trim() : '';
      let quality = 0;

      const spans = row.querySelectorAll('span');
      for (let i = 0; i < spans.length; i += 1) {
        const text = (spans[i].textContent || '').trim();
        if (/^Q[1-5]$/.test(text)) quality = Number(text.slice(1));
        else if (!name && text && text.length <= 6 && !/^\d/.test(text)) name = text;
      }

      // 名称里带品质的写法（"食物 Q1"）
      const match = /^(.*?)\s*Q([1-5])$/.exec(name);
      if (match) {
        name = match[1].trim();
        quality = Number(match[2]);
      }

      const api = GOODS_API_BY_ZH.get(name);
      return api ? api + '#' + quality : '';
    }

    function ensureBadge(host) {
      let badge = host.querySelector('[' + ATTR + ']');
      if (!badge) {
        badge = document.createElement('div');
        badge.setAttribute(ATTR, '');
        badge.style.cssText =
          'display:flex;align-items:center;justify-content:flex-end;gap:2px;margin-top:1px;' +
          'font:600 10px/1.15 -apple-system,BlinkMacSystemFont,"PingFang SC",' +
          '"Hiragino Sans GB","Microsoft YaHei",sans-serif;letter-spacing:.02em;' +
          'white-space:nowrap;pointer-events:none;';
        host.appendChild(badge);
      }
      return badge;
    }

    /** 写内容前先比对 key：内容没变就不动 DOM，免得自己触发的 MutationObserver 空转。 */
    function paintBadge(host, key, tone, title, fill) {
      const badge = ensureBadge(host);
      if (badge.getAttribute('data-key') === key) return;
      badge.setAttribute('data-key', key);
      badge.setAttribute('data-tone', tone);
      badge.style.color = tone === 'muted' ? '#7d8ba0' : '#8fd6a4';
      badge.textContent = '';
      fill(badge);
      badge.title = title;
    }

    function currencyIdOf(code) {
      if (!currencyMap) {
        ensureCurrencyMap();
        return 0;
      }
      return currencyMap.get(String(code).toUpperCase()) || 0;
    }

    /**
     * 货币代码 → 货币 id：只有 /countries/summary 里有这份映射，拉一次就够。
     * 走 fxFeed.ensureCountries（底层 apiCache 页面级条目）：并发合并、失败冷却都在那边，
     * 这里不再自建 promise 与重试计时。
     */
    function ensureCurrencyMap() {
      if (currencyMap) return;
      if (apiClient.state !== 'ok') return;

      fxFeed
        .ensureCountries()
        .then((list) => {
          const map = new Map();
          fxCurrencies(list).forEach((entry) => map.set(entry.code.toUpperCase(), entry.id));
          currencyMap = map;

          // 上架表单只有「当前所在国家」，没有货币代码，所以要保留国家 → 货币这条线
          const byCountry = new Map();
          (Array.isArray(list) ? list : []).forEach((country) => {
            const currency = country && country.currency;
            if (!currency || !currency.id || !currency.name) return;
            if (String(currency.name).toLowerCase() === 'gold') return;
            byCountry.set(Number(country.id), {
              id: Number(currency.id),
              code: String(currency.name),
              country: String(country.name || '')
            });
          });
          currencyByCountry = byCountry;

          log('市场金价：国家清单已就绪', map.size + ' 种货币');
          schedule();
        })
        .catch((err) => {
          log('市场金价：国家清单读取失败', err && (err.message || err.code));
        });
    }

    /**
     * 黄金/单位货币；null = 没有这个方向的挂单；undefined = 还没拉到（含刚失败进冷却），先不画。
     * selling=true 走买单（你把手里的法币卖成黄金），false 走卖单（你花黄金买法币）。
     * 数据直接读 coinBook（与「汇率」面板共用同一套 key）：
     *  - 命中 10 分钟缓存：直接用；
     *  - 已过期：先拿旧值顶上，同时补一次请求（按币种节流，买卖两个方向共用一次 ensureMany）；
     *  - 完全没有：补一次请求，这一轮先不画。
     */
    const RATE_KICK_MS = 60 * 1000;
    /** 补拉失败后退避：页面上的重扫是每分钟一次，别让它变成对故障接口的持续轮询。 */
    const RATE_RETRY_MS = 5 * 60 * 1000;
    /** 币种 id → 下次允许补拉的时间。 */
    const rateKick = new Map();
    function goldRateOf(id, selling) {
      const transaction = selling ? 'BUY' : 'SELL';
      const entry = coinBook.side(id, transaction);
      const priceOf = (hit) => (hit.value.length ? hit.value[0].price : null);
      const expired = Boolean(entry) && Date.now() - entry.at >= API_TTL.coin;
      if (entry && !expired) return priceOf(entry);
      if (apiClient.state !== 'ok') return entry ? priceOf(entry) : undefined;

      const now = Date.now();
      if (now < (rateKick.get(id) || 0)) return entry ? priceOf(entry) : undefined;
      rateKick.set(id, now + RATE_KICK_MS);
      coinBook.ensureMany([id]).then(schedule, (err) => {
        rateKick.set(id, Date.now() + RATE_RETRY_MS);
        log('市场金价：换汇挂单补拉失败', (err && err.code) || (err && err.message) || err);
        schedule();
      });
      return entry ? priceOf(entry) : undefined;
    }

    /** 返回售价（黄金/单位货币）；null = 没有挂单；undefined = 正在取或刚失败，先不画。 */
    const rateOf = (id) => goldRateOf(id, false);

    function paint(info) {
      if (!running || !enabled) return;
      if (info.host.closest('[' + ATTR + ']')) return;

      const id = currencyIdOf(info.code);
      if (!id) {
        // 同一种货币只记一次，免得调试日志被刷屏
        if (!unknownCodes.has(info.code)) {
          unknownCodes.add(info.code);
          log('市场金价：货币未识别', info.code, '国家清单=' + (currencyMap ? currencyMap.size : '未就绪'));
        }
        return;
      }

      const rate = rateOf(id);
      if (rate === undefined) return;
      if (!(rate > 0)) {
        paintBadge(info.host, 'none', 'muted', '该货币暂无换汇挂单，无法折算成黄金', (badge) => {
          badge.textContent = '暂无换汇';
        });
        return;
      }

      const gold = info.price * rate;
      // 全球最低价来自面板「市场」页抓过的行情，没有数据就只显示本国折算价
      const best = goodsFeed.bestGold(itemKeyOf(info.row));
      const diff = best ? gold - best.gold : 0;

      let title =
        info.text +
        ' ' +
        info.code +
        ' × ' +
        fxPrice(rate) +
        ' 金/单位货币 = ' +
        fxGold(gold) +
        ' 金（按当前最优换汇挂单估算，未计手续费）';
      if (best) {
        title += '；全球最低 ' + fxGold(best.gold) + ' 金（' + best.country + ' ' + best.code + '）';
        title +=
          Math.abs(diff) <= best.gold * 0.005
            ? '，本行即全球最低'
            : '，本行' + (diff > 0 ? '贵 ' : '便宜 ') + fxGold(Math.abs(diff)) + ' 金';
      } else if (!goodsFeed.ready) {
        title += '；在面板「市场」页抓取一次行情后，会显示与全球最低价的对比';
      }

      paintBadge(
        info.host,
        'gold:' + gold + '|' + (best ? best.gold : '-'),
        'gold',
        title,
        (badge) => {
          badge.appendChild(document.createTextNode('≈'));
          badge.appendChild(buildGoldIcon(13));
          badge.appendChild(document.createTextNode(fxGold(gold)));
          if (!best) return;

          // 直接给差额的金数，比百分比直观：+0.0078 就是这行比全球最低贵 0.0078 金
          const tag = document.createElement('span');
          tag.style.marginLeft = '3px';
          if (Math.abs(diff) <= best.gold * 0.005) {
            tag.textContent = '全球最低';
            tag.style.color = '#86c79c';
          } else {
            tag.textContent = (diff > 0 ? '+' : '−') + fxPrice(Math.abs(diff));
            tag.style.color = diff > 0 ? '#e0a06b' : '#86c79c';
          }
          badge.appendChild(tag);
        }
      );
      rowPainted = true;
    }

    /* -------- 上架表单：实收金额折算成黄金 -------- */

    /**
     * 上架面板容器：同时装着「上架身份」和「实收金额」的那一栏。
     * 用「单价」输入框当锚点——商品市场里只有上架表单有 inputmode=decimal 的输入框；
     * 插件面板在 Shadow DOM 里，document.querySelector 选不到，不会误认。
     */
    function findListingRoot() {
      const input = document.querySelector(UNIT_INPUT);
      if (!input) return null;
      let node = input;
      for (let i = 0; i < 10 && node; i += 1) {
        const text = node.textContent || '';
        if (text.indexOf(GROSS_LABEL) >= 0 && text.indexOf('上架身份') >= 0) return node;
        node = node.parentElement;
      }
      return null;
    }

    /**
     * 读「实收金额」：标签 span 的下一个兄弟节点就是数值，
     * 徽标追加在数值所在的横排末尾（即金额右边），不另起一行。
     * 返回 { host, price, text }；读不到（面板没开 / 还没填价格）返回 null。
     */
    function readGross() {
      if (!listingRoot || !listingRoot.isConnected) listingRoot = findListingRoot();
      if (!listingRoot) return null;

      const spans = listingRoot.querySelectorAll('span');
      for (let i = 0; i < spans.length; i += 1) {
        if ((spans[i].textContent || '').trim() !== GROSS_LABEL) continue;
        const value = spans[i].nextElementSibling;
        if (!value || !value.parentElement) return null;
        const text = (value.textContent || '').trim();
        if (!PRICE_RE.test(text)) return null;
        const price = Number(text.replace(/[,\s]/g, ''));
        if (!(price > 0)) return null;
        // host 是「总收入 … 实收金额 0.243」那条横排，徽标跟金额同一行
        return { host: value.parentElement, price, text };
      }
      return null;
    }

    function ensureGrossBadge(host) {
      let badge = host.querySelector('[' + ATTR + '="gross"]');
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(ATTR, 'gross');
        badge.style.cssText =
          'display:inline-flex;align-items:center;gap:2px;margin-left:4px;' +
          'font:600 10.5px/1.1 -apple-system,BlinkMacSystemFont,"PingFang SC",' +
          '"Hiragino Sans GB","Microsoft YaHei",sans-serif;letter-spacing:.02em;' +
          'white-space:nowrap;pointer-events:none;';
        host.appendChild(badge);
      }
      return badge;
    }

    function paintGrossBadge(host, key, tone, title, fill) {
      const badge = ensureGrossBadge(host);
      if (badge.getAttribute('data-key') === key) return;
      badge.setAttribute('data-key', key);
      badge.style.color = tone === 'muted' ? '#7d8ba0' : '#8fd6a4';
      badge.textContent = '';
      fill(badge);
      badge.title = title;
    }

    /** 实收金额是「卖币所得」，折算时走买单方向（卖币换金），与列表行的买币口径相反。 */
    function paintGross() {
      if (!running || !enabled) return;
      const gross = readGross();
      if (!gross) {
        // 面板收起 / 还没渲染：等它出现时再补（页面静止时由热身重试盯着）
        grossPainted = false;
        return;
      }

      const countryId = playerFeed.countryId;
      // 所在国只在「还没有值」时读一次：玩家在商品市场页内不会换国家（旅行会离开这页，
      // 回来时 start() 会重读），所以不做周期性复核，免得每分钟打一次账号接口
      if (!countryId) {
        if (!playerAsked) {
          playerAsked = true;
          playerFeed
            .ensure()
            .then((info) => {
              if (running && info && info.countryId) schedule();
            })
            .catch((err) => {
              const code = err && err.code;
              // 凭据还没到 / 还在冷却：下次扫描再试，别把「没登录」当成「接口挂了」
              if (code === 'NO_TOKEN' || code === 'COOLDOWN') playerAsked = false;
              if (code !== 'COOLDOWN') log('市场金价：所在国家读取失败', err && (err.message || code));
            });
        }
        return;
      }

      if (!currencyByCountry) {
        ensureCurrencyMap();
        return;
      }
      const money = currencyByCountry.get(countryId);
      if (!money) {
        if (!unknownCodes.has('#' + countryId)) {
          unknownCodes.add('#' + countryId);
          log('市场金价：所在国家没有对应货币', 'country=' + countryId);
        }
        return;
      }

      const rate = goldRateOf(money.id, true);
      if (rate === undefined) return;
      if (!(rate > 0)) {
        paintGrossBadge(gross.host, 'gross-none', 'muted', '该国货币暂无换汇买单，无法折算成黄金', (badge) => {
          badge.textContent = '暂无换汇买单';
        });
        grossPainted = true;
        return;
      }

      const gold = gross.price * rate;
      const title =
        '实收金额 ' +
        gross.text +
        ' ' +
        money.code +
        ' × 卖币换金 ' +
        fxPrice(rate) +
        ' 金/单位货币 = ' +
        fxGold(gold) +
        ' 金（按当前最优买单估算，未计换汇深度与手续费；上架价按所在国 ' +
        money.country +
        ' 的本币 ' +
        money.code +
        ' 计价）';

      paintGrossBadge(gross.host, 'gross:' + gross.price + '|' + fxGold(gold), 'gold', title, (badge) => {
        badge.appendChild(document.createTextNode('≈'));
        badge.appendChild(buildGoldIcon(12));
        badge.appendChild(document.createTextNode(fxGold(gold)));
      });
      grossPainted = true;
    }

    /**
     * 找出「商品列表容器」：从每行往上 1–3 层找共同祖先，取第一个能装下至少两行的。
     * 行外面可能还套着分隔线之类的包装层，所以不能只看直接父节点；
     * HUD 上的货币余额、下拉里的余额这类孤零零的价格凑不成组，也不会被误标。
     */
    function findScope() {
      const spans = document.body ? document.body.querySelectorAll('span') : [];
      const rows = [];
      for (let i = 0; i < spans.length; i += 1) {
        const info = readPrice(spans[i]);
        if (!info) continue;
        const row = info.host.parentElement;
        if (row) rows.push(row);
      }
      if (!rows.length) return null;

      /** 把这些行按往上 level 层的祖先分组：key 是容器，value 是它装着的行。 */
      const groupAt = (level) => {
        const groups = new Map();
        rows.forEach((row) => {
          let list = row;
          for (let i = 0; i < level && list; i += 1) list = list.parentElement;
          if (!list) return;
          if (!groups.has(list)) groups.set(list, new Set());
          groups.get(list).add(row);
        });
        return groups;
      };

      // 1) 正常情况：找出装了两行以上的容器（层级越深越贴近列表本体）
      for (let level = 1; level <= 3; level += 1) {
        let best = null;
        groupAt(level).forEach((set, list) => {
          if (set.size >= 2 && (!best || set.size > best.size)) best = { list };
        });
        if (best) return best.list;
      }

      // 2) 只剩一行（例如某个品质只有一件商品有挂单）：
      //    从外往内认列表容器，别把「行的包装层」当成列表，否则下次多行时只能标到第一行。
      //    行结构的特征是「既有商品图、又带操作按钮」；HUD 的余额是个 <button> 本身，
      //    内部不会再有 button，所以不会被误判。
      const order = [2, 3, 1];
      for (let i = 0; i < order.length; i += 1) {
        let hit = null;
        groupAt(order[i]).forEach((set, list) => {
          if (hit) return;
          const row = [...set][0];
          if (row && row.querySelector('button') && row.querySelector('img')) hit = { list };
        });
        if (hit) return hit.list;
      }
      return null;
    }

    function paintAll() {
      if (!running || !document.body) return;
      if (!scope || !scope.isConnected) scope = findScope();
      if (scope) {
        const spans = scope.querySelectorAll('span');
        for (let i = 0; i < spans.length; i += 1) {
          const info = readPrice(spans[i]);
          if (info) paint(info);
        }
      }
      // 上架面板与列表是两个独立区域：列表还没渲染出来时也要能标实收金额
      paintGross();
    }

    function schedule() {
      if (!running || timer) return;
      timer = setTimeout(() => {
        timer = 0;
        paintAll();
      }, SCAN_DELAY);
    }

    /** 被删掉的节点里是否有我们的徽标：游戏整块重渲染时靠它把标注补回来。 */
    function removedBadge(record) {
      const nodes = record.removedNodes;
      if (!nodes || !nodes.length) return false;
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node || node.nodeType !== 1) continue;
        if (node.hasAttribute && node.hasAttribute(ATTR)) return true;
        if (node.querySelector && node.querySelector('[' + ATTR + ']')) return true;
      }
      return false;
    }

    /**
     * 新插入的节点里是否带上架表单的锚点（「单价」输入框）。
     * 上架面板默认收起，点开「上架物品」才整块插进来——那时候列表容器里什么都没变，
     * 不专门认一下这个锚点，实收金额那条就永远等不到补画。
     */
    function addedListingAnchor(record) {
      const nodes = record.addedNodes;
      if (!nodes || !nodes.length) return false;
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node || node.nodeType !== 1) continue;
        if (node.matches && node.matches(UNIT_INPUT)) return true;
        if (node.querySelector && node.querySelector(UNIT_INPUT)) return true;
      }
      return false;
    }

    /**
     * 只有列表容器 / 上架面板里发生变化才重扫。
     * 增删都算：游戏重渲染时可能把我们的徽标顺手删掉（removedNodes），
     * 只盯着新增的话徽标就再也不会回来了；文本原地更新（characterData）也算，
     * 否则改了单价后实收金额的金价会一直停在上一个值。
     */
    function onMutations(records) {
      if (!running) return;
      if (!scope || !scope.isConnected) {
        scope = null;
        schedule();
        return;
      }
      if (listingRoot && !listingRoot.isConnected) listingRoot = null;

      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        const target = record.target;
        if (!target) continue;

        const near = Boolean(
          (scope && scope.contains(target)) || (listingRoot && listingRoot.contains(target))
        );

        if (record.type === 'characterData') {
          if (near) {
            schedule();
            return;
          }
          continue;
        }
        if (record.type !== 'childList') continue;

        if (!near) {
          // 上架面板整块被替换时，徽标随旧节点一起消失，这里兜住
          if (removedBadge(record)) {
            schedule();
            return;
          }
          // 面板刚展开（之前还没认到容器）：认到锚点就重扫一次
          if (!listingRoot && addedListingAnchor(record)) {
            listingRoot = findListingRoot();
            schedule();
            return;
          }
          continue;
        }
        if (!record.addedNodes.length && !record.removedNodes.length) continue;
        schedule();
        return;
      }
    }

    /**
     * 两类标注都画出来才算收工。
     * 列表行标上了、但上架面板展开着还没标（等所在国家 / 汇率）时不能提前停，
     * 否则用户点开「上架物品」后就只剩一条空的实收金额。
     */
    function warmUpSettled() {
      if (!grossPainted && document.querySelector(UNIT_INPUT)) return false;
      return rowPainted || grossPainted;
    }

    /**
     * 进页面先画一遍。行先渲染、凭据 / 国家清单 / 换汇挂单后到时会一行都标不上，
     * 所以每 2 秒本地重扫一次，最多 15 次（约 30 秒），两类标注都出来才停。
     * 只扫本地 DOM，不发额外请求，也不是长期轮询。
     */
    function warmUp() {
      if (!running) return;
      paintAll();
      if (warmUpSettled() || credentialTries >= WARMUP_TRIES) return;
      clearInterval(retryTimer);
      retryTimer = setInterval(() => {
        if (!running) {
          clearInterval(retryTimer);
          retryTimer = 0;
          return;
        }
        credentialTries += 1;
        paintAll();
        if (warmUpSettled() || credentialTries >= WARMUP_TRIES) {
          clearInterval(retryTimer);
          retryTimer = 0;
        }
      }, WARMUP_GAP);
    }

    function start() {
      if (running || !enabled || !document.body || !routeIsMarket()) return;
      running = true;
      credentialTries = 0;
      playerAsked = false;
      rowPainted = false;
      grossPainted = false;
      listingRoot = findListingRoot();
      ensureCurrencyMap();
      // 页面静止时也要让「过期才重拉」有机会发生：每分钟本地重扫一次，是否发请求由 TTL 决定
      if (!idleTimer) {
        idleTimer = setInterval(() => {
          if (!running || document.visibilityState !== 'visible') return;
          schedule();
        }, IDLE_SCAN_MS);
      }
      // 账号字段被别的页面刷新（旅行 / 换国籍）时立刻重画实收金额那条
      if (!offPlayer) {
        offPlayer = playerFeed.watch(() => {
          if (!running) return;
          playerAsked = false;
          schedule();
        });
      }
      // 换汇挂单被任何一处刷新（汇率面板 / 别的标注）后，这里的两条标注重新折算
      if (!offRates) {
        offRates = apiCache.watch('/market/coin/get', () => {
          if (running) schedule();
        });
      }
      // 「商品市场自动加载比价数据」开启时，市场页自己也要保证行情新鲜：过期就补一轮
      goodsAuto.sync();
      // 上架面板按「所在国家」的本币计价：进页面时确保拿到（有缓存就不再请求）
      playerFeed.ensure().then(
        () => {
          if (running) schedule();
        },
        () => {
          /* 拿不到就静默跳过，只影响上架面板那一条标注 */
        }
      );
      warmUp();
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    }

    function stop() {
      running = false;
      if (offPlayer) {
        offPlayer();
        offPlayer = null;
      }
      if (offRates) {
        offRates();
        offRates = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      clearTimeout(timer);
      clearInterval(retryTimer);
      clearInterval(idleTimer);
      timer = 0;
      retryTimer = 0;
      idleTimer = 0;
      credentialTries = 0;
      scope = null;
      listingRoot = null;
      playerAsked = false;
      rowPainted = false;
      grossPainted = false;
      unknownCodes.clear();
      // 只删自己加的徽标，游戏原有节点一个不动
      document.querySelectorAll('[' + ATTR + ']').forEach((node) => node.remove());
    }

    /** 开关和路由都走这里：不在商品市场页就不挂观察器，避免误标别的页面。 */
    function sync() {
      log('市场金价标注', routeIsMarket() ? '进入商品市场页' : '不在商品市场页');
      if (!enabled || !booted || destroyed) {
        stop();
        return;
      }
      if (routeIsMarket()) {
        start();
        // 已经挂着观察器时也要重扫一次：游戏里换品类 / 换国家可能只改文本不新增节点
        schedule();
      } else {
        stop();
      }
    }

    // 汇率到位、首次拿到登录凭据、切换市场页、从后台切回来时各补画一次，
    // 兜住「行先渲染、凭据后到」和「价格文本原地更新」这类不新增节点的情况
    // （只是本地重扫，不多打接口）。
    fxFeed.subscribe((kind) => {
      if (running && kind === 'done') schedule();
    });
    apiClient.onAuth(() => {
      if (running) schedule();
    });
    // 面板「市场」页抓到新行情后，市场页上的「比全球最低贵多少」跟着刷新
    goodsFeed.subscribe(() => {
      if (running) schedule();
    });
    route.subscribe(sync);
    on(document, 'visibilitychange', () => {
      if (running && document.visibilityState === 'visible') schedule();
    });

    return {
      get enabled() {
        return enabled;
      },
      setEnabled(next) {
        const value = next === true;
        if (value === enabled) return value;
        enabled = value;
        storage.write('marketBadge', value);
        sync();
        return value;
      },
      start,
      stop,
      sync
    };
  })();

  /* -------- 9.4a2 市场页地区快捷跳转 -------- */

  /**
   * 只有玩家不在该国家（页面上出现「你当前不在该国家」提示）时才补一行该国的地区按钮，
   * 点一下直接打开游戏自己的 /region/{region_id}，不用再从世界地图里一层层找。
   *
   * 数据：GET /country/regions?country_id=…（与商品比价的领土检查、工商面板共用 regionFeed），
   * 每个国家缓存 5 分钟；没有 data 说明该国已失去全部领土（流亡政府），照实提示。
   *
   * DOM：只往页面追加一个带 data-eh-regions 的宿主节点，界面全在自己的 Shadow DOM 里，
   * 不改游戏原有节点、不接管它们的点击；离开市场页 / 关掉开关 / destroy() 时整块移除。
   */
  const regionJump = (() => {
    const ATTR = 'data-eh-regions';
    const RETRY = 30 * 1000;
    const SCAN_DELAY = 200;
    const WARMUP_GAP = 800;
    const WARMUP_TRIES = 12;
    /** 页面上那条黄色横幅的文本；英文界面再试一次英文写法。 */
    const WARN_ZH = '你当前不在该国家';
    const WARN_EN = /not\s+(?:currently\s+)?in\s+(?:this|that)\s+country/i;

    let enabled = storage.read('regionJump', true) !== false;
    let running = false;
    let observer = null;
    let timer = 0;
    let warmTimer = 0;
    let warmTries = 0;
    let countryId = 0;
    /** null = 还没拿到（请求中 / 无凭据）；[] = 该国没有领土。 */
    let list = null;
    let pending = null;
    let failed = false;
    let failedAt = 0;
    let host = null;
    let shadow = null;
    let chipsEl = null;
    let anchor = null;
    /** 横幅里那段文字所在的节点：它消失就说明提示没了，宿主也要跟着摘掉。 */
    let warningNode = null;
    let paintedKey = '';

    /** /market/{国家 id}；不是这个形状（例如 /market 当前国家）返回 0。 */
    function marketCountryId(path) {
      const clean = String(path || '').split(/[?#]/)[0];
      const match = /(?:^|\/)market\/(\d+)(?:\/|$)/.exec(clean);
      return match ? Number(match[1]) : 0;
    }

    const normText = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

    /** 只取直接文字节点：祖先块里混着整个列表，按它筛不会把整页都算进来。 */
    function directText(el) {
      let out = '';
      for (let node = el && el.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 3) out += node.nodeValue;
      }
      return out.replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
      if (!el || !el.getClientRects) return false;
      return el.getClientRects().length > 0;
    }

    function regionIdOf(region) {
      if (!region || typeof region !== 'object') return 0;
      const raw =
        region.id != null ? region.id : region.region_id != null ? region.region_id : region.regionId;
      const id = Number(raw);
      if (Number.isFinite(id) && id > 0) return id;
      // 兜底：{ region: { id, name } } 这种包了一层的形态
      const nested = region.region;
      return nested && typeof nested === 'object' && nested !== region ? regionIdOf(nested) : 0;
    }

    function regionNameOf(region, id) {
      // 只认字符串字段：个别接口会把 region 塞成对象，直接 String() 会得到 [object Object]
      const fields = region ? [region.name, region.title, region.city] : [];
      for (let i = 0; i < fields.length; i += 1) {
        const value = fields[i];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      }
      const nested = region && region.region;
      if (nested && typeof nested === 'object' && nested !== region) return regionNameOf(nested, id);
      return '地区 ' + id;
    }

    /**
     * 页面上那条「你当前不在该国家」横幅。按「直接文字」找文案容器
     * （文字可能是一整段、也可能混在图标旁边的子节点里），再往上找到整块横幅
     * （父节点只比它多图标之类的少量文字就继续往上）。
     */
    function findWarning() {
      if (!document.body) return null;
      const nodes = document.body.querySelectorAll('span, p, div');
      let hit = null;
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        const direct = directText(el);
        if (!direct || direct.length > 120) continue;
        if (direct.indexOf(WARN_ZH) < 0 && !WARN_EN.test(direct)) continue;
        // 文案容器本身不该带着整块列表的文字
        if (normText(el).length > 120) continue;
        if (!isVisible(el)) continue;
        hit = el;
      }
      if (!hit) return null;

      let banner = hit;
      for (let i = 0; i < 4; i += 1) {
        const parent = banner.parentElement;
        if (!parent || parent === document.body) break;
        // 父节点只多了图标 / 关闭按钮这类零星文字，才算同一块横幅；
        // 一旦混进表头、商品行，就直接停在当前这层
        if (normText(parent).length > normText(banner).length + 16) break;
        // 同一横条：高度不能明显变大（列表、表头都在下面，会把高度撑起来）。
        // 放宽 40px 给横幅自己的内边距 / 边框；再往外一层就会带上表头或商品行
        const rect = parent.getBoundingClientRect();
        const cur = banner.getBoundingClientRect();
        if (!rect.height || rect.height > cur.height + 40) break;
        banner = parent;
      }
      return { banner, text: hit };
    }

    /** 只在「你当前不在该国家」提示出现时显示；没有这条横幅就不画。 */
    const findAnchor = () => findWarning();

    const STYLE = `
      :host { all: initial; display: block; }
      * { box-sizing: border-box; }
      .eh-rj {
        display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, .06);
        background: rgba(255, 255, 255, .02);
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        color: #cbd5e1;
      }
      .eh-rj-cap {
        flex: none; color: #8b98ab; font-size: 11px; letter-spacing: .08em;
        white-space: nowrap;
      }
      .eh-rj-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
      .eh-rj-chip {
        appearance: none; max-width: 14em; padding: 2px 10px;
        border: 1px solid rgba(201, 165, 74, .35); border-radius: 999px;
        background: rgba(201, 165, 74, .1); color: #f0d9a4;
        font: inherit; line-height: 1.5; white-space: nowrap; cursor: pointer;
        overflow: hidden; text-overflow: ellipsis;
        transition: background .15s, border-color .15s, color .15s;
      }
      .eh-rj-chip:hover {
        background: rgba(201, 165, 74, .22);
        border-color: rgba(232, 205, 143, .7);
        color: #f6e6bb;
      }
      .eh-rj-chip:focus-visible { outline: 1px solid rgba(201, 165, 74, .7); outline-offset: 1px; }
      .eh-rj-note { color: #7d8ba0; font-size: 11.5px; }
      .eh-rj-note.is-warn { color: #d9a35e; }
    `;

    function ensureHost() {
      if (host) return host;
      host = document.createElement('div');
      host.setAttribute(ATTR, '');
      host.style.cssText = 'display:block;box-sizing:border-box;width:100%;max-width:100%;';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<style>' +
        STYLE +
        '</style><div class="eh-rj"><span class="eh-rj-cap">地区</span>' +
        '<div class="eh-rj-chips" data-role="chips"></div></div>';
      chipsEl = shadow.querySelector('[data-role="chips"]');
      shadow.addEventListener('click', (event) => {
        const target = event.target;
        const btn =
          target && target.closest ? target.closest('button[data-region]') : null;
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        const id = Number(btn.getAttribute('data-region')) || 0;
        if (!id) return;
        log('地区快捷跳转', '前往地区 ' + id);
        route.goto('/region/' + id);
      });
      return host;
    }

    function paintContent() {
      if (!chipsEl) return;
      const key =
        countryId +
        '|' +
        (list ? list.map((region) => regionIdOf(region)).join(',') : failed ? 'failed' : 'loading');
      if (key === paintedKey) return;
      paintedKey = key;

      chipsEl.textContent = '';
      const note = (text, warn) => {
        const el = document.createElement('span');
        el.className = warn ? 'eh-rj-note is-warn' : 'eh-rj-note';
        el.textContent = text;
        chipsEl.appendChild(el);
      };

      if (!list) {
        note(failed ? '地区信息读取失败' : '正在读取地区…', Boolean(failed));
        return;
      }
      if (!list.length) {
        note('该国已失去全部领土，无法前往', true);
        return;
      }

      let count = 0;
      list.forEach((region) => {
        const id = regionIdOf(region);
        if (!id) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-rj-chip';
        btn.setAttribute('data-region', String(id));
        btn.textContent = regionNameOf(region, id);
        chipsEl.appendChild(btn);
        count += 1;
      });
      if (!count) note('该国暂时没有可前往的地区', false);
    }

    /** 把宿主节点放到横幅下方；页面上没有这条横幅就摘掉宿主并返回 false。 */
    function place() {
      const el = ensureHost();
      const info = findAnchor();
      if (!info) {
        if (el.isConnected) el.remove();
        anchor = null;
        warningNode = null;
        return false;
      }

      const next = info.banner;
      if (
        el.isConnected &&
        anchor === next &&
        anchor.isConnected &&
        warningNode &&
        warningNode.isConnected &&
        el.previousElementSibling === anchor
      ) {
        return true;
      }

      const parent = next.parentNode;
      if (!parent) return false;
      if (el.parentNode) el.remove();
      parent.insertBefore(el, next.nextSibling);
      anchor = next;
      warningNode = info.text;
      return true;
    }

    function ensureData() {
      if (!running || !countryId) return;
      const id = countryId;
      // 与商品比价的领土检查、工商面板共用一份地区缓存：同一国家 10 分钟内只请求一次
      const cached = regionFeed.get(id);
      if (cached) {
        if (list !== cached) {
          list = cached;
          paintedKey = '';
        }
        return;
      }
      if (pending) return;
      if (failedAt && Date.now() - failedAt < RETRY) return;
      if (apiClient.state !== 'ok') return;

      pending = regionFeed
        .ensure(id)
        .then((regions) => {
          failed = false;
          if (running && countryId === id) {
            list = regions;
            paintedKey = '';
            schedule();
          }
        })
        .catch((err) => {
          failed = true;
          failedAt = Date.now();
          paintedKey = '';
          log('地区快捷跳转：地区清单读取失败', err && (err.message || err.code));
        })
        .then(() => {
          pending = null;
          if (running) schedule();
        });
    }

    function paint() {
      if (!running || !enabled) return;
      // 还没有凭据、也没有缓存数据：静默不画，等凭据到位或下一轮扫描，别在页面上留半条空栏
      if (!list && apiClient.state !== 'ok') {
        if (host && host.isConnected) host.remove();
        anchor = null;
        warningNode = null;
        return;
      }
      // 先确认页面上确实有这条提示，再发请求：玩家就在该国时不打这个接口
      if (!place()) return;
      ensureData();
      paintContent();
    }

    function schedule() {
      if (!running || timer) return;
      timer = setTimeout(() => {
        timer = 0;
        paint();
      }, SCAN_DELAY);
    }

    /**
     * 只关心「宿主还在不在 / 锚点还在不在」：在的话直接返回，不跟着价格跳动重扫；
     * 游戏重渲染把横幅或我们的节点换掉时，把它补回去。
     */
    function onMutations() {
      if (!running) return;
      if (host && host.isConnected) {
        // 横幅文字还在且可见才算提示还在；容器本身被复用时也要重扫，不能只看锚点
        if (
          anchor &&
          anchor.isConnected &&
          warningNode &&
          warningNode.isConnected &&
          isVisible(warningNode)
        ) {
          return;
        }
        host.remove();
        anchor = null;
        warningNode = null;
      }
      schedule();
    }

    /** 进页面时游戏还在渲染，锚点可能几秒后才出现：本地重扫到放上去为止。 */
    function warmUp() {
      if (warmTimer) return;
      warmTries = 0;
      warmTimer = setInterval(() => {
        if (!running) {
          clearInterval(warmTimer);
          warmTimer = 0;
          return;
        }
        warmTries += 1;
        schedule();
        if (warmTries >= WARMUP_TRIES || (host && host.isConnected)) {
          clearInterval(warmTimer);
          warmTimer = 0;
        }
      }, WARMUP_GAP);
    }

    function start(id) {
      if (running && countryId === id) {
        schedule();
        return;
      }
      stop();
      running = true;
      countryId = id;
      failed = false;
      failedAt = 0;
      paintedKey = '';
      list = regionFeed.get(id);

      // 不在这里发请求：等 paint 确认页面上确实有「你当前不在该国家」提示再拉地区
      warmUp();
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true });
      }
      schedule();
    }

    function stop() {
      running = false;
      countryId = 0;
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      clearTimeout(timer);
      clearInterval(warmTimer);
      timer = 0;
      warmTimer = 0;
      warmTries = 0;
      anchor = null;
      warningNode = null;
      list = null;
      failed = false;
      paintedKey = '';
      // 只删自己加的宿主，游戏原有节点一个不动
      if (host) {
        host.remove();
        host = null;
        shadow = null;
        chipsEl = null;
      }
    }

    /** 开关与路由都走这里：不在 /market/{国家 id} 就整块摘掉。 */
    function sync() {
      const id = marketCountryId(route.current);
      if (!enabled || !booted || destroyed || !id) {
        stop();
        return;
      }
      start(id);
    }

    // 凭据晚到（面板先开、游戏还没发过请求）时补一轮，不用玩家手动刷新
    apiClient.onAuth(() => {
      if (!running) return;
      failedAt = 0;
      schedule();
    });
    route.subscribe(sync);

    return {
      get enabled() {
        return enabled;
      },
      setEnabled(next) {
        const value = next === true;
        if (value === enabled) return value;
        enabled = value;
        storage.write('regionJump', value);
        sync();
        return value;
      },
      start,
      stop,
      sync
    };
  })();

  /* -------- 9.4b 市场跳转：把面板里点的那一行带到游戏市场页 -------- */

  /**
   * 商品市场的地址只带国家（/market/{country_id}），商品与品质游戏没放进 URL，
   * 所以跳过去之后只能按文本点一下它自己的筛选按钮。
   *
   * 约束：只点文本（或图标 alt）完全相等的可点控件，链接（href）一律不点，
   * 避免把玩家带到商品详情或列表行的其它页面；也从不提交表单、不下单。
   * 找不到就安静放弃，`sessionStorage` 里的意图一并清掉。
   */
  const marketJump = (() => {
    const INTENT_KEY = 'eh:market-intent';
    const INTENT_TTL = 10 * 60 * 1000;
    const RETRY_MS = 250;
    // 整页刷新进来时游戏还要拉一轮行情，给足 10 秒
    const MAX_TRIES = 40;

    let timer = 0;
    let tries = 0;
    let pendingKey = '';
    let itemPicked = false;
    // 分类和品质按钮都在「筛选」面板里，默认是收起的，只展开一次
    let filterOpened = false;
    let destroyed = false;

    const norm = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();

    /** 当前是不是 /market/{国家 id}；是的话返回国家 id，否则 0。 */
    function currentCountryId() {
      const match = /(?:^|\/)market\/(\d+)(?:\/|$)/.exec(location.pathname);
      return match ? Number(match[1]) : 0;
    }

    /**
     * 意图放 sessionStorage，而不是拼在 URL 上：
     * 游戏会按自己的路由重写地址，未知参数容易被它清掉；
     * sessionStorage 在整页刷新后也还在，正好覆盖「SPA 没接住」那一档。
     */
    function remember(intent) {
      if (!intent || !intent.api || intent.countryId == null) return;
      try {
        sessionStorage.setItem(
          INTENT_KEY,
          JSON.stringify({
            countryId: Number(intent.countryId),
            api: String(intent.api),
            quality: Number(intent.quality) || 0,
            at: Date.now()
          })
        );
      } catch (err) {
        /* 隐私模式写不进去就算了，跳转本身不受影响 */
      }
    }

    function clearIntent() {
      try {
        sessionStorage.removeItem(INTENT_KEY);
      } catch (err) {
        /* ignore */
      }
    }

    function readIntent() {
      // 只在市场页消费：/market（当前国家）或 /market/{国家 id} 都算
      if (!/(?:^|\/)market(?:\/\d+)?(?:\/|$)/.test(location.pathname)) return null;
      const countryId = currentCountryId();

      let raw = '';
      try {
        raw = sessionStorage.getItem(INTENT_KEY) || '';
      } catch (err) {
        return null;
      }
      if (!raw) return null;

      let intent = null;
      try {
        intent = JSON.parse(raw);
      } catch (err) {
        intent = null;
      }
      if (!intent || !intent.api || Date.now() - Number(intent.at || 0) > INTENT_TTL) {
        clearIntent();
        return null;
      }
      // 路径带国家 id 时要求一致；/market 是「当前国家」，没法比，直接用
      if (countryId && Number(intent.countryId) !== countryId) return null;

      return { api: String(intent.api), quality: Number(intent.quality) || 0 };
    }

    function isVisible(el) {
      return el instanceof HTMLElement && el.getClientRects().length > 0;
    }

    /** 从命中的节点向上找一个真正可点的容器；链接一律不点（会把人带到详情页）。 */
    function clickableOf(el) {
      let node = el;
      for (let depth = 0; depth < 4 && node instanceof HTMLElement; depth += 1, node = node.parentElement) {
        const role = node.getAttribute('role');
        if (node.tagName === 'BUTTON' || role === 'button' || role === 'tab' || role === 'option') return node;
        if (node.tagName === 'A' && node.getAttribute('href')) return null;
        if (getComputedStyle(node).cursor === 'pointer') return node;
      }
      return null;
    }

    /**
     * 页面上文本完全等于 label 的可点击控件；找不到返回 null。
     * 只认按钮类节点：顶栏资源位里到处是「食物」这种图标 / 文字，
     * 点到那里没有任何反应，会让人以为「找不到控件」。
     */
    function findButton(label) {
      const wanted = norm(label);
      if (!wanted) return null;

      const nodes = document.querySelectorAll('button, a, [role], li');
      // 两轮：先按文字精确匹配，再退到图标 alt（只对纯图标按钮生效）
      for (let pass = 0; pass < 2; pass += 1) {
        for (let i = 0; i < nodes.length; i += 1) {
          const el = nodes[i];
          // 子节点多的多半是整块区域，先排掉，省掉大段 textContent 拼接
          if (el.children.length > 3) continue;
          if (!isVisible(el)) continue;

          const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
          if (pass === 0) {
            if (!text || text.length > 12 || norm(text) !== wanted) continue;
          } else {
            if (text) continue;
            const img = el.querySelector('img[alt]');
            if (!img || norm(img.getAttribute('alt')) !== wanted) continue;
          }

          const target = clickableOf(el);
          if (target) return target;
        }
      }
      return null;
    }

    /** 放弃前把页面上的按钮文本丢进调试日志，方便排查是不是文案对不上。 */
    function logCandidates() {
      const nodes = document.querySelectorAll('button, [role="button"], [role="tab"], [role="option"]');
      const labels = [];
      for (let i = 0; i < nodes.length && labels.length < 40; i += 1) {
        const text = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 12) labels.push(text);
      }
      log('市场跳转', '页面上的可点文案：', labels);
    }

    /**
     * 游戏市场页只按 4 个大类筛选（食物 / 武器 / 票券 / 原材料），没有「具体商品」这一层，
     * 所以插件里的 8 种商品要先落到游戏分类上：飞机和武器同属「武器」，机票属于「票券」，
     * 四种原材料都归「原材料」。英文界面下再试英文类别名和 api 本名。
     */
    const MARKET_CATEGORY = {
      Food: ['食物', 'Food'],
      Weapon: ['武器', 'Weapon'],
      Aircraft: ['武器', 'Weapon'],
      'Airplane ticket': ['票券', 'Ticket'],
      Grain: ['原材料', 'Material'],
      Iron: ['原材料', 'Material'],
      Fuel: ['原材料', 'Material'],
      Titanium: ['原材料', 'Material']
    };

    function findItemButton(api) {
      const meta = GOODS_META.get(api);
      const labels = (MARKET_CATEGORY[api] || []).concat(meta ? [meta.zh] : [], [api]);
      for (let i = 0; i < labels.length; i += 1) {
        const btn = findButton(labels[i]);
        if (btn) return btn;
      }
      return null;
    }

    function schedule(delay) {
      clearTimeout(timer);
      timer = setTimeout(step, delay);
    }

    function giveUp(reason) {
      log('市场跳转', reason);
      logCandidates();
      clearIntent();
      pendingKey = '';
    }

    function retry() {
      tries += 1;
      if (tries >= MAX_TRIES) {
        giveUp('没找到对应筛选控件，放弃');
        return;
      }
      schedule(RETRY_MS);
    }

    function step() {
      timer = 0;
      if (destroyed) return;

      const intent = readIntent();
      if (!intent) {
        pendingKey = '';
        return;
      }

      const key = intent.api + '#' + intent.quality;
      if (pendingKey !== key) {
        pendingKey = key;
        tries = 0;
        itemPicked = false;
        filterOpened = false;
      }

      if (!itemPicked) {
        const itemBtn = findItemButton(intent.api);
        if (!itemBtn) {
          // 市场页默认收起「筛选」，分类按钮在里面，先展开再重试
          if (!filterOpened) {
            const filterBtn = findButton('筛选');
            if (filterBtn) {
              filterOpened = true;
              filterBtn.click();
              tries = 0;
              schedule(RETRY_MS);
              return;
            }
          }
          retry();
          return;
        }
        itemBtn.click();
        itemPicked = true;
        // 列表要重渲染一次品质按钮才出来，重新计时
        tries = 0;
        schedule(RETRY_MS);
        return;
      }

      if (intent.quality > 0) {
        const qBtn = findButton('Q' + intent.quality);
        if (!qBtn) {
          retry();
          return;
        }
        qBtn.click();
      }

      log('市场跳转', '已切到 ' + intent.api + (intent.quality ? ' Q' + intent.quality : ''));
      clearIntent();
      pendingKey = '';
    }

    function start() {
      if (destroyed) return;
      if (!readIntent()) return;
      tries = 0;
      schedule(0);
    }

    // 面板里跳过来（SPA）与整页刷新进来都要跑一次
    route.subscribe(start);

    return {
      remember,
      start,
      destroy() {
        destroyed = true;
        clearTimeout(timer);
        timer = 0;
      }
    };
  })();

  /* -------- 9.5 工商：子面板（目前只有「工业」） -------- */

  /**
   * 「工商」标签下挂的子面板表。目前只有「工业」；以后加别的子面板
   * （比如原材料、物流）只要再写一个 registerBusinessPane 调用，
   * 顶层的「工商」标签与内部的子标签栏都不需要改。
   */
  const businessPanes = [];

  function registerBusinessPane(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) return null;
    if (typeof definition.title !== 'string' || !definition.title.trim()) return null;
    if (typeof definition.mount !== 'function') return null;
    if (businessPanes.some((item) => item.id === definition.id)) {
      warn('工商子面板 id 重复，已忽略：' + definition.id);
      return null;
    }
    businessPanes.push(definition);
    return definition;
  }

  /** 地区物产（bonus）的中文名：接口给的是英文枚举，未知类型直接显示原文。 */
  const REGION_BONUS_LABELS = {
    FOOD: '食物',
    WEAPONS: '武器',
    TICKETS: '票券',
    GRAIN: '谷物',
    IRON: '铁',
    OIL: '石油',
    TITANIUM: '钛',
    AIRCRAFT: '飞机'
  };

  /**
   * 工业：按国家拉一遍全部地区（GET /country/regions，与商品比价的领土检查共用 regionFeed，
   * 同一国家 5 分钟内只请求一次），把建筑等级、物产、污染与 NPC 数量列成一张可排序的表。
   *
   * 只做展示：不提交、不下单；每行右侧的跳转按钮走 route.goto('/region/{id}')。
   */
  registerBusinessPane({
    id: 'industry',
    title: '工业',
    order: 10,
    mount(pane, ctx) {
      /**
       * 可排序的列；score 是默认的综合规则，其余各自对应列表里的一项数据。
       * 资源产区 / 工业区最高只有 5 级，单独排序区分度太低（同级的会占掉一大片），
       * 所以不放进手动排序，需要时看「综合」即可。
       */
      const SORTS = [
        { key: 'score', label: '综合', dir: -1 },
        { key: 'bonus', label: '物产', dir: -1 },
        { key: 'pollution', label: '污染', dir: 1 },
        { key: 'npc', label: 'NPC', dir: -1 }
      ];

      // 排序 / 状态固定在顶部，只有地区列表跟着滚（表头不随列表滚走）
      pane.classList.add('eh-pane--stick');
      pane.innerHTML = `
        <div class="eh-stick-head">
          <div class="eh-biz-search">
            <input class="eh-input" type="search" data-role="query" placeholder="搜索地区名、国家名（中 / 英）或法币" autocomplete="off" spellcheck="false" aria-label="搜索地区名、国家或法币" />
          </div>
          <div class="eh-biz-sorts">
            <span class="eh-biz-sorts__cap">排序</span>
            <div class="eh-biz-chips" data-role="sorts"></div>
          </div>
          <div class="eh-biz-bar">
            <p class="eh-fx-status" data-role="status">…</p>
            <button class="eh-btn" type="button" data-role="refresh">刷新地区</button>
          </div>
        </div>
        <div class="eh-stick-scroll">
          <div class="eh-biz-list" data-role="list"></div>
          <p class="eh-empty" data-role="empty" hidden>还没有地区数据，点「刷新」抓取一次。</p>
        </div>
      `;

      const sortsEl = pane.querySelector('[data-role="sorts"]');
      const listEl = pane.querySelector('[data-role="list"]');
      const emptyEl = pane.querySelector('[data-role="empty"]');
      const statusEl = pane.querySelector('[data-role="status"]');
      const refreshBtn = pane.querySelector('[data-role="refresh"]');
      const queryEl = pane.querySelector('[data-role="query"]');

      let alive = true;
      let loading = false;
      let error = null;
      let failures = 0;
      let limited = false;
      let progress = { done: 0, total: 0 };
      let updatedAt = 0;
      let rows = [];
      let countryById = new Map();
      let query = '';

      // 排序方式记在功能自己的 storage 里（eclesiar-helper:business:industry:sort）
      const saved = ctx.storage.get('sort', null);
      let sortKey = 'score';
      let sortDir = -1;
      if (saved && typeof saved === 'object' && SORTS.some((item) => item.key === saved.key)) {
        sortKey = saved.key;
        sortDir = saved.dir === 1 ? 1 : -1;
      }

      /** 污染 / 物产这类百分数：整数就不带小数，36.05 这类留一位。 */
      const bizPercent = (value) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        return Number(num.toFixed(1)) + '%';
      };

      const saveSort = () => ctx.storage.set('sort', { key: sortKey, dir: sortDir });

      /* ---------- 排序标签 ---------- */

      const chipEls = new Map();
      SORTS.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-biz-chip';
        const label = document.createElement('span');
        label.textContent = item.label;
        const arrow = document.createElement('span');
        arrow.className = 'eh-biz-chip__dir';
        btn.appendChild(label);
        btn.appendChild(arrow);
        on(btn, 'click', () => {
          if (sortKey === item.key) {
            sortDir = -sortDir;
          } else {
            sortKey = item.key;
            sortDir = item.dir > 0 ? 1 : -1;
          }
          saveSort();
          paintSort();
          renderList();
          ctx.ui.reposition();
        });
        sortsEl.appendChild(btn);
        chipEls.set(item.key, btn);
      });

      function paintSort() {
        chipEls.forEach((btn, key) => {
          const active = key === sortKey;
          btn.classList.toggle('is-active', active);
          const arrow = btn.querySelector('.eh-biz-chip__dir');
          if (arrow) arrow.textContent = active ? (sortDir > 0 ? '↑' : '↓') : '';
        });
      }

      /* ---------- 数据 ---------- */

      /**
       * 默认排序的档位：三类数据齐全 > 有工业区 + 资源产区 / 物产 > 只有工业区 > 只有资源产区 > 只有物产。
       * 用「凑齐几项」加上「有没有工业区」编码，保证 工业区 > 资源产区 的优先级，
       * 同级再比综合分，这样物产多的地区不会因为等级低就被压到最后。
       */
      function tierOf(row) {
        const hasIndustry = row.industry > 0;
        const hasProduction = row.production > 0;
        const hasBonus = row.bonusPoints > 0;
        const parts = (hasIndustry ? 1 : 0) + (hasProduction ? 1 : 0) + (hasBonus ? 1 : 0);
        return parts * 2 + (hasIndustry ? 1 : 0);
      }

      /** 接口的一条地区 → 列表的一行；缺字段一律按 0 处理，不因为个别字段丢了整行。 */
      function buildDataRow(country, region) {
        if (!region || typeof region !== 'object') return null;
        const rawId = region.id != null ? region.id : region.region_id;
        const id = Number(rawId);
        if (!Number.isFinite(id) || id <= 0) return null;

        const buildings = region.buildings || {};
        const levelOf = (key) => {
          const item = buildings[key];
          const level = Number(item && item.level);
          return Number.isFinite(level) && level > 0 ? level : 0;
        };

        const bonus = (Array.isArray(region.bonus) ? region.bonus : [])
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const type = String(item.type || '').toUpperCase();
            const value = Number(item.value);
            if (!type || !Number.isFinite(value) || value <= 0) return null;
            return { type, label: REGION_BONUS_LABELS[type] || type, value };
          })
          .filter(Boolean);

        const pollution = Math.max(0, Math.min(100, Number(region.pollution) || 0));
        const npcs = Number(region.nb_npcs);

        // 占领后 region.country_id 才是当前所属国：旗子跟着现主人走
        const ownerId = region.country_id != null ? String(region.country_id) : String(country.id);
        const owner = countryById.get(ownerId) || country;
        const locale = fxLocale(owner.code);

        const row = {
          id,
          name: String(region.name || region.title || '地区 ' + id),
          production: levelOf('production_fields'),
          industry: levelOf('industrial_zone'),
          bonus,
          // 物产是百分比加成（5 / 15 / 30），折算成和建筑等级同一量级的分数（0.5 / 1.5 / 3）
          bonusPoints: bonus.reduce((sum, item) => sum + item.value, 0) / 10,
          pollution,
          npcs: Number.isFinite(npcs) && npcs > 0 ? npcs : 0,
          countryId: owner.id,
          countryName: owner.name,
          countryZh: locale ? locale[0] : '',
          countryCode: owner.code,
          countryAvatar: owner.avatar
        };
        row.tier = tierOf(row);
        // 主物产：加成最高的那一项（并列取先出现的），「物产」排序按它把同类产地聚到一起
        row.primary = bonus.reduce((best, item) => (best && best.value >= item.value ? best : item), null);
        row.primaryLabel = row.primary ? row.primary.label : '';
        // 污染按扣减计：三项之和 × （1 − 污染%），同档位里污染越低越靠前
        row.score = (row.production + row.industry + row.bonusPoints) * (1 - pollution / 100);
        return row;
      }

      const sortValue = (row, key) => {
        if (key === 'bonus') return row.bonusPoints;
        if (key === 'pollution') return row.pollution;
        if (key === 'npc') return row.npcs;
        return row.score;
      };

      const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans');

      /**
       * 当前列 + 方向；同值时依次看综合档位、综合分、污染（低的在前），最后按地区名。
       * 「物产」排序：先按加成总和，总和相同时再按主物产聚拢——同类的产地连成一片，
       * 但不同总和之间仍按数值排，30% 的谷物不会跑到 5% 的铁后面。
       */
      function comparator() {
        const key = sortKey;
        const dir = sortDir;
        return (a, b) => {
          // 综合排序里档位是硬性优先级，翻转方向也只影响同一档位内部
          if (key === 'score' && a.tier !== b.tier) return b.tier - a.tier;

          const left = sortValue(a, key);
          const right = sortValue(b, key);
          if (left !== right) return dir > 0 ? left - right : right - left;

          // 同类物产连在一起（分组不跟随升降序反转，永远按类型名排）
          if (key === 'bonus' && a.primaryLabel !== b.primaryLabel) {
            return a.primaryLabel.localeCompare(b.primaryLabel, 'zh-Hans');
          }

          if (key !== 'score' && a.tier !== b.tier) return b.tier - a.tier;
          if (key !== 'score' && a.score !== b.score) return b.score - a.score;
          if (a.pollution !== b.pollution) return a.pollution - b.pollution;
          return byName(a, b);
        };
      }

      /* ---------- 渲染 ---------- */

      function buildRow(row, index) {
        const el = document.createElement('div');
        el.className = 'eh-biz-row';
        // 只有默认综合排序的第一名标绿：换成按污染排序时「第一名」不代表最优
        if (sortKey === 'score' && index === 0) el.classList.add('is-best');

        const head = document.createElement('div');
        head.className = 'eh-biz-head';

        head.appendChild(buildFlagEl(row.countryCode, row.countryAvatar));

        const nameWrap = document.createElement('span');
        nameWrap.className = 'eh-biz-name';
        const nameEl = document.createElement('b');
        nameEl.textContent = row.name;
        nameEl.title = row.name;
        nameWrap.appendChild(nameEl);

        const countryEl = document.createElement('span');
        countryEl.className = 'eh-biz-country';
        countryEl.textContent = row.countryZh || row.countryName;
        countryEl.title = row.countryZh ? row.countryZh + ' · ' + row.countryName : row.countryName;
        nameWrap.appendChild(countryEl);
        head.appendChild(nameWrap);
        // 标题行最右侧的跳转：打开游戏自己的地区页面（只跳转，不做任何游戏内操作）
        head.appendChild(buildGoButton('前往「' + row.name + '」的地区页面', '/region/' + row.id));
        el.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'eh-biz-meta';
        const cell = (label, value, tone, wrap) =>
          '<span class="eh-biz-cell' +
          (wrap ? ' eh-biz-cell--wrap' : '') +
          '"><em>' +
          label +
          '</em><b' +
          (tone ? ' data-tone="' + tone + '"' : '') +
          '>' +
          value +
          '</b></span>';
        const bonusText = row.bonus.length
          ? row.bonus.map((item) => item.label + ' ' + bizPercent(item.value)).join('、')
          : '—';
        meta.innerHTML =
          cell('资源产区', row.production) +
          cell('工业区', row.industry) +
          cell('物产', escapeHtml(bonusText), '', true) +
          cell('污染', bizPercent(row.pollution), row.pollution >= 50 ? 'warn' : '') +
          cell('NPC', row.npcs);
        meta.title =
          '综合分 = （资源产区 ' +
          row.production +
          ' + 工业区 ' +
          row.industry +
          ' + 物产 ' +
          Number(row.bonusPoints.toFixed(2)) +
          '）×（1 − 污染 ' +
          bizPercent(row.pollution) +
          '）= ' +
          Number(row.score.toFixed(2));
        el.appendChild(meta);
        return el;
      }

      /** 搜索匹配：地区名、国家中 / 英文名、法币代码四路任一命中。 */
      const matchesQuery = (row, keyword) => {
        if (!keyword) return true;
        if (row.name && row.name.toLowerCase().indexOf(keyword) !== -1) return true;
        if (row.countryName && row.countryName.toLowerCase().indexOf(keyword) !== -1) return true;
        if (row.countryZh && row.countryZh.toLowerCase().indexOf(keyword) !== -1) return true;
        if (row.countryCode && row.countryCode.toLowerCase().indexOf(keyword) !== -1) return true;
        return false;
      };

      function renderList() {
        if (!alive) return;
        const keyword = query.trim().toLowerCase();
        const items = rows.filter((row) => matchesQuery(row, keyword)).sort(comparator());
        listEl.textContent = '';
        items.forEach((row, index) => listEl.appendChild(buildRow(row, index)));

        if (items.length) {
          emptyEl.hidden = true;
          return;
        }
        // 凭据还没到手时状态栏已经说明原因，别在下面再写一句「点刷新抓取」
        const blocked =
          (error && (error.code === 'NO_TOKEN' || error.code === 'UNAUTHORIZED')) ||
          (apiClient.state !== 'ok' && !updatedAt);
        emptyEl.hidden = Boolean(loading) || Boolean(blocked);
        emptyEl.textContent = keyword
          ? '没有匹配「' + query.trim() + '」的地区。'
          : updatedAt
            ? '这次没有读到任何地区数据，稍后可以点「刷新地区」再试。'
            : '还没有地区数据，点「刷新地区」抓取一次。';
      }

      /** 共用提示里写的是「刷新行情」，这页的按钮叫「刷新地区」，换一下别让玩家找不到。 */
      const tokenHint = () => authHint().replace('刷新行情', '刷新地区');

      function paintStatus() {
        if (!alive) return;
        refreshBtn.disabled = loading;

        if (loading) {
          if (!progress.total) {
            statusEl.textContent = '正在读取国家清单…';
            return;
          }
          statusEl.textContent =
            '正在读取 ' + progress.done + '/' + progress.total + ' 个国家的地区…';
          return;
        }

        if (apiClient.state !== 'ok' && !updatedAt) {
          statusEl.textContent = tokenHint();
          statusEl.dataset.tone = 'warn';
          return;
        }

        if (error) {
          const code = error.code;
          if (code === 'NO_TOKEN' || code === 'UNAUTHORIZED') {
            statusEl.textContent = tokenHint();
            statusEl.dataset.tone = code === 'UNAUTHORIZED' ? 'error' : 'warn';
          } else if (code === 'TIMEOUT') {
            statusEl.textContent = '请求超时，请稍后重试。';
            statusEl.dataset.tone = 'error';
          } else if (quotaHint(error) || error.limited) {
            statusEl.textContent =
              quotaHint(error) || '接口返回 429（请求过多或已达当日查询上限），请稍后再试。';
            statusEl.dataset.tone = 'error';
          } else {
            statusEl.textContent = '读取失败：' + fetchErrorText(error);
            statusEl.dataset.tone = 'error';
          }
          return;
        }

        delete statusEl.dataset.tone;
        if (!updatedAt) {
          statusEl.textContent = '还没有地区数据，点「刷新地区」抓取一次。';
          return;
        }
        const countries = new Set(rows.map((row) => String(row.countryId))).size;
        let suffix = failures ? ' · ' + failures + ' 个国家读取失败' : '';
        // 个别国家被 429 拦下时整轮还是能出结果的，单独提醒一句额度
        if (limited) suffix += '（含 429，可到「设置」页生成专用密钥）';
        statusEl.textContent =
          rows.length + ' 个地区 · ' + countries + ' 个国家\n更新于 ' + formatClock(updatedAt) + suffix;
      }

      const paint = () => {
        paintStatus();
        renderList();
      };

      /* ---------- 抓取 ---------- */

      let offAuth = null;
      /** 凭据晚到（面板先开、游戏还没发过请求）时补一轮，不用玩家手动刷新。 */
      const armAuthRetry = () => {
        if (offAuth) return;
        offAuth = apiClient.onAuth(() => {
          offAuth = null;
          if (!loading && !updatedAt) load();
        });
      };

      /**
       * 拉一遍所有国家的地区。
       * pull 决定「命中缓存还是绕过 TTL」，由下面的 load / refresh 两个入口选：
       * 打开面板走 regionFeed.ensure（刚拉过的国家直接命中 10 分钟缓存），
       * 点「刷新数据」走 regionFeed.refresh（重抓，失败保留旧值）。
       * countriesMode 同理决定国家清单是否绕过页面级 TTL。
       */
      function run(pull, countriesMode) {
        if (!alive || loading) return;
        if (apiClient.state !== 'ok') {
          error = { code: apiClient.state === 'expired' ? 'UNAUTHORIZED' : 'NO_TOKEN' };
          paint();
          armAuthRetry();
          return;
        }

        loading = true;
        error = null;
        failures = 0;
        limited = false;
        progress = { done: 0, total: 0 };
        paint();

        (async () => {
          try {
            const countries = await fxFeed.loadCountries(countriesMode);
            if (!alive) return;

            const targets = (Array.isArray(countries) ? countries : [])
              .filter((country) => country && country.id != null)
              .map((country) => ({
                id: country.id,
                name: String(country.name || ''),
                avatar: country.avatar,
                code: country.currency ? String(country.currency.name || '') : ''
              }));

            if (!targets.length) {
              const empty = new Error('没有可用的国家清单');
              empty.code = 'EMPTY_COUNTRIES';
              throw empty;
            }

            countryById = new Map(targets.map((country) => [String(country.id), country]));
            progress = { done: 0, total: targets.length };
            paintStatus();

            const next = [];
            let cursor = 0;
            const worker = async () => {
              while (cursor < targets.length) {
                if (!alive) return;
                const country = targets[cursor];
                cursor += 1;
                try {
                  const regions = await pull(country.id);
                  regions.forEach((region) => {
                    const row = buildDataRow(country, region);
                    if (row) next.push(row);
                  });
                } catch (err) {
                  if (err && err.code === 'UNAUTHORIZED') throw err;
                  if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
                  failures += 1;
                  ctx.log('地区读取失败', country.name + ' · ' + ((err && err.code) || 'ERROR'));
                }
                progress = { done: progress.done + 1, total: progress.total };
                if (alive) paintStatus();
                await fxSleep(FX_GAP);
              }
            };

            await Promise.all(
              Array.from({ length: Math.min(FX_CONCURRENCY, targets.length) }, () => worker())
            );
            if (!alive) return;

            rows = next;
            // 「更新于」= 这屏里最旧的一份地区数据（命中 10 分钟缓存时不要谎报成「刚刚」）
            const stamps = targets.map((country) => regionFeed.atOf(country.id)).filter(Boolean);
            updatedAt = stamps.length ? Math.min.apply(null, stamps) : Date.now();
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            error = {
              code: (err && err.code) || 'ERROR',
              message: err && err.message,
              limited
            };
            // 凭据过期后玩家重新登录（游戏发出新凭据）时自动补一轮
            if (error.code === 'UNAUTHORIZED' || error.code === 'NO_TOKEN') armAuthRetry();
          } finally {
            loading = false;
            if (alive) {
              paint();
              // 面板内容高度变了，重新测一次，别沿用旧的
              ctx.ui.reposition();
            }
          }
        })();
      }

      /** 打开面板 / 凭据晚到时走缓存。 */
      const load = () => run((countryId) => regionFeed.ensure(countryId), 'ensure');
      /** 「刷新数据」：绕过 TTL 重抓，失败保留上一轮的结果。 */
      const refresh = () => run((countryId) => regionFeed.refresh(countryId), 'refresh');

      on(refreshBtn, 'click', () => refresh());

      on(queryEl, 'input', () => {
        query = queryEl.value || '';
        renderList();
        ctx.ui.reposition();
      });

      // 面板在 Shadow DOM 内，游戏若在 document / window 上监听按键，拿到的 target 会被重定向成宿主元素，
      // 很容易被当成「在页面里按键」（打字直接触发游戏快捷键、页面跳走）；这里把按键拦在组件内部。
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        on(queryEl, type, (event) => event.stopPropagation());
      });

      ctx.onDestroy(() => {
        alive = false;
        if (offAuth) {
          offAuth();
          offAuth = null;
        }
      });

      paintSort();
      paint();
      // 打开「工业」就先抓一轮：已拉过的国家命中 regionFeed 缓存，不会重复打接口
      load();
    }
  });

  /**
   * 税费：各国税负与最低工资的对照表。
   *
   * 数据来源：
   *  - 增值税 / 进口税 / 工资税 / 最低工资取自 /countries/summary 的 laws
   *    （个别环境 summary 不带 laws，这时才补一次 /countries，与「销售」共用同一份缓存）；
   *  - 「折金」用 fxFeed 的卖法币换黄金最优价，与「市场」的销售口径一致；
   *  - 领土检查复用 regionFeed（与「工业」、商品比价的领土检查共用 10 分钟缓存），
   *    已失去全部领土的流亡政府单独放到最底下。
   *
   * 只做展示与排序：不发交易请求、不写游戏数据。
   */
  registerBusinessPane({
    id: 'tax',
    title: '税费',
    order: 20,
    mount(pane, ctx) {
      /**
       * 可排序的列。默认「综合」= 增值税 + 进口税从低到高；同值时比最低工资税金（折金），
       * 再相同比进口税，最后按国名（这串同值规则方向固定，不随升降序反转）。
       */
      const SORTS = [
        { key: 'total', label: '综合', dir: 1 },
        { key: 'vat', label: '增值税', dir: 1 },
        { key: 'importTax', label: '进口税', dir: 1 },
        { key: 'workTax', label: '工资税', dir: 1 },
        { key: 'wage', label: '税前最低工资', dir: -1 },
        { key: 'taxGold', label: '最低工资税金', dir: 1 }
      ];

      // 顶部（搜索 / 排序 / 状态）固定，只有国家列表跟着滚
      pane.classList.add('eh-tax-pane');
      pane.innerHTML = `
        <div class="eh-section">
          <div class="eh-tax-head">
            <div class="eh-biz-search">
              <input class="eh-input" type="search" data-role="query" placeholder="搜索国家名（中 / 英）或法币" autocomplete="off" spellcheck="false" aria-label="搜索国家名或法币" />
            </div>
            <div class="eh-biz-sorts">
              <span class="eh-biz-sorts__cap">排序</span>
              <div class="eh-biz-chips" data-role="sorts"></div>
            </div>
            <div class="eh-biz-bar">
              <p class="eh-fx-status" data-role="status">…</p>
              <button class="eh-btn" type="button" data-role="refresh">刷新数据</button>
            </div>
          </div>
          <div class="eh-tax-scroll">
            <div class="eh-biz-list" data-role="list"></div>
            <p class="eh-empty" data-role="empty" hidden>还没有国家数据，点「刷新数据」抓取一次。</p>
            <div class="eh-gd-exile" data-role="exile" hidden>
              <div class="eh-gd-exile-head">
                <p class="eh-gd-exile-title">流亡政府 · 已失去全部领土</p>
                <p class="eh-gd-exile-note">这些国家已经没有地区，玩家无法抵达；税率与工资仅作对照。</p>
              </div>
              <div class="eh-biz-list" data-role="exile-list"></div>
            </div>
          </div>
        </div>
      `;

      const sortsEl = pane.querySelector('[data-role="sorts"]');
      const listEl = pane.querySelector('[data-role="list"]');
      const exileEl = pane.querySelector('[data-role="exile"]');
      const exileListEl = pane.querySelector('[data-role="exile-list"]');
      const emptyEl = pane.querySelector('[data-role="empty"]');
      const statusEl = pane.querySelector('[data-role="status"]');
      const refreshBtn = pane.querySelector('[data-role="refresh"]');
      const queryEl = pane.querySelector('[data-role="query"]');

      let alive = true;
      let loading = false;
      let ratesLoading = false;
      let error = null;
      let failures = 0;
      let limited = false;
      let progress = { done: 0, total: 0 };
      let updatedAt = 0;
      let rows = [];
      let query = '';
      /** 账号的国籍国 / 当前所在国（只存 id，来自 playerFeed，10 秒缓存，两个模块共用）。 */
      let myHomeId = null;
      let myHereId = null;

      // 排序方式记在功能自己的 storage 里（eclesiar-helper:business:tax:sort）
      const saved = ctx.storage.get('sort', null);
      let sortKey = 'total';
      let sortDir = 1;
      if (saved && typeof saved === 'object' && SORTS.some((item) => item.key === saved.key)) {
        sortKey = saved.key;
        sortDir = saved.dir === 1 ? 1 : -1;
      }

      const saveSort = () => ctx.storage.set('sort', { key: sortKey, dir: sortDir });

      /* ---------- 数值格式化 ---------- */

      /** 税率：整数不带小数，12.5% 这类留一位；缺数据用 —。 */
      const percentText = (value) => {
        if (!Number.isFinite(value)) return '—';
        return Number(value.toFixed(1)) + '%';
      };

      /** 最低工资是法币整数，3.5 这类也照实显示。 */
      const wageText = (value) => {
        if (!Number.isFinite(value)) return '—';
        return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
      };

      /** 折金：0 是有效值（0% 税、0 工资），不能被 fxGold 当成「没有数据」。 */
      const goldText = (value) => {
        if (!Number.isFinite(value)) return '—';
        return value === 0 ? '0' : fxGold(value);
      };

      /** 税率字段容错：正常是 10（=10%），个别实现会给 0.1 这种比例。 */
      const asPercent = (value) => {
        if (value == null || value === '') return null;
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) return null;
        if (num > 0 && num < 1) return num * 100;
        return num;
      };

      /** summary 里一条国家的 laws → 本页要的四项；缺的留 null，界面上显示 —。 */
      const readLaws = (country) => {
        const laws = country && country.laws;
        const pick = (...keys) => {
          if (!laws || typeof laws !== 'object') return null;
          for (let i = 0; i < keys.length; i += 1) {
            if (laws[keys[i]] != null) return laws[keys[i]];
          }
          return null;
        };
        const rawWage = pick('minimum_wage', 'minimumWage');
        const wage = rawWage == null || rawWage === '' ? null : Number(rawWage);
        return {
          vat: asPercent(pick('vat')),
          importTax: asPercent(pick('import_taxes', 'import_tax', 'importTax')),
          workTax: asPercent(pick('work_tax', 'workTax')),
          minWage: Number.isFinite(wage) && wage >= 0 ? wage : null
        };
      };

      /* ---------- 排序标签 ---------- */

      const chipEls = new Map();
      SORTS.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-biz-chip';
        const label = document.createElement('span');
        label.textContent = item.label;
        const arrow = document.createElement('span');
        arrow.className = 'eh-biz-chip__dir';
        btn.appendChild(label);
        btn.appendChild(arrow);
        on(btn, 'click', () => {
          if (sortKey === item.key) {
            sortDir = -sortDir;
          } else {
            sortKey = item.key;
            sortDir = item.dir > 0 ? 1 : -1;
          }
          saveSort();
          paintSort();
          renderList();
          ctx.ui.reposition();
        });
        sortsEl.appendChild(btn);
        chipEls.set(item.key, btn);
      });

      function paintSort() {
        chipEls.forEach((btn, key) => {
          const active = key === sortKey;
          btn.classList.toggle('is-active', active);
          const arrow = btn.querySelector('.eh-biz-chip__dir');
          if (arrow) arrow.textContent = active ? (sortDir > 0 ? '↑' : '↓') : '';
        });
      }

      /* ---------- 数据 ---------- */

      /** 接口的一条国家 → 列表的一行；没有法币（Gold / 世界实体 / 海盗）的直接跳过。 */
      function buildDataRow(country) {
        if (!country || country.id == null) return null;
        const currency = country.currency;
        const code = currency && currency.name != null ? String(currency.name) : '';
        if (!currency || currency.id == null || !code) return null;
        if (code.toLowerCase() === 'gold') return null;

        const laws = readLaws(country);
        const locale = fxLocale(code);
        return {
          id: country.id,
          name: String(country.name || code),
          zh: locale ? locale[0] : '',
          code,
          currencyId: currency.id,
          avatar: country.avatar,
          vat: laws.vat,
          importTax: laws.importTax,
          workTax: laws.workTax,
          minWage: laws.minWage,
          rate: null,
          wageGold: null,
          taxGold: null,
          exiled: false
        };
      }

      /** summary 没带 laws 时才去 /countries 补一份（与「销售」共用缓存，不会重复请求）。 */
      const needsLaws = () =>
        rows.some(
          (row) => row.vat == null || row.importTax == null || row.workTax == null || row.minWage == null
        );

      /** 用 /countries 那一份补上 summary 缺的字段；已经有的不覆盖。 */
      function mergeLaws() {
        rows.forEach((row) => {
          const tax = fxFeed.taxFor(row.id);
          if (tax) {
            if (row.vat == null && tax.vat != null) row.vat = tax.vat;
            if (row.importTax == null && tax.importTax != null) row.importTax = tax.importTax;
          }
          const laws = fxFeed.wageLawsFor(row.id);
          if (!laws) return;
          if (row.workTax == null && laws.workTax != null) row.workTax = laws.workTax;
          if (row.minWage == null && laws.minWage != null) row.minWage = laws.minWage;
        });
      }

      /** 卖法币换黄金的最优价（与「商品·销售」同口径）；只有买币挂单时退回买币价。 */
      const rateOf = (currencyId) => {
        if (currencyId == null) return null;
        const sell = fxFeed.sellRateFor(currencyId);
        if (sell) return sell;
        return fxFeed.rateFor(currencyId);
      };

      /** 汇率会随后台行情更新：把折金的两列重算一遍。 */
      function refreshRates() {
        rows.forEach((row) => {
          const rate = rateOf(row.currencyId);
          row.rate = rate && rate > 0 ? rate : null;
          row.wageGold = row.rate != null && row.minWage != null ? row.minWage * row.rate : null;
          row.taxGold =
            row.rate != null && row.minWage != null && row.workTax != null
              ? (row.workTax / 100) * row.minWage * row.rate
              : null;
        });
      }

      /** 默认口径的税负总和；两项都没读到才算缺数据。 */
      const totalOf = (row) =>
        row.vat == null && row.importTax == null ? null : (row.vat || 0) + (row.importTax || 0);

      const sortValue = (row, key) => {
        if (key === 'vat') return row.vat;
        if (key === 'importTax') return row.importTax;
        if (key === 'wage') return row.wageGold;
        if (key === 'workTax') return row.workTax;
        if (key === 'taxGold') return row.taxGold;
        return totalOf(row);
      };

      const byName = (a, b) => (a.zh || a.name).localeCompare(b.zh || b.name, 'zh-Hans');

      /**
       * 当前列 + 方向。缺数据（没读到税率 / 没有汇率）的行永远排最后，
       * 不因为升降序跑上来；同值时按综合口径（最低工资税金 → 进口税）、再按国名。
       */
      function comparator() {
        const key = sortKey;
        const dir = sortDir;
        return (a, b) => {
          const left = sortValue(a, key);
          const right = sortValue(b, key);
          const leftNull = left == null || !Number.isFinite(left);
          const rightNull = right == null || !Number.isFinite(right);
          if (leftNull !== rightNull) return leftNull ? 1 : -1;
          if (!leftNull && left !== right) return dir > 0 ? left - right : right - left;

          // 综合：总和相同时最低工资税金（折金）更低的在前；这条与下面的进口税、国名
          // 都是同值兜底，方向固定，不跟着升 / 降序翻转
          if (key === 'total') {
            const ag = a.taxGold == null ? Infinity : a.taxGold;
            const bg = b.taxGold == null ? Infinity : b.taxGold;
            if (ag !== bg) return ag - bg;
            const ai = a.importTax == null ? Infinity : a.importTax;
            const bi = b.importTax == null ? Infinity : b.importTax;
            if (ai !== bi) return ai - bi;
          } else {
            const at = totalOf(a);
            const bt = totalOf(b);
            if (at == null && bt != null) return 1;
            if (at != null && bt == null) return -1;
            if (at != null && bt != null && at !== bt) return at - bt;
          }
          return byName(a, b);
        };
      }

      /* ---------- 渲染 ---------- */

      /**
       * 一行。
       * @param {object} row    数据行
       * @param {object} opts   { index: 主列表里的名次, exile: 是否流亡栏 }
       */
      function buildRow(row, opts) {
        const options = opts || {};
        const el = document.createElement('div');
        el.className = 'eh-biz-row';
        if (options.exile) {
          el.classList.add('is-exile');
        } else if (sortKey === 'total' && sortDir === 1 && options.index === 0) {
          // 只有默认「综合」从低到高时第一名才有意义（其它列的第一名不代表「最优」）
          el.classList.add('is-best');
        }

        // 玩家国籍国 / 当前所在国只做就地高亮：不置顶、不干预排序，避免干扰全球对比
        const isHome = myHomeId != null && String(row.id) === myHomeId;
        const isHere = myHereId != null && String(row.id) === myHereId;
        if (isHome) el.classList.add('is-home');
        if (isHere) el.classList.add('is-here');

        const head = document.createElement('div');
        head.className = 'eh-biz-head';
        head.appendChild(buildFlagEl(row.code, row.avatar));

        const nameWrap = document.createElement('span');
        nameWrap.className = 'eh-biz-name';

        const nameEl = document.createElement('b');
        nameEl.textContent = row.zh || row.name;
        nameEl.title = row.zh && row.zh !== row.name ? row.zh + ' · ' + row.name : row.name;
        nameWrap.appendChild(nameEl);

        // 中文名后面补英文国名；没有中文对照时上面显示的就是英文，不重复
        if (row.zh && row.name) {
          const enEl = document.createElement('span');
          enEl.className = 'eh-biz-country';
          enEl.textContent = row.name;
          enEl.title = row.name;
          nameWrap.appendChild(enEl);
        }

        const curEl = document.createElement('span');
        curEl.className = 'eh-biz-cur';
        curEl.textContent = row.code;
        curEl.title = '当地法币：' + row.code;
        nameWrap.appendChild(curEl);

        head.appendChild(nameWrap);

        // 状态标签放在最右侧：国名再长也不会把「玩家国籍 / 当前位置」挤掉；
        // 两者是同一个国家时合成一个，同一行不说两遍
        if (isHome || isHere) {
          const markEl = document.createElement('span');
          markEl.className = 'eh-tax-mark';
          markEl.textContent = isHome && isHere ? '玩家国籍 · 当前位置' : isHome ? '玩家国籍' : '当前位置';
          markEl.title =
            isHome && isHere
              ? '你的国籍国，也是你当前所在的国家'
              : isHome
                ? '你的国籍国'
                : '你当前所在的国家';
          head.appendChild(markEl);
        }

        el.appendChild(head);

        const goldCell = (label, value, title) =>
          '<span class="eh-biz-cell" title="' +
          escapeHtml(title) +
          '"><em>' +
          label +
          '</em><b>' +
          (value == null ? '—' : goldIconHtml('eh-gold-ico--sm') + goldText(value)) +
          '</b></span>';

        const wageCell =
          '<span class="eh-biz-cell" title="' +
          escapeHtml(
            '税前最低工资按「卖币换金」最优价折算：' +
              (row.rate ? fxGold(row.rate) + ' 金 / 1 ' + row.code : '暂无汇率')
          ) +
          '"><em>税前最低工资</em><b>' +
          (row.minWage == null ? '—' : wageText(row.minWage) + ' ' + escapeHtml(row.code)) +
          '</b>' +
          (row.wageGold == null
            ? ''
            : '<span class="eh-biz-gold">≈ ' + goldIconHtml('eh-gold-ico--sm') + goldText(row.wageGold) + '</span>') +
          '</span>';

        // 第一行三种税，第二行税前最低工资与其对应的税金（强制换行，别让格子自然折行打乱分组）
        const meta = document.createElement('div');
        meta.className = 'eh-biz-meta';
        meta.innerHTML =
          '<span class="eh-biz-cell"><em>增值税</em><b>' +
          percentText(row.vat) +
          '</b></span>' +
          '<span class="eh-biz-cell"><em>进口税</em><b>' +
          percentText(row.importTax) +
          '</b></span>' +
          '<span class="eh-biz-cell"><em>工资税</em><b>' +
          percentText(row.workTax) +
          '</b></span>' +
          '<span class="eh-biz-break"></span>' +
          wageCell +
          goldCell('最低工资税金', row.taxGold, '工资税 × 税前最低工资，再按「卖币换金」最优价折算成黄金');
        meta.title =
          '增值税 ' +
          percentText(row.vat) +
          ' + 进口税 ' +
          percentText(row.importTax) +
          ' = ' +
          percentText(totalOf(row)) +
          '\n税前最低工资 ' +
          (row.minWage == null ? '—' : wageText(row.minWage) + ' ' + row.code) +
          ' ≈ ' +
          (row.wageGold == null ? '暂无汇率' : goldText(row.wageGold) + ' 金') +
          ' · 工资税 ' +
          percentText(row.workTax) +
          ' ⇒ 最低工资税金 ≈ ' +
          (row.taxGold == null ? '—' : goldText(row.taxGold) + ' 金');
        el.appendChild(meta);
        return el;
      }

      /** 搜索匹配：中文名、英文名（不分大小写）、法币代码三路任一命中。 */
      const matchesQuery = (row, keyword) => {
        if (!keyword) return true;
        if (row.name.toLowerCase().indexOf(keyword) !== -1) return true;
        if (row.zh && row.zh.toLowerCase().indexOf(keyword) !== -1) return true;
        if (row.code.toLowerCase().indexOf(keyword) !== -1) return true;
        return false;
      };

      function renderList() {
        if (!alive) return;
        const keyword = query.trim().toLowerCase();
        const matched = rows.filter((row) => matchesQuery(row, keyword));

        const reachable = [];
        const exiled = [];
        matched.forEach((row) => (row.exiled ? exiled : reachable).push(row));
        reachable.sort(comparator());
        exiled.sort(comparator());

        listEl.textContent = '';
        reachable.forEach((row, index) => listEl.appendChild(buildRow(row, { index })));
        exileListEl.textContent = '';
        exiled.forEach((row) => exileListEl.appendChild(buildRow(row, { exile: true })));
        exileEl.hidden = exiled.length === 0;

        // 凭据还没到手时状态栏已经说明原因，别在下面再写一句「点刷新抓取」
        const blocked =
          (error && (error.code === 'NO_TOKEN' || error.code === 'UNAUTHORIZED')) ||
          (apiClient.state !== 'ok' && !updatedAt);
        const none = reachable.length === 0 && exiled.length === 0;
        emptyEl.hidden = Boolean(loading) || Boolean(blocked) || !none;
        if (!none) return;
        emptyEl.textContent = keyword
          ? '没有匹配「' + query.trim() + '」的国家。'
          : updatedAt
            ? '这次没有读到任何国家数据，稍后可以点「刷新数据」再试。'
            : '还没有国家数据，点「刷新数据」抓取一次。';
      }

      /** 共用提示里写的是「刷新行情」，这页的按钮叫「刷新数据」，换一下别让玩家找不到。 */
      const tokenHint = () => authHint().replace('刷新行情', '刷新数据');

      function paintStatus() {
        if (!alive) return;
        refreshBtn.disabled = loading;

        if (loading) {
          if (!progress.total) {
            statusEl.textContent = '正在读取国家清单…';
            return;
          }
          // 汇率和领土是串着跑的：汇率还没拉完时先报汇率，别让人以为卡住了
          if (ratesLoading && progress.done === 0) {
            statusEl.textContent = '正在拉取全球汇率（与「汇率」页共用）…';
            return;
          }
          statusEl.textContent = '正在读取 ' + progress.done + '/' + progress.total + ' 个国家的领土…';
          return;
        }

        if (apiClient.state !== 'ok' && !updatedAt) {
          statusEl.textContent = tokenHint();
          statusEl.dataset.tone = 'warn';
          return;
        }

        if (error) {
          const code = error.code;
          if (code === 'NO_TOKEN' || code === 'UNAUTHORIZED') {
            statusEl.textContent = tokenHint();
            statusEl.dataset.tone = code === 'UNAUTHORIZED' ? 'error' : 'warn';
          } else if (code === 'TIMEOUT') {
            statusEl.textContent = '请求超时，请稍后重试。';
            statusEl.dataset.tone = 'error';
          } else if (quotaHint(error) || error.limited) {
            statusEl.textContent =
              quotaHint(error) || '接口返回 429（请求过多或已达当日查询上限），请稍后再试。';
            statusEl.dataset.tone = 'error';
          } else {
            statusEl.textContent = '读取失败：' + fetchErrorText(error);
            statusEl.dataset.tone = 'error';
          }
          return;
        }

        delete statusEl.dataset.tone;
        if (!updatedAt) {
          statusEl.textContent = '还没有国家数据，点「刷新数据」抓取一次。';
          return;
        }
        const exiledCount = rows.filter((row) => row.exiled).length;
        const rateNote = fxFeed.updatedAt ? ' · 汇率 ' + formatClock(fxFeed.updatedAt) : ' · 汇率未加载';
        let suffix = failures ? ' · ' + failures + ' 个国家领土读取失败' : '';
        // 个别国家被 429 拦下时整轮还是能出结果的，单独提醒一句额度
        if (limited) suffix += '（含 429，可到「设置」页生成专用密钥）';
        statusEl.textContent =
          rows.length +
          ' 个国家' +
          (exiledCount ? '（含 ' + exiledCount + ' 个流亡政府）' : '') +
          '\n更新于 ' +
          formatClock(updatedAt) +
          rateNote +
          suffix;
      }

      const paint = () => {
        paintStatus();
        renderList();
      };

      /* ---------- 抓取 ---------- */

      let offAuth = null;
      /** 凭据晚到（面板先开、游戏还没发过请求）时补一轮，不用玩家手动刷新。 */
      const armAuthRetry = () => {
        if (offAuth) return;
        offAuth = apiClient.onAuth(() => {
          offAuth = null;
          if (!loading && !updatedAt) load();
        });
      };

      /** 把账号字段落到本地并重绘：值没变就什么都不做（通知可能来自别的页面）。 */
      function applyPlayer(info) {
        if (!alive) return;
        const home = info && info.nationalityId ? String(info.nationalityId) : null;
        const here = info && info.countryId ? String(info.countryId) : null;
        if (home === myHomeId && here === myHereId) return;
        myHomeId = home;
        myHereId = here;
        paint();
      }

      /**
       * 读一次账号的国籍国 / 当前所在国（只存 id，不存原始字段）。
       * 走 playerFeed 的 10 秒缓存，与「汇率」的置顶、「市场」的本国判断共用同一次请求；
       * 之后的更新由 playerFeed.watch 推过来，不再各自挑时机。
       */
      async function readPlayer() {
        let info = null;
        try {
          info = await playerFeed.ensure();
        } catch (err) {
          info = playerFeed.info || null;
          ctx.log('账号读取失败（国籍 / 当前位置无法置顶）', (err && err.code) || (err && err.message) || err);
        }
        applyPlayer(info);
      }

      /** 命中缓存的一轮：regionFeed.ensure（10 分钟内不重复请求）。 */
      const pullCached = (countryId) => regionFeed.ensure(countryId);
      /** 绕过 TTL 的一轮：regionFeed.refresh，失败保留上一轮结果。 */
      const pullFresh = (countryId) => regionFeed.refresh(countryId);

      /**
       * 领土（流亡政府判断）：逐个国家查 regionFeed，pull 决定命中缓存还是绕过 TTL。
       * 缓存里已有时直接跳过（不计等待），所以先打开「工业」再切过来几乎立刻出结果。
       */
      async function loadLand(pull) {
        let cursor = 0;
        const worker = async () => {
          while (cursor < rows.length) {
            if (!alive) return;
            const row = rows[cursor];
            cursor += 1;

            const cached = pull === pullCached ? regionFeed.get(row.id) : null;
            if (cached) {
              row.exiled = cached.length === 0;
              progress = { done: progress.done + 1, total: progress.total };
              if (alive) paintStatus();
              continue;
            }

            try {
              const list = await pull(row.id);
              row.exiled = list.length === 0;
            } catch (err) {
              if (err && err.code === 'UNAUTHORIZED') throw err;
              if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
              failures += 1;
              ctx.log('领土读取失败', row.name + ' · ' + ((err && err.code) || 'ERROR'));
            }
            progress = { done: progress.done + 1, total: progress.total };
            if (alive) paintStatus();
            await fxSleep(FX_GAP);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(FX_CONCURRENCY, rows.length) }, () => worker())
        );
      }

      /**
       * 拉一遍税费表。汇率与领土各自走共享缓存：
       * 领土由 pull 决定命中 regionFeed 的 10 分钟缓存还是绕过 TTL，
       * 行情命中 fxFeed 的 10 分钟缓存，重新打开面板不会把上百个请求再打一遍。
       * countriesMode / taxes 的刷新口径同理：点「刷新数据」时连页面级条目一起绕过。
       */
      function run(pull, countriesMode) {
        if (!alive || loading) return;
        if (apiClient.state !== 'ok') {
          error = { code: apiClient.state === 'expired' ? 'UNAUTHORIZED' : 'NO_TOKEN' };
          paint();
          armAuthRetry();
          return;
        }

        loading = true;
        error = null;
        failures = 0;
        limited = false;
        ratesLoading = false;
        progress = { done: 0, total: 0 };
        paint();

        (async () => {
          try {
            const countries = await fxFeed.loadCountries(countriesMode);
            if (!alive) return;

            const next = (Array.isArray(countries) ? countries : []).map(buildDataRow).filter(Boolean);
            if (!next.length) {
              const empty = new Error('没有可用的国家清单');
              empty.code = 'EMPTY_COUNTRIES';
              throw empty;
            }

            rows = next;
            refreshRates();
            progress = { done: 0, total: rows.length };
            paintStatus();

            // 汇率：共用行情缓存，过期才重拉（和「汇率」页共用同一轮）
            ratesLoading = true;
            const rateJob = fxFeed
              .ensure()
              .catch((err) => {
                ctx.log('汇率读取失败', (err && err.message) || err);
              })
              .then(() => {
                ratesLoading = false;
                if (!alive) return;
                refreshRates();
                paintStatus();
              });

            // summary 没带 laws：补一次 /countries（和「销售」共用缓存）
            const lawsJob = needsLaws()
              ? (countriesMode === 'refresh' ? fxFeed.refreshTaxes() : fxFeed.ensureTaxes())
                  .catch((err) => {
                    ctx.log('税率读取失败', (err && err.message) || err);
                  })
                  .then(() => {
                    if (!alive) return;
                    mergeLaws();
                    refreshRates();
                  })
              : Promise.resolve();

            // 账号（国籍 / 当前位置）只认登录凭据，单独一次 POST /account/getuser（10 秒缓存）
            const playerJob = readPlayer();

            // 汇率与领土串着跑：两边都冷时各有一串请求，同时开会把并发推到 6，容易被 429
            await Promise.all([lawsJob, rateJob, playerJob]);
            if (!alive) return;
            await loadLand(pull);
            if (!alive) return;
            // 「更新于」= 这屏里最旧的一份地区数据（命中缓存时不要谎报成「刚刚」）
            const stamps = rows.map((row) => regionFeed.atOf(row.id)).filter(Boolean);
            updatedAt = stamps.length ? Math.min.apply(null, stamps) : Date.now();
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            error = {
              code: (err && err.code) || 'ERROR',
              message: err && err.message,
              limited
            };
            // 凭据过期后玩家重新登录（游戏发出新凭据）时自动补一轮
            if (error.code === 'UNAUTHORIZED' || error.code === 'NO_TOKEN') armAuthRetry();
          } finally {
            loading = false;
            ratesLoading = false;
            if (alive) {
              refreshRates();
              paint();
              // 面板内容高度变了，重新测一次，别沿用旧的
              ctx.ui.reposition();
            }
          }
        })();
      }

      /** 打开面板 / 凭据晚到：领土走缓存，行情走各行自己的有效期。 */
      const load = () => run(pullCached, 'ensure');
      /** 「刷新数据」：领土与国家清单绕过 TTL 重抓，行情仍按有效期（与「市场」「汇率」共用）。 */
      const refresh = () => run(pullFresh, 'refresh');

      on(refreshBtn, 'click', () => refresh());

      on(queryEl, 'input', () => {
        query = queryEl.value || '';
        renderList();
        ctx.ui.reposition();
      });

      // 面板在 Shadow DOM 内，游戏若在 document / window 上监听按键，拿到的 target 会被重定向成宿主元素，
      // 很容易被当成「在页面里按键」（打字直接触发游戏快捷键、页面跳走）；这里把按键拦在组件内部。
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        on(queryEl, type, (event) => event.stopPropagation());
      });

      // 行情在别的标签页刷新完了：折金的两列跟着更新（不重复渲染正在抓取的列表）
      const offFx = fxFeed.subscribe((kind) => {
        if (kind !== 'done' || !alive || !rows.length) return;
        refreshRates();
        if (loading) return;
        renderList();
        paintStatus();
        ctx.ui.reposition();
      });

      // 国籍 / 位置变了就重画高亮：别的页面读到新值时不等着本页再刷新一次
      const offPlayer = playerFeed.watch(applyPlayer);

      // 每次显示本标签：只补读账号（10 秒过期才真请求）；
      // 领土是 10 分钟级数据，切标签重跑整轮没有意义，交给「刷新数据」
      ctx.onShow(() => {
        readPlayer();
      });

      ctx.onDestroy(() => {
        alive = false;
        offFx();
        offPlayer();
        if (offAuth) {
          offAuth();
          offAuth = null;
        }
      });

      paintSort();
      paint();
      // 打开「税费」就先抓一轮：汇率与领土都命中共享缓存时几乎不花请求
      load();
    }
  });

  /**
   * 工作：按国家读 GET /market/jobs/get（分页在响应根上），列出当前招工岗位。
   * 排序固定为税后薪资金价从高到低；只做展示与跳转，不替玩家申请。
   */
  registerBusinessPane({
    id: 'jobs',
    title: '工作',
    order: 30,
    mount(pane, ctx) {
      /** 每个国家最多十个分页；全国家一轮的总请求硬上限，避免把查询额度打光。 */
      const MAX_PAGES = 10;
      const MAX_REQUESTS = 300;
      /** 符合条件时最多展示这么多条，更多只统计不渲染。 */
      const DISPLAY_LIMIT = 50;
      /** 公司类型：接口给英文，这里按游戏里的中文名对照；未知类型照原样显示。 */
      const JOB_TYPE_ZH = {
        'Aerial Weapon Factory': '空战武器工厂',
        'Airlines Company': '航空公司',
        Farm: '农场',
        'Food Factory': '食品工厂',
        'Iron Mine': '铁矿',
        'Oil Well': '油井',
        'Titanium Mine': '钛矿',
        'Weapons Factory': '武器工厂'
      };
      /** 岗位按「国家 + 页」缓存 2 分钟（apiCache），门槛只决定读到第几页。 */
      const JOB_PATH = '/market/jobs/get';

      pane.classList.add('eh-pane--stick');
      pane.innerHTML = `
        <div class="eh-stick-head">
          <div class="eh-biz-search">
            <input class="eh-input" type="search" data-role="query" placeholder="搜索类型 / 公司 / 国家 / 法币 / 所有者" autocomplete="off" spellcheck="false" aria-label="搜索岗位" />
          </div>
          <div class="eh-job-tools">
            <label class="eh-job-min-wrap" title="最低税后工资（折合黄金），留空不限">
              <span class="eh-job-min-addon">${goldIconHtml('eh-gold-ico--sm')} ≥</span>
              <input class="eh-input eh-job-min" type="number" step="any" min="0" data-role="min-gold" placeholder="最低税后工资" aria-label="最低税后工资（折合黄金）" />
            </label>
            <label class="eh-gd-switch eh-job-filter"><input type="checkbox" data-role="skill-only" /> 仅看符合技能要求</label>
          </div>
          <div class="eh-biz-bar">
            <p class="eh-fx-status" data-role="status">…</p>
            <button class="eh-btn" type="button" data-role="refresh">刷新岗位</button>
          </div>
        </div>
        <div class="eh-stick-scroll">
          <div class="eh-biz-list" data-role="list"></div>
          <p class="eh-empty" data-role="empty" hidden>暂时没有岗位，点「刷新岗位」再试。</p>
        </div>
      `;

      const queryEl = pane.querySelector('[data-role="query"]');
      const minGoldEl = pane.querySelector('[data-role="min-gold"]');
      const skillEl = pane.querySelector('[data-role="skill-only"]');
      const refreshBtn = pane.querySelector('[data-role="refresh"]');
      const statusEl = pane.querySelector('[data-role="status"]');
      const listEl = pane.querySelector('[data-role="list"]');
      const emptyEl = pane.querySelector('[data-role="empty"]');

      let alive = true;
      let loading = false;
      let ratesLoading = false;
      let error = null;
      let rows = [];
      let myHereId = null;
      let myHomeId = null;
      let mySkill = null;
      let query = '';
      // 默认勾选「仅看符合技能要求」；玩家主动取消后记住取消状态
      let skillOnly = ctx.storage.get('skillOnly', true) !== false;
      let minGold = null;
      let updatedAt = 0;
      let capped = false;
      let progress = { done: 0, total: 0, count: 0 };

      const tokenHint = () => authHint().replace('刷新行情', '刷新岗位');

      /** 留空 / 非法 / 负数都当作「不限」，避免拿坏值把列表全过滤掉。 */
      function readMinGold() {
        const raw = String(minGoldEl.value == null ? '' : minGoldEl.value).trim();
        const num = Number(raw);
        minGold = raw !== '' && Number.isFinite(num) && num >= 0 ? num : null;
      }

      /** 一行原始数据 → 展示用结构；缺关键数值的行直接丢掉，不显示半截岗位。 */
      function buildRow(raw) {
        const company = raw && raw.company && typeof raw.company === 'object' ? raw.company : {};
        const currency = raw && raw.currency && typeof raw.currency === 'object' ? raw.currency : {};
        const employer = raw && raw.employer && typeof raw.employer === 'object' ? raw.employer : {};
        const country = raw && raw.country && typeof raw.country === 'object' ? raw.country : {};
        const region = raw && raw.region && typeof raw.region === 'object' ? raw.region : {};
        const net = Number(raw && (raw.net_value != null ? raw.net_value : raw.value));
        const skill = Number(raw && raw.economic_skill);
        const businessId = raw && raw.business_id != null ? raw.business_id : company.id;
        if (!Number.isFinite(net) || businessId == null) return null;
        return {
          id: raw && raw.id,
          net,
          gross: Number(raw && raw.value),
          tax: Number(raw && raw.tax_percent),
          amount: Number(raw && raw.amount) || 0,
          skill: Number.isFinite(skill) ? skill : 0,
          currencyId: raw && raw.currency_id != null ? raw.currency_id : currency.id,
          code: String(currency.name || ''),
          company: String(company.name || '未命名公司'),
          type: String(company.type || ''),
          avatar: company.avatar,
          countryId: country.id,
          country: String(country.name || ''),
          flag: country.flag,
          region: String(region.name || ''),
          owner: String(employer.name || ''),
          ownerAvatar: employer.avatar,
          businessId,
          gold: null,
          fallback: false
        };
      }

      /** 折金口径与「税费」一致：卖法币换黄金优先，缺买单才退回最优卖单价。 */
      function applyRate(row) {
        const sell = fxFeed.sellRateFor(row.currencyId);
        const rate = sell != null ? sell : fxFeed.rateFor(row.currencyId);
        row.fallback = sell == null && rate != null;
        row.gold = rate != null ? row.net * rate : null;
        return row.gold;
      }

      /** 一页岗位里的最低折金薪资；只要有读不到汇率的就不判断，免得误停。 */
      function pageMinGold(pageData) {
        let min = Infinity;
        let unknown = false;
        (Array.isArray(pageData) ? pageData : []).forEach((raw) => {
          const row = buildRow(raw);
          if (!row) return;
          const gold = applyRate(row);
          if (gold == null) {
            unknown = true;
          } else if (gold < min) {
            min = gold;
          }
        });
        return { min, unknown };
      }

      function refreshRates() {
        rows.forEach(applyRate);
        // 固定口径：金价降序；没汇率的永远沉底，同价再比法币净薪与公司名
        rows.sort((a, b) => {
          if ((a.gold == null) !== (b.gold == null)) return a.gold == null ? 1 : -1;
          if (a.gold != null && a.gold !== b.gold) return b.gold - a.gold;
          if (a.net !== b.net) return b.net - a.net;
          return a.company.localeCompare(b.company, 'zh-Hans');
        });
      }

      function matches(row) {
        if (skillOnly && mySkill != null && row.skill > mySkill) return false;
        // 设了门槛时，折金读不到岗位的不能算「满足」，先滤掉
        if (minGold != null && (row.gold == null || row.gold < minGold)) return false;
        if (!query) return true;
        const haystack = [
          JOB_TYPE_ZH[row.type] || row.type,
          row.type,
          row.company,
          row.country,
          row.code,
          String(row.currencyId),
          row.owner
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      }

      function buildJobRow(row) {
        const el = document.createElement('div');
        el.className = 'eh-biz-row eh-job-row';
        // 当前位置只就地高亮：不置顶、不参与排序
        const isHere = myHereId != null && String(row.countryId) === myHereId;
        if (isHere) el.classList.add('is-here');

        const main = document.createElement('div');
        main.className = 'eh-job-main';

        // 标题区：公司图标跨两行，第一行公司名，第二行国家（中英空格分隔）+ 地区
        const title = document.createElement('div');
        title.className = 'eh-job-title';
        let avatarEl;
        const src = fxAvatarUrl(row.avatar);
        if (src) {
          avatarEl = document.createElement('img');
          avatarEl.className = 'eh-job-avatar';
          avatarEl.alt = '';
          avatarEl.decoding = 'async';
          avatarEl.loading = 'lazy';
          avatarEl.addEventListener(
            'error',
            () => {
              const glyph = document.createElement('span');
              glyph.className = 'eh-job-avatar';
              glyph.textContent = row.company.slice(0, 1);
              avatarEl.replaceWith(glyph);
            },
            { once: true }
          );
          avatarEl.src = src;
        } else {
          avatarEl = document.createElement('span');
          avatarEl.className = 'eh-job-avatar';
          avatarEl.textContent = row.company.slice(0, 1);
        }
        title.appendChild(avatarEl);

        // 主标题：公司名
        const headline = document.createElement('div');
        headline.className = 'eh-job-headline';
        const nameEl = document.createElement('b');
        nameEl.className = 'eh-job-name';
        nameEl.textContent = row.company;
        nameEl.title = row.company;
        headline.appendChild(nameEl);
        title.appendChild(headline);

        // 副标题：产业类型（中文，仅此项高亮）· 职位数 · 技能要求
        const subtitle = document.createElement('div');
        subtitle.className = 'eh-job-subtitle';
        const appendSub = (node) => {
          if (subtitle.childNodes.length) {
            const dot = document.createElement('span');
            dot.className = 'eh-job-dot';
            dot.textContent = '·';
            subtitle.appendChild(dot);
          }
          subtitle.appendChild(node);
        };
        if (row.type) {
          const typeEl = document.createElement('span');
          typeEl.className = 'eh-job-type';
          typeEl.textContent = JOB_TYPE_ZH[row.type] || row.type;
          typeEl.title = row.type;
          appendSub(typeEl);
        }
        const amountEl = document.createElement('span');
        amountEl.textContent = row.amount + ' 个职位';
        appendSub(amountEl);
        const skillEl = document.createElement('span');
        skillEl.textContent = '技能 ≥ ' + row.skill;
        skillEl.title = '最低技能要求';
        appendSub(skillEl);
        if (isHere) {
          const markEl = document.createElement('span');
          markEl.className = 'eh-tax-mark';
          markEl.textContent = '当前位置';
          appendSub(markEl);
        }
        title.appendChild(subtitle);
        main.appendChild(title);

        // 左半边第一行：前置小人图标 + 雇主头像（加载失败退回首字）+ 名字
        const ownerLine = document.createElement('div');
        ownerLine.className = 'eh-job-line';
        const ownerEl = document.createElement('span');
        ownerEl.className = 'eh-job-owner';
        ownerEl.title = '雇主：' + (row.owner || '—');
        const markEl = document.createElement('span');
        markEl.className = 'eh-job-owner-mark';
        markEl.innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<circle cx="8" cy="5.4" r="2.6" fill="currentColor"/>' +
          '<path d="M2.6 14c0-2.9 2.4-4.8 5.4-4.8s5.4 1.9 5.4 4.8" fill="currentColor"/>' +
          '</svg>';
        ownerEl.appendChild(markEl);
        const ownerSrc = fxAvatarUrl(row.ownerAvatar);
        let ownerAvatarEl;
        if (ownerSrc) {
          ownerAvatarEl = document.createElement('img');
          ownerAvatarEl.className = 'eh-job-owner-avatar';
          ownerAvatarEl.alt = '';
          ownerAvatarEl.decoding = 'async';
          ownerAvatarEl.loading = 'lazy';
          ownerAvatarEl.addEventListener(
            'error',
            () => {
              const glyph = document.createElement('span');
              glyph.className = 'eh-job-owner-fallback';
              glyph.textContent = (row.owner || '?').slice(0, 1);
              ownerAvatarEl.replaceWith(glyph);
            },
            { once: true }
          );
          ownerAvatarEl.src = ownerSrc;
        } else {
          ownerAvatarEl = document.createElement('span');
          ownerAvatarEl.className = 'eh-job-owner-fallback';
          ownerAvatarEl.textContent = (row.owner || '?').slice(0, 1);
        }
        ownerEl.appendChild(ownerAvatarEl);
        const ownerText = document.createElement('span');
        ownerText.textContent = row.owner || '—';
        ownerEl.appendChild(ownerText);
        ownerLine.appendChild(ownerEl);
        main.appendChild(ownerLine);

        // 最后一行：地图标记 + 小国旗 + 国家（中英空格分隔）+ 地区
        const loc = document.createElement('div');
        loc.className = 'eh-job-loc';
        const pinEl = document.createElement('span');
        pinEl.className = 'eh-job-pin';
        pinEl.innerHTML =
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M8 1.6c-2.6 0-4.7 2.1-4.7 4.7 0 3.5 4.7 8.1 4.7 8.1s4.7-4.6 4.7-8.1c0-2.6-2.1-4.7-4.7-4.7Z" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
          '<circle cx="8" cy="6.3" r="1.7" fill="currentColor"/>' +
          '</svg>';
        loc.appendChild(pinEl);
        const flagEl = buildFlagEl(row.code, row.flag);
        flagEl.classList.add('eh-job-flag');
        loc.appendChild(flagEl);
        const locale = fxLocale(row.code);
        const zh = locale && locale[0] ? locale[0] : '';
        const countryText = zh && zh !== row.country ? zh + ' ' + row.country : row.country;
        const locText = document.createElement('span');
        locText.className = 'eh-job-loc-text';
        locText.textContent = [countryText, row.region].filter(Boolean).join(' · ');
        locText.title = locText.textContent;
        loc.appendChild(locText);
        main.appendChild(loc);

        // 右列：税后法币 → 折算金币 → 申请跳转
        const side = document.createElement('div');
        side.className = 'eh-job-side';
        const pay = document.createElement('div');
        pay.className = 'eh-job-pay';
        const payEl = document.createElement('b');
        payEl.textContent = '税后 ' + fxPrice(row.net) + (row.code ? ' ' + row.code : '');
        payEl.title =
          (Number.isFinite(row.gross) ? '税前 ' + fxPrice(row.gross) + (row.code ? ' ' + row.code : '') : '税后薪资') +
          (Number.isFinite(row.tax) ? ' · 工资税 ' + row.tax + '%' : '');
        const goldEl = document.createElement('span');
        if (row.gold != null) {
          goldEl.appendChild(document.createTextNode('≈ '));
          goldEl.appendChild(buildGoldIconEl('eh-gold-ico--sm'));
          goldEl.appendChild(document.createTextNode(fxGold(row.gold)));
          goldEl.title = row.fallback ? '买盘不足，按最优卖单价估算' : '按卖法币的最优买单折算';
        } else {
          goldEl.textContent = '汇率缺失';
          goldEl.dataset.tone = 'muted';
          goldEl.title = '还没有该法币的行情';
        }
        pay.appendChild(payEl);
        pay.appendChild(goldEl);
        side.appendChild(pay);
        side.appendChild(
          buildGoButton('前往「' + row.company + '」的申请页面', '/business/' + row.businessId)
        );

        el.appendChild(main);
        el.appendChild(side);
        return el;
      }

      function renderList() {
        const visible = rows.filter(matches);
        listEl.replaceChildren();
        visible.slice(0, DISPLAY_LIMIT).forEach((row) => listEl.appendChild(buildJobRow(row)));
        emptyEl.textContent =
          rows.length && (minGold != null || skillOnly || query)
            ? '没有符合条件的岗位，换个筛选条件试试。'
            : '暂时没有岗位，点「刷新岗位」再试。';
        emptyEl.hidden = visible.length > 0;
      }

      function paintStatus() {
        // 抓取期间禁用：一轮上百次请求，重复点击既不会重抓也容易撞 429
        refreshBtn.disabled = loading;

        if (error) {
          const code = error && error.code;
          if (code === 'NO_TOKEN' || code === 'UNAUTHORIZED') {
            statusEl.textContent = tokenHint();
            statusEl.dataset.tone = code === 'UNAUTHORIZED' ? 'error' : 'warn';
          } else if (code === 'TIMEOUT') {
            statusEl.textContent = '请求超时，请稍后重试。';
            statusEl.dataset.tone = 'error';
          } else if (quotaHint(error) || error.limited) {
            statusEl.textContent = quotaHint(error) || '接口返回 429（请求过多或已达当日查询上限），请稍后再试。';
            statusEl.dataset.tone = 'error';
          } else {
            statusEl.textContent = '读取失败：' + fetchErrorText(error);
            statusEl.dataset.tone = 'error';
          }
          return;
        }
        delete statusEl.dataset.tone;
        if (loading) {
          statusEl.textContent =
            '正在抓取岗位…\n已读 ' +
            progress.done +
            '/' +
            progress.total +
            ' 个国家 · ' +
            progress.count +
            ' 条';
          if (capped) statusEl.textContent += '\n已达请求上限';
          return;
        }
        if (!updatedAt) {
          statusEl.textContent = '…';
          return;
        }
        const count = rows.filter(matches).length;
        let text = '符合条件 ' + count + ' 条';
        if (count > DISPLAY_LIMIT) text += ' · 仅显示前 ' + DISPLAY_LIMIT + ' 条';
        if (capped) text += ' · 已达请求上限，结果可能不完整';
        if (ratesLoading) text += ' · 汇率加载中';
        if (minGold != null && rows.length && !rows.some((row) => row.gold != null)) {
          text += '\n汇率缺失，暂时无法按金价筛选';
        }
        if (skillOnly && mySkill == null) text += '\n技能未读到，暂未过滤';
        statusEl.textContent = text + '\n更新于 ' + formatClock(updatedAt);
      }

      const paint = () => {
        renderList();
        paintStatus();
      };

      let offAuth = null;
      /** 凭据晚到（面板先开、游戏还没发过请求）时补一轮，不用玩家手动刷新。 */
      const armAuthRetry = () => {
        if (offAuth) return;
        offAuth = apiClient.onAuth(() => {
          offAuth = null;
          if (!loading && !updatedAt) load();
        });
      };

      /** 账号字段落到本地：值没变就返回 false（通知可能来自别的页面，别白重绘）。 */
      function applyFields(info) {
        const home = info && info.nationalityId ? String(info.nationalityId) : null;
        const here = info && info.countryId ? String(info.countryId) : null;
        if (home === myHomeId && here === myHereId) return false;
        myHomeId = home;
        myHereId = here;
        return true;
      }

      /** 账号字段只认登录凭据，走 playerFeed 的 10 秒缓存；读不到时技能过滤与高亮自动降级。 */
      async function readPlayer() {
        let info = null;
        try {
          info = await playerFeed.ensure();
        } catch (err) {
          info = playerFeed.info || null;
          ctx.log('账号读取失败（技能过滤 / 位置高亮不可用）', (err && err.code) || (err && err.message) || err);
        }
        if (!alive) return;
        applyFields(info);
        // getuser 没有技能等级：按账号 id 再读一次公开资料，只取 economic_level
        const accountId = info && info.accountId ? info.accountId : 0;
        if (accountId) {
          try {
            mySkill = await profileFeed.ensure(accountId);
          } catch (err) {
            mySkill = profileFeed.economicLevel;
            ctx.log('经济技能读取失败（公开资料接口）', (err && err.code) || (err && err.message) || err);
          }
        } else {
          mySkill = null;
        }
        if (!alive) return;
        if (skillOnly && mySkill == null) {
          ctx.log('公开资料里没有 economic_level，技能过滤暂不生效');
        }
      }

      /**
       * 遍历全部国家抓岗位，回来后在列表里统一按税后金价排序。
       * 分页在响应根上，所以要给 call 传 full；无岗位的国家可能不带 data，allowEmpty 放行，
       * total_records 为 0 同样当作空结果；单国失败只跳过那一国，已有岗位照常展示。
       * 接口按薪资从高到低返回：设了门槛时逐页读，某页最低已低于门槛即停。
       * 缓存按「国家 + 页」走 apiCache（2 分钟）：门槛只决定读到第几页，
       * 换门槛复用已读页、不整轮重抓；「刷新岗位」用 refresh 绕过 TTL，旧值不会被删。
       * 全局请求有硬上限（只数真正要发的请求，命中缓存的页不计入）。
       */
      async function fetchJobs(force, threshold, targets) {
        const data = [];
        let requests = 0;
        let stopped = false;
        let capped = false;
        let cursor = 0;
        // 没有岗位的国家可能整个不带 data，allowEmpty 放行；total_records 为 0 也直接当作空结果
        const callOpts = { object: true, full: true, noMethodRetry: true, allowEmpty: true };
        // 空岗位页也是有效结果（empty 标记），2 分钟内不再问同一个国家
        const pageOpts = {
          ttl: 'jobPage',
          namespace: 'jobs',
          empty: (payload) => !(payload && Array.isArray(payload.data) && payload.data.length)
        };

        /** 读一页：force=true 绕过 TTL，其余命中 2 分钟缓存。 */
        const readPage = (countryId, page) => {
          const key = apiCache.key(JOB_PATH, { country_id: String(countryId), page: page });
          const loader = () =>
            apiClient.call(
              JOB_PATH + '?country_id=' + encodeURIComponent(countryId) + '&page=' + page,
              callOpts
            );
          return force ? apiCache.refresh(key, loader, pageOpts) : apiCache.ensure(key, loader, pageOpts);
        };

        const worker = async () => {
          while (cursor < targets.length) {
            if (!alive || capped) return;
            const countryId = targets[cursor];
            cursor += 1;
            let page = 1;
            let wanted = 1;
            try {
              while (page <= wanted) {
                if (!alive || capped) return;
                const pageKey = apiCache.key(JOB_PATH, { country_id: String(countryId), page: page });
                // 只有真会发请求的页才计入硬上限：命中「未过期」缓存的页不算，
                // 过期条目照样会重新请求，必须用 fresh 而不是 peek
                if (force || !apiCache.fresh(pageKey)) {
                  if (requests >= MAX_REQUESTS) {
                    capped = true;
                    return;
                  }
                  requests += 1;
                }
                const entry = await readPage(countryId, page);
                const payload = entry && entry.value ? entry.value : null;
                const pg =
                  payload && payload.pagination && typeof payload.pagination === 'object'
                    ? payload.pagination
                    : {};
                if (page === 1) {
                  if (pg.total_records != null && Number(pg.total_records) === 0) break;
                  wanted = Math.min(MAX_PAGES, Math.max(1, Number(pg.total_pages) || 1));
                }
                const pageData = Array.isArray(payload && payload.data) ? payload.data : [];
                if (!pageData.length) break;
                data.push(...pageData);
                if (threshold != null) {
                  const pageMin = pageMinGold(pageData);
                  if (!pageMin.unknown && Number.isFinite(pageMin.min) && pageMin.min < threshold) {
                    stopped = true;
                    break;
                  }
                }
                page += 1;
                if (page <= wanted) await fxSleep(FX_GAP);
              }
            } catch (err) {
              if (err && (err.code === 'UNAUTHORIZED' || err.code === 'NO_TOKEN')) {
                capped = true;
                throw err;
              }
              ctx.log('岗位读取失败', countryId + ' · ' + ((err && err.code) || 'ERROR'));
            }
            progress.done += 1;
            progress.count = data.length;
            if (alive) paintStatus();
            await fxSleep(FX_GAP);
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(FX_CONCURRENCY, targets.length) }, () => worker())
        );
        if (!alive) return null;
        const seen = new Set();
        const rows = data.map(buildRow).filter((row) => {
          if (!row) return false;
          const rowKey = String(row.id);
          if (seen.has(rowKey)) return false;
          seen.add(rowKey);
          return true;
        });
        return { rows, stopped, capped };
      }

      /** 打开面板 / 凭据晚到：命中已有页缓存。 */
      function load() {
        return run(false);
      }

      /** 「刷新岗位」：绕过 2 分钟 TTL 重抓（失败保留旧值，不清缓存）。 */
      function refresh() {
        return run(true);
      }

      function run(force) {
        if (!alive || loading) return;
        if (apiClient.state !== 'ok') {
          error = { code: apiClient.state === 'expired' ? 'UNAUTHORIZED' : 'NO_TOKEN' };
          paint();
          armAuthRetry();
          return;
        }

        loading = true;
        error = null;
        capped = false;
        progress = { done: 0, total: 0, count: 0 };
        paint();

        (async () => {
          try {
            const [list, rateResult] = await Promise.all([
              // 「刷新岗位」连国家清单一起绕过页面级 TTL，否则清单刚拉过的话刷新等于没刷
              fxFeed.loadCountries(force ? 'refresh' : 'ensure').catch((err) => {
                ctx.log('国家清单读取失败', (err && err.code) || (err && err.message) || err);
                return [];
              }),
              fxFeed.ensure().catch((err) => {
                ctx.log('汇率读取失败', (err && err.code) || (err && err.message) || err);
                return null;
              })
            ]);
            if (!alive) return;
            ratesLoading = rateResult == null;
            paintStatus();

            await readPlayer();
            if (!alive) return;
            const targets = (Array.isArray(list) ? list : [])
              .filter((item) => item && item.id != null)
              .map((item) => String(item.id));
            if (!targets.length) {
              const empty = new Error('没有可用的国家清单');
              empty.code = 'EMPTY_COUNTRIES';
              throw empty;
            }
            progress.total = targets.length;
            paintStatus();

            const result = await fetchJobs(force, minGold, targets);
            if (!alive || !result) return;
            rows = result.rows;
            capped = result.capped === true;
            refreshRates();
            updatedAt = Date.now();
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            error = {
              code: (err && err.code) || 'ERROR',
              message: err && err.message,
              retryAt: (err && err.retryAt) || 0,
              reason: (err && err.reason) || ''
            };
            if (error.code === 'UNAUTHORIZED' || error.code === 'NO_TOKEN') armAuthRetry();
          } finally {
            loading = false;
            ratesLoading = false;
            if (alive) {
              paint();
              // 列表高度变了，重新测一次，别沿用旧的
              ctx.ui.reposition();
            }
          }
        })();
      }

      on(refreshBtn, 'click', () => refresh());

      on(skillEl, 'change', () => {
        skillOnly = skillEl.checked;
        ctx.storage.set('skillOnly', skillOnly);
        paint();
        ctx.ui.reposition();
      });

      on(minGoldEl, 'input', () => {
        readMinGold();
        ctx.storage.set('minGold', minGoldEl.value || '');
        // 门槛立即作用于已加载的岗位；提前停止翻页在下一轮抓取（刷新岗位）生效
        paint();
        ctx.ui.reposition();
      });

      on(queryEl, 'input', () => {
        query = (queryEl.value || '').toLowerCase();
        renderList();
        ctx.ui.reposition();
      });

      // 面板在 Shadow DOM 内：打字时别让游戏把按键当成自己的快捷键
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        on(queryEl, type, (event) => event.stopPropagation());
        on(minGoldEl, type, (event) => event.stopPropagation());
      });

      // 行情在别的标签页刷新完了：金价与排序跟着更新，不重复请求岗位
      const offFx = fxFeed.subscribe((kind) => {
        if (kind !== 'done' || !alive || !rows.length) return;
        refreshRates();
        if (loading) return;
        paint();
        ctx.ui.reposition();
      });

      // 国籍 / 位置变了就重画高亮与「当前位置」标签（跨页面共享同一份账号数据）
      const offPlayer = playerFeed.watch((info) => {
        if (!alive) return;
        if (applyFields(info)) paint();
      });

      // 每次显示本标签：补读账号（10 秒过期才真请求）；岗位页缓存 2 分钟，切标签不整轮重抓
      ctx.onShow(() => {
        readPlayer();
      });

      ctx.onDestroy(() => {
        alive = false;
        offFx();
        offPlayer();
        if (offAuth) {
          offAuth();
          offAuth = null;
        }
      });

      // 默认门槛 1 金；旧设置里存过空串 / 非法值也回到 1，只有有效数字才沿用
      const savedMinGold = ctx.storage.get('minGold', '1');
      const savedText = savedMinGold == null ? '' : String(savedMinGold).trim();
      const savedNum = Number(savedText);
      minGoldEl.value =
        savedText !== '' && Number.isFinite(savedNum) && savedNum >= 0 ? String(savedNum) : '1';
      readMinGold();
      skillEl.checked = skillOnly;
      paint();
      // 打开「工作」就抓一轮：国家清单、汇率与账号都命中共享缓存时只发岗位请求
      load();
    }
  });

  registerFeature({
    id: 'business',
    title: '工商',
    order: 40,
    mount(pane, ctx) {
      pane.classList.add('eh-biz-shell');
      pane.innerHTML = `
        <div class="eh-biz-tabs" role="tablist" aria-label="工商子面板" data-role="tabs"></div>
        <div class="eh-biz-body" data-role="body"></div>
      `;

      const tabsEl = pane.querySelector('[data-role="tabs"]');
      const bodyEl = pane.querySelector('[data-role="body"]');
      const items = businessPanes
        .slice()
        .sort((a, b) => (a.order == null ? 100 : a.order) - (b.order == null ? 100 : b.order));

      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'eh-empty';
        empty.textContent = '还没有注册任何子面板。';
        bodyEl.appendChild(empty);
        return;
      }

      const buttons = new Map();
      const holders = new Map();
      /** 子面板各自的「显示」回调：切到这个子标签时触发。 */
      const subShows = new Map();

      /**
       * 子面板拿到的 ctx：storage 再按子面板 id 分一层，别的子面板不会和它抢同一个键；
       * 日志也带上子面板 id，排查时能看出是哪一个。
       */
      const subContext = (paneId) => ({
        version: ctx.version,
        id: ctx.id + ':' + paneId,
        shadow: ctx.shadow,
        ui: ctx.ui,
        route: ctx.route,
        storage: {
          get: (key, fallback) => ctx.storage.get(paneId + ':' + key, fallback),
          set: (key, value) => ctx.storage.set(paneId + ':' + key, value),
          remove: (key) => ctx.storage.remove(paneId + ':' + key)
        },
        onDestroy: (fn) => ctx.onDestroy(fn),
        onShow(fn) {
          if (typeof fn !== 'function') return;
          if (!subShows.has(paneId)) subShows.set(paneId, []);
          subShows.get(paneId).push(fn);
        },
        log: (...args) => ctx.log('[' + paneId + ']', ...args)
      });

      /** 懒加载：子面板只在第一次切到它时 mount。 */
      const activate = (id) => {
        const target = items.find((item) => item.id === id) || items[0];
        ctx.storage.set('pane', target.id);

        buttons.forEach((btn, key) => {
          const active = key === target.id;
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-selected', String(active));
          btn.tabIndex = active ? 0 : -1;
        });
        holders.forEach((holder, key) => {
          holder.hidden = key !== target.id;
        });

        let holder = holders.get(target.id);
        const fresh = !holder;
        if (!holder) {
          holder = document.createElement('div');
          holder.className = 'eh-biz-pane';
          holder.setAttribute('role', 'tabpanel');
          holder.setAttribute('aria-label', target.title);
          bodyEl.appendChild(holder);
          holders.set(target.id, holder);
          try {
            target.mount(holder, subContext(target.id));
          } catch (err) {
            warn('工商子面板「' + target.title + '」初始化失败', err);
            holder.textContent = '';
            const failed = document.createElement('p');
            failed.className = 'eh-empty';
            failed.textContent =
              '子面板初始化失败：' + (err && err.message ? err.message : String(err));
            holder.appendChild(failed);
          }
        }
        holder.hidden = false;
        ctx.ui.reposition();

        // 首次由 mount 自己读一轮，切回来时才需要「显示」通知去补读
        if (!fresh && state.open) {
          const shows = subShows.get(target.id) || [];
          shows.forEach((fn) => {
            try {
              fn();
            } catch (err) {
              warn('子面板「' + target.title + '」显示回调异常', err);
            }
          });
        }
      };

      items.forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eh-biz-tab';
        btn.dataset.pane = item.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', 'false');
        btn.tabIndex = -1;
        btn.textContent = item.title;
        on(btn, 'click', () => activate(item.id));
        tabsEl.appendChild(btn);
        buttons.set(item.id, btn);
      });

      // 子标签之间左右方向键切换（与顶层标签一致，只在子标签栏内生效）
      on(tabsEl, 'keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const list = [...tabsEl.querySelectorAll('.eh-biz-tab')];
        const index = list.indexOf(ctx.shadow.activeElement);
        if (index < 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = list[(index + step + list.length) % list.length];
        next.focus();
        activate(next.dataset.pane);
      });

      const saved = ctx.storage.get('pane', null);
      activate(typeof saved === 'string' && items.some((item) => item.id === saved) ? saved : items[0].id);
    }
  });

  /* -------- 9.6 设置与版本检查 -------- */

  const UPDATE_CHECK_TIMEOUT = 4000;

  /** 语义化版本比较：a 比 b 新返回 1，相同返回 0，更旧返回 -1。 */
  function compareVersions(a, b) {
    const parse = (value) =>
      String(value == null ? '' : value)
        .trim()
        .split('.')
        .map((part) => parseInt(part, 10) || 0);
    const left = parse(a);
    const right = parse(b);
    const size = Math.max(left.length, right.length);
    for (let i = 0; i < size; i += 1) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  /** 给单个请求拼一个「外部取消 + 自身超时」的信号；不支持时退回外部信号。 */
  function withTimeout(signal) {
    const canTimeout =
      typeof AbortSignal !== 'undefined' &&
      typeof AbortSignal.timeout === 'function' &&
      typeof AbortSignal.any === 'function';
    if (!canTimeout) return signal;
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(UPDATE_CHECK_TIMEOUT)]) : AbortSignal.timeout(UPDATE_CHECK_TIMEOUT);
  }

  /** CDN 都按完整 URL 缓存，带上时间戳才能绕开边缘节点里那份缓存了几小时的旧元数据。 */
  function bustMetaUrl(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'eh_t=' + Date.now();
  }

  /** 读一个源上的 @version；失败不抛错，交给上层用其它源，错误原样带回去便于区分超时。 */
  async function readMetaVersion(url, signal) {
    try {
      const response = await window.fetch(bustMetaUrl(url), {
        cache: 'no-cache',
        credentials: 'omit',
        signal: withTimeout(signal)
      });
      if (!response.ok) return { version: '', error: new Error('HTTP_' + response.status) };
      const text = await response.text();
      const match = /^\s*\/\/\s*@version\s+(\S+)/m.exec(text);
      return match ? { version: match[1], error: null } : { version: '', error: new Error('BAD_META') };
    } catch (err) {
      return { version: '', error: err };
    }
  }

  /**
   * 只读取元数据文件里的 @version（几行注释而已），
   * 检查更新的流量与脚本体积无关，确认有新版本再让玩家手动安装。
   * 几个源并行、各自限时：取其中最高的版本号，某个源缓存落后或挂住都不影响结论。
   */
  async function fetchLatestVersion(signal) {
    const results = await Promise.all(UPDATE_META_URLS.map((url) => readMetaVersion(url, signal)));
    let latest = '';
    let timedOut = false;
    results.forEach((item) => {
      if (item.version && compareVersions(item.version, latest) > 0) latest = item.version;
      const name = item.error && item.error.name;
      if (name === 'AbortError' || name === 'TimeoutError') timedOut = true;
    });
    if (latest) return latest;
    const error = new Error(timedOut ? 'TIMEOUT' : 'NO_SOURCE');
    error.timeout = timedOut;
    throw error;
  }

  registerFeature({
    id: 'about',
    title: '设置',
    order: 900,
    mount(pane, ctx) {
      pane.innerHTML = `
        <div class="eh-section">
          <div class="eh-h3">版本更新</div>
          <div class="eh-ver">
            <span>当前版本</span><b>v${VERSION}</b>
            <button class="eh-btn" type="button" data-role="check">检查更新</button>
            <a class="eh-btn" href="${UPDATE_INSTALL_URL}" target="_blank" rel="noopener noreferrer" data-role="install" hidden>安装更新</a>
          </div>
          <p class="eh-note" data-role="update-note" hidden></p>
          <p class="eh-links">
            <a href="${UPDATE_INSTALL_URL}" target="_blank" rel="noopener noreferrer">手动安装（jsDelivr）</a>
            <a href="${UPDATE_INSTALL_MIRROR}" target="_blank" rel="noopener noreferrer">备用（JSDMirror）</a>
            <a href="${UPDATE_INSTALL_FALLBACK}" target="_blank" rel="noopener noreferrer">备用（GitHub）</a>
          </p>
        </div>
        <div class="eh-section">
          <div class="eh-h3">功能开关</div>
          <label class="eh-gd-switch">
            <input type="checkbox" data-role="badge">
            <span>显示金价换算</span>
          </label>
          <label class="eh-gd-switch">
            <input type="checkbox" data-role="regions">
            <span>不在当地时展示目标地区列表</span>
          </label>
          <label class="eh-gd-switch">
            <input type="checkbox" data-role="auto-compare">
            <span>商品市场自动加载比价数据</span>
          </label>
          <p class="eh-note is-warn" data-role="auto-note" hidden></p>
          <div class="eh-row" data-role="auto-confirm" hidden>
            <button class="eh-btn" type="button" data-role="auto-yes">仍然开启</button>
            <button class="eh-btn eh-btn--ghost" type="button" data-role="auto-no">取消</button>
          </div>
        </div>
        <div class="eh-section">
          <div class="eh-h3">API 访问</div>
          <div class="eh-kv">
            <span>当前鉴权</span><b data-role="api-mode">…</b>
            <span data-role="api-key-label" hidden>专用密钥</span><b class="eh-mono" data-role="api-key" hidden>—</b>
            <span data-role="api-usage-label" hidden>今日用量</span><b data-role="api-usage" hidden>—</b>
          </div>
          <p class="eh-note" data-role="api-usage-note" hidden></p>
          <p class="eh-note" data-role="api-note" hidden></p>
          <div class="eh-row">
            <button class="eh-btn" type="button" data-role="api-generate">生成 API 专用密钥</button>
            <button class="eh-btn eh-btn--ghost" type="button" data-role="api-clear" hidden>移除密钥</button>
          </div>
          <div class="eh-row" data-role="api-manual">
            <input class="eh-input" type="password" data-role="api-input" placeholder="或粘贴已有密钥（eclesiar_…）" autocomplete="off" spellcheck="false" />
            <button class="eh-btn eh-btn--ghost" type="button" data-role="api-save">保存密钥</button>
          </div>
          <p class="eh-linkline">
            <a class="eh-textlink" href="${API_DOC_URL}" target="_blank" rel="noopener noreferrer">接口文档 / 管理密钥</a>
          </p>
          <p class="eh-flash" data-role="api-flash" hidden></p>
        </div>
        <div class="eh-section">
          <div class="eh-h3">操作</div>
          <div class="eh-kv">
            <span>Alt + E</span><b>打开 / 收起面板</b>
            <span>Esc</span><b>收起面板</b>
            <span>拖动悬浮球</span><b>移动入口位置</b>
            <span>拖动标题栏</span><b>移动面板（双击复位）</b>
          </div>
        </div>
        <div class="eh-section">
          <div class="eh-h3">链接</div>
          <p class="eh-links">
            <a href="https://wiki.eclesiar.com/" target="_blank" rel="noopener noreferrer">官方 Wiki</a>
            <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
            <a href="${REPO_URL}/issues" target="_blank" rel="noopener noreferrer">问题反馈</a>
          </p>
        </div>
        <div class="eh-section">
          <div class="eh-h3">维护</div>
          <p class="eh-note">重置只影响插件保存在浏览器本地的界面设置，不会改动游戏数据，也不会删除已保存的 API 密钥。</p>
          <div class="eh-row">
            <button class="eh-btn" type="button" data-role="reset-ball">重置悬浮球位置</button>
            <button class="eh-btn eh-btn--ghost" type="button" data-role="reset-all">清除本地设置</button>
          </div>
          <p class="eh-flash" data-role="flash" hidden></p>
        </div>
        <p class="eh-disclaimer">
          非官方插件。请遵守游戏规则，避免使用任何影响公平性的自动化行为。
        </p>
      `;

      const noteEl = pane.querySelector('[data-role="update-note"]');
      const checkBtn = pane.querySelector('[data-role="check"]');
      const installLink = pane.querySelector('[data-role="install"]');

      const apiModeEl = pane.querySelector('[data-role="api-mode"]');
      const apiKeyLabelEl = pane.querySelector('[data-role="api-key-label"]');
      const apiKeyEl = pane.querySelector('[data-role="api-key"]');
      const apiNoteEl = pane.querySelector('[data-role="api-note"]');
      const apiGenBtn = pane.querySelector('[data-role="api-generate"]');
      const apiClearBtn = pane.querySelector('[data-role="api-clear"]');
      const apiManualEl = pane.querySelector('[data-role="api-manual"]');
      const apiInputEl = pane.querySelector('[data-role="api-input"]');
      const apiSaveBtn = pane.querySelector('[data-role="api-save"]');
      const apiFlash = pane.querySelector('[data-role="api-flash"]');
      const apiUsageLabelEl = pane.querySelector('[data-role="api-usage-label"]');
      const apiUsageEl = pane.querySelector('[data-role="api-usage"]');
      const apiUsageNoteEl = pane.querySelector('[data-role="api-usage-note"]');

      let alive = true;
      let controller = null;
      let generating = false;
      let apiFlashTimer = 0;
      let usageLoading = false;
      let usageText = '';
      let usageDate = '';
      let usageReady = false;
      let usageError = '';

      // 功能开关：原先在市场页，集中到这里管理；游戏页标注仍由 marketBadge / regionJump 自己维护
      const badgeToggle = pane.querySelector('[data-role="badge"]');
      const regionToggle = pane.querySelector('[data-role="regions"]');
      const autoToggle = pane.querySelector('[data-role="auto-compare"]');
      const autoNote = pane.querySelector('[data-role="auto-note"]');
      const autoConfirm = pane.querySelector('[data-role="auto-confirm"]');
      const autoYes = pane.querySelector('[data-role="auto-yes"]');
      const autoNo = pane.querySelector('[data-role="auto-no"]');
      const AUTO_WARN =
        '开启后会在游戏启动时自动获取全球行情，数据请求量比较大，可能拖慢游戏启动速度。该选项关闭时，也可以在市场页获取完整数据后正常展示比价。';

      const syncToggles = () => {
        badgeToggle.checked = marketBadge.enabled;
        regionToggle.checked = regionJump.enabled;
        autoToggle.checked = goodsAuto.enabled;
        autoConfirm.hidden = true;
        autoNote.hidden = true;
        autoNote.textContent = '';
      };

      on(badgeToggle, 'change', () => {
        marketBadge.setEnabled(badgeToggle.checked);
        ctx.log('市场列表金价标注', badgeToggle.checked ? '开' : '关');
      });

      on(regionToggle, 'change', () => {
        regionJump.setEnabled(regionToggle.checked);
        ctx.log('地区快捷跳转', regionToggle.checked ? '开' : '关');
      });

      // 自动比价默认关闭：勾选只展开提醒，点「仍然开启」才真正生效
      on(autoToggle, 'change', () => {
        if (!autoToggle.checked) {
          goodsAuto.setEnabled(false);
          syncToggles();
          ctx.ui.reposition();
          return;
        }
        autoToggle.checked = false;
        autoConfirm.hidden = false;
        autoNote.textContent = AUTO_WARN;
        autoNote.hidden = false;
        ctx.ui.reposition();
      });

      on(autoYes, 'click', () => {
        goodsAuto.setEnabled(true);
        syncToggles();
        ctx.ui.reposition();
      });

      on(autoNo, 'click', () => {
        syncToggles();
        ctx.ui.reposition();
      });

      // 「清除本地设置」等其它入口也会关掉自动比价，勾选状态跟着同步
      const offAuto = goodsAuto.subscribe(() => {
        if (!alive) return;
        syncToggles();
        ctx.ui.reposition();
      });

      syncToggles();

      const sayApi = (text, tone) => {
        apiFlash.hidden = false;
        apiFlash.textContent = text;
        if (tone) apiFlash.dataset.tone = tone;
        else delete apiFlash.dataset.tone;
        clearTimeout(apiFlashTimer);
        apiFlashTimer = window.setTimeout(() => {
          apiFlash.hidden = true;
        }, 5000);
      };

      /** 距下一个 UTC 零点的倒计时（分钟粒度）；额度就是那个时候重置。 */
      const usageCountdown = () => {
        if (!usageReady) return usageError;
        const now = new Date();
        const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        const minutes = Math.max(0, Math.ceil((next - now.getTime()) / 60000));
        let left = '即将重置';
        if (minutes > 0) {
          const hours = Math.floor(minutes / 60);
          const rest = minutes % 60;
          left = '距重置 ' + (hours ? hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '') : rest + ' 分钟');
        }
        return left + (usageDate ? ' · 统计日 ' + usageDate : '');
      };

      /** 把「当前用哪套凭据」同步到界面上。 */
      const syncApi = () => {
        const mode = apiClient.mode;
        const expired = apiClient.state === 'expired';
        const usingApi = mode === 'api';
        const healthy = usingApi && !expired;

        // 未使用专用密钥时把状态文字标红，代替多余的解释
        apiModeEl.className = healthy ? '' : 'is-warn';
        if (healthy) apiModeEl.textContent = 'API 专用密钥';
        else if (usingApi) apiModeEl.textContent = 'API 专用密钥（已失效）';
        else if (mode === 'login') apiModeEl.textContent = '登录凭据（临时）';
        else apiModeEl.textContent = '未获取';

        // 没设置密钥时不必展示「未保存」那一行
        apiKeyLabelEl.hidden = !usingApi;
        apiKeyEl.hidden = !usingApi;
        apiKeyEl.textContent = usingApi ? apiKey.masked : '—';

        apiNoteEl.className = 'eh-note is-warn';
        apiNoteEl.textContent = usingApi
          ? expired
            ? '密钥已失效，请重新生成密钥并粘贴到这里使用。'
            : ''
          : mode === 'login'
            ? '正在临时使用用户登录凭据获取数据，建议使用 API 专用密钥。'
            : '未获取到凭据，请先登录游戏或者从 API 管理中生成密钥并粘贴到这里使用。';
        apiNoteEl.hidden = !apiNoteEl.textContent;
        apiClearBtn.hidden = !usingApi;

        // 已有可用密钥时不再需要手动粘贴框；密钥失效时保留，方便直接换一个
        apiManualEl.hidden = healthy;

        // 用量只在专用密钥可用时展示
        const showUsage = usingApi && !expired;
        const usageHint = usageCountdown();
        apiUsageLabelEl.hidden = !showUsage;
        apiUsageEl.hidden = !showUsage;
        apiUsageNoteEl.hidden = !showUsage || !usageHint;
        if (showUsage) {
          apiUsageEl.textContent = usageLoading ? '读取中…' : usageText || '—';
          apiUsageNoteEl.textContent = usageHint;
        }

        apiGenBtn.textContent = generating ? '生成中…' : usingApi ? '重新生成密钥' : '生成专用密钥';
        apiGenBtn.disabled = generating;
        apiSaveBtn.disabled = generating;
      };

      /** 专用密钥的当日用量：60 秒内复用同一份结果。 */
      const USAGE_KEY = '/account/apikey/usage';

      const countLabel = (value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      };

      const resetUsage = () => {
        usageText = '';
        usageDate = '';
        usageReady = false;
        usageError = '';
      };

      /**
       * 进入设置页时读一次当日用量；只有专用密钥可用时才请求。
       * 用量接口只认游戏登录凭据，用专用密钥反而会被拒，所以这里显式指定 login。
       * 结果走 apiCache（60 秒）：来回切标签不会每次都打一遍这个接口。
       */
      const loadUsage = async () => {
        if (!alive || usageLoading) return;
        if (apiClient.mode !== 'api' || apiClient.state !== 'ok') return;

        usageLoading = true;
        syncApi();
        try {
          const entry = await apiCache.ensure(
            USAGE_KEY,
            () => apiClient.call(USAGE_KEY, { login: true, object: true }),
            { ttl: 'usage', namespace: 'usage' }
          );
          const usage = entry && entry.value;
          if (!alive) return;
          const used = Number(usage && usage.used);
          const limit = Number(usage && usage.limit);
          const remaining = Number(usage && usage.remaining);
          if (!Number.isFinite(used) || !Number.isFinite(limit)) throw new Error('BAD_USAGE');
          usageText =
            countLabel(used) +
            ' / ' +
            countLabel(limit) +
            (Number.isFinite(remaining) ? '（剩余 ' + countLabel(remaining) + '）' : '');
          usageDate = usage && usage.date ? String(usage.date) : '';
          usageReady = true;
          usageError = '';
        } catch (err) {
          if (!alive) return;
          if (err && err.name === 'AbortError') return;
          usageReady = false;
          usageDate = '';
          if (err && err.code === 'NO_TOKEN') {
            usageText = '—';
            usageError = '需要游戏登录凭据，刷新页面后重试';
          } else if (err && err.code === 'UNAUTHORIZED') {
            usageText = '—';
            usageError = '登录凭据已失效，刷新页面后重试';
          } else {
            usageText = '读取失败';
            usageError = '';
          }
        } finally {
          usageLoading = false;
          if (alive) {
            syncApi();
            ctx.ui.reposition();
          }
        }
      };

      // 每分钟刷新一次「距重置」倒计时
      const usageTimer = window.setInterval(() => {
        if (!alive || !usageReady) return;
        syncApi();
      }, 60000);

      const describeApiError = (err) => {
        const code = err && err.code;
        if (code === 'NO_TOKEN') return '还没抓到登录凭据：先在游戏里点开任意页面，稍等几秒再试。';
        if (code === 'UNAUTHORIZED') return '登录凭据已失效，请刷新游戏页面后再试。';
        if (code === 'TIMEOUT') return '请求超时，请稍后重试。';
        if (code === 'BAD_KEY') return '接口返回的密钥格式不认识，请到接口文档页手动生成。';
        const http = code === 'HTTP' ? /^HTTP_(\d+)$/.exec(String(err.message || '')) : null;
        if (http) return '生成失败：HTTP ' + http[1] + '，请稍后重试。';
        return '生成失败：' + (err && err.message ? err.message : '未知错误');
      };

      const generateApiKey = async () => {
        if (generating) return;
        generating = true;
        syncApi();
        ctx.ui.reposition();
        try {
          await apiClient.generateKey();
          if (!alive) return;
          apiInputEl.value = '';
          sayApi('已保存密钥 ' + apiKey.masked);
          resetUsage();
          loadUsage();
        } catch (err) {
          if (!alive) return;
          sayApi(describeApiError(err), 'warn');
        } finally {
          if (alive) {
            generating = false;
            syncApi();
            ctx.ui.reposition();
          }
        }
      };

      const saveApiKey = () => {
        if (generating) return;
        const raw = apiInputEl.value.trim();
        if (!raw) {
          sayApi('请先粘贴密钥。', 'warn');
          return;
        }
        if (!apiClient.setKey(raw)) {
          sayApi('密钥格式不对：应以 eclesiar_ 开头，检查是否多了空格或漏了字符。', 'warn');
          return;
        }
        apiInputEl.value = '';
        syncApi();
        ctx.ui.reposition();
        sayApi('已保存密钥 ' + apiKey.masked + '，后续查询都用它。');
        resetUsage();
        loadUsage();
      };

      const clearApiKey = () => {
        apiClient.clearKey();
        resetUsage();
        syncApi();
        ctx.ui.reposition();
        sayApi('已移除密钥，改回使用登录凭据。', 'warn');
      };

      on(apiGenBtn, 'click', generateApiKey);
      on(apiSaveBtn, 'click', saveApiKey);
      on(apiClearBtn, 'click', clearApiKey);
      on(apiInputEl, 'keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        saveApiKey();
      });

      // 面板在 Shadow DOM 内，输入框的按键别冒泡给游戏当快捷键
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        on(apiInputEl, type, (event) => event.stopPropagation());
      });

      const stopCheck = () => {
        if (!controller) return;
        const current = controller;
        controller = null;
        try {
          current.abort();
        } catch (err) {
          /* ignore */
        }
      };

      const check = async () => {
        if (!alive) return;
        stopCheck();

        const current = new AbortController();
        controller = current;

        checkBtn.disabled = true;
        checkBtn.textContent = '检查中…';
        installLink.hidden = true;
        noteEl.hidden = false;
        noteEl.className = 'eh-note';
        noteEl.textContent = '正在检查更新…';

        try {
          const latest = await fetchLatestVersion(current.signal);
          if (!alive || controller !== current) return;
          const newer = compareVersions(latest, VERSION) > 0;
          installLink.hidden = !newer;
          noteEl.className = newer ? 'eh-note is-warn' : 'eh-note is-ok';
          noteEl.textContent = newer
            ? '发现新版本 v' + latest + '，点「安装更新」覆盖安装，本地设置会保留。'
            : '已是最新版本。';
        } catch (err) {
          if (!alive || controller !== current) return;
          const name = err && err.name;
          const timeout = Boolean(err && err.timeout) || name === 'AbortError' || name === 'TimeoutError';
          noteEl.hidden = false;
          noteEl.className = 'eh-note is-warn';
          noteEl.textContent = timeout
            ? '检查超时（网络不通或 CDN 太慢），可点下面的「手动安装」直接装。'
            : '无法读取版本信息（可能被站点安全策略或网络拦截），可点下面的「手动安装」直接装。';
        } finally {
          if (controller === current) {
            controller = null;
            if (alive) {
              checkBtn.disabled = false;
              checkBtn.textContent = '检查更新';
              ctx.ui.reposition();
            }
          }
        }
      };

      on(checkBtn, 'click', check);

      const flash = pane.querySelector('[data-role="flash"]');
      let flashTimer = 0;
      const say = (text) => {
        flash.hidden = false;
        flash.textContent = text;
        clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          flash.hidden = true;
        }, 2400);
      };

      on(pane.querySelector('[data-role="reset-ball"]'), 'click', () => {
        ctx.ui.resetBall();
        say('悬浮球位置已重置');
      });

      on(pane.querySelector('[data-role="reset-all"]'), 'click', () => {
        ctx.ui.resetAll();
        // 自动比价也回到默认关闭，同时停掉后台的自动刷新（设置页的勾选状态由订阅同步）
        goodsAuto.setEnabled(false);
        say('已清除本地设置，界面恢复默认');
        ctx.ui.reposition();
      });

      // 「设置」页常驻：进入本页时核对凭据状态并刷新一次用量（切标签、重新打开面板都会触发）
      const panelEl = pane.closest('.eh-panel');
      const enterPage = () => {
        if (pane.hidden) return;
        if (panelEl && !panelEl.classList.contains('is-open')) return;
        syncApi();
        loadUsage();
        ctx.ui.reposition();
      };
      const watchPane = new MutationObserver(() => {
        if (!pane.hidden) enterPage();
      });
      watchPane.observe(pane, { attributes: true, attributeFilter: ['hidden'] });

      // 只看面板开合，忽略拖动时增删的其它 class
      let panelOpen = panelEl ? panelEl.classList.contains('is-open') : false;
      const watchPanel = new MutationObserver(() => {
        if (!panelEl) return;
        const next = panelEl.classList.contains('is-open');
        if (next === panelOpen) return;
        panelOpen = next;
        if (next) enterPage();
      });
      if (panelEl) watchPanel.observe(panelEl, { attributes: true, attributeFilter: ['class'] });

      ctx.onDestroy(() => {
        alive = false;
        stopCheck();
        clearTimeout(flashTimer);
        clearTimeout(apiFlashTimer);
        clearInterval(usageTimer);
        offAuto();
        watchPane.disconnect();
        watchPanel.disconnect();
      });

      syncApi();
      loadUsage();
      // 打开「设置」即自动检查一次
      check();
    }
  });

  /* =========================================================================
   * 10. 启动 / 销毁
   * ========================================================================= */

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  function formatClock(timestamp) {
    const value = Number(timestamp);
    // 0 / 非数字表示「没有可用的时间」（例如一次都没成功过），别把它显示成 1970 年
    if (!Number.isFinite(value) || value <= 0) return '—';
    const now = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  }

  /** 按当前视口重排；记录本次使用的尺寸，供事件后的兜底校验比较。 */
  function syncLayout() {
    if (destroyed) return;
    lastViewportW = window.innerWidth;
    lastViewportH = window.innerHeight;
    applyBall();
    if (state.open) placePanel({ measure: true, keepTop: true });
  }

  function handleResize() {
    syncLayout();

    // 某些环境下 resize 事件会早于视口真正生效触发：事件后再校验一次。
    // rAF 在后台会被暂停，所以同时保留一个定时器兜底。
    const verifyViewport = () => {
      if (destroyed) return;
      if (window.innerWidth === lastViewportW && window.innerHeight === lastViewportH) return;
      syncLayout();
    };
    requestAnimationFrame(verifyViewport);
    clearTimeout(resizeFollowUp);
    resizeFollowUp = window.setTimeout(verifyViewport, 250);
  }

  function onKeyDown(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const active = dom.shadow ? dom.shadow.activeElement : null;
    const inside =
      path.includes(dom.host) || Boolean(active && dom.panel && dom.panel.contains(active));

    if (event.key === 'Escape') {
      // 只有按键发生在插件内部时才接管，避免抢走游戏自己的 Esc 行为
      if (!state.open || !inside) return;
      event.stopPropagation();
      setOpen(false);
      return;
    }

    if (event.repeat) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code !== 'KeyE' && String(event.key).toLowerCase() !== 'e') return;

    const target = path[0] || event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    ) {
      return;
    }

    event.preventDefault();
    setOpen(!state.open);
  }

  function loadState() {
    const ball = storage.read('ball', null);
    if (ball && Number.isFinite(ball.rx) && Number.isFinite(ball.ry)) {
      state.ball = { rx: clamp(ball.rx, 0, 1), ry: clamp(ball.ry, 0, 1) };
    }

    state.panelPinned = storage.read('panelPinned', false) === true;

    const pos = storage.read('panelPos', null);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      state.panelPos = pos;
    }
    // 两个键不同步时以「位置」为准，避免面板卡在既不跟随也不能拖的状态
    if (!state.panelPos) state.panelPinned = false;

    const tab = storage.read('activeTab', null);
    if (typeof tab === 'string' && features.has(tab)) state.activeTab = tab;
  }

  /** 游戏是 SPA，极端情况下（如整页替换 body）容器会被移除，这里做自愈。 */
  function watchMount() {
    hostObserver = new MutationObserver(() => {
      if (dom.host.isConnected) return;
      queueMicrotask(() => {
        if (destroyed || !document.body || dom.host.isConnected) return;
        document.body.appendChild(dom.host);
        hostObserver.disconnect();
        hostObserver.observe(document.documentElement, { childList: true });
        hostObserver.observe(document.body, { childList: true });
        log('容器被移除，已重新挂载');
      });
    });
    hostObserver.observe(document.documentElement, { childList: true });
    if (document.body) hostObserver.observe(document.body, { childList: true });
  }

  /** 独立于 resize 事件的尺寸触发源：布局完成后再校正一次。 */
  function watchViewport() {
    if (typeof ResizeObserver !== 'function') return;
    let width = window.innerWidth;
    let height = window.innerHeight;
    viewportObserver = new ResizeObserver(() => {
      if (destroyed) return;
      if (window.innerWidth === width && window.innerHeight === height) return;
      width = window.innerWidth;
      height = window.innerHeight;
      syncLayout();
    });
    viewportObserver.observe(document.documentElement);
  }

  function boot() {
    if (booted || destroyed || !document.body) return;
    booted = true;

    try {
      loadState();
      apiClient.install();
      createShell();
      bindBall();
      bindPanel();
      on(document, 'keydown', onKeyDown, true);
      on(window, 'resize', handleResize);
      on(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') syncLayout();
      });
      watchMount();
      watchViewport();
      renderTabs();
      applyBall();
      marketBadge.sync();
      regionJump.sync();
      // 整页跳进来时（SPA 没接住的那一档）地址里还带着商品 / 品质意图，补一次消费
      marketJump.start();
      // 「商品市场自动加载比价数据」开启时，启动就预抓一次行情（延迟几秒，先让游戏首屏跑完）
      goodsAuto.start(false);

      window.EclesiarHelper = api;
      log('已启动 v' + VERSION);
    } catch (err) {
      warn('初始化失败，已停止加载', err);
      if (hostObserver) hostObserver.disconnect();
    if (viewportObserver) viewportObserver.disconnect();
      if (dom.host) dom.host.remove();
      booted = false;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;

    clearTimeout(resizeFollowUp);
    clearTimeout(statusTimer);
    clearTimeout(suppressClickTimer);
    if (hostObserver) hostObserver.disconnect();
    // 先停自动刷新与页面上的徽标，再断开路由与接口
    goodsAuto.stop();
    goodsSnapshot.cancel();
    marketBadge.stop();
    regionJump.stop();
    marketJump.destroy();
    route.destroy();
    fxFeed.cancel();
    // 地区缓存只存内存，销毁时一并丢掉；在途请求会自己结束，不会留下轮询
    regionFeed.clear();
    // 请求层缓存同理：清空后旧请求的结果不会回写（失效代数校验）
    apiCache.clear();
    coinBook.reset();
    apiClient.uninstall();

    features.forEach((feature) => {
      if (feature.__cleanups) {
        feature.__cleanups.forEach((fn) => {
          try {
            fn();
          } catch (err) {
            warn('清理回调异常', err);
          }
        });
        feature.__cleanups = [];
      }
      feature.__showHooks = [];
      if (feature.__pane && typeof feature.unmount === 'function') {
        try {
          feature.unmount();
        } catch (err) {
          warn('unmount 异常', err);
        }
      }
    });

    disposers.splice(0).forEach((fn) => {
      try {
        fn();
      } catch (err) {
        /* ignore */
      }
    });

    if (dom.host) dom.host.remove();
    state.open = false;
    state.panelPinned = false;

    if (window.EclesiarHelper === api) {
      try {
        delete window.EclesiarHelper;
      } catch (err) {
        window.EclesiarHelper = undefined;
      }
    }
  }

  /* =========================================================================
   * 11. 公开 API
   * ========================================================================= */

  const api = {
    version: VERSION,
    features: {
      register: registerFeature,
      list: () =>
        sortedFeatures().map((feature) => ({
          id: feature.id,
          title: feature.title,
          order: feature.order
        }))
    },
    route: {
      get current() {
        return route.current;
      },
      onChange: (fn) => route.subscribe(fn),
      goto: (path) => route.goto(path)
    },
    ui: publicUi,
    open: publicUi.open,
    close: publicUi.close,
    toggle: publicUi.toggle,
    storage: {
      get: (key, fallback) => storage.read(key, fallback),
      set: (key, value) => storage.write(key, value),
      remove: (key) => storage.remove(key)
    },
    /** 调试用：请求层缓存的统计与条目查询（只在控制台手动调用，插件自己不轮询）。 */
    cache: {
      stats: () => apiCache.stats(),
      report: (label) => apiCache.report(label),
      peek: (key) => apiCache.peek(key),
      invalidate: (prefix) => apiCache.invalidate(prefix),
      clear: () => apiCache.clear()
    },
    destroy
  };

  if (document.body) {
    boot();
  } else {
    on(document, 'DOMContentLoaded', boot, { once: true });
  }
})();
