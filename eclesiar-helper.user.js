// ==UserScript==
// @name         Eclesiar 助手
// @name:en      Eclesiar Helper
// @namespace    https://github.com/Billdex/eclesiar-helper
// @version      0.1.9
// @description  Eclesiar 经济 / 政治计算辅助插件：悬浮球面板 + 全球汇率总览 + 各国市场商品金价比价与销售税后收益估算，商品市场列表与上架表单直接标注折算金价，并可一键跳转该国的地区页面。
// @description:en Eclesiar helper: floating panel + exchange rates + cross-market goods pricing and after-tax sale revenue in gold, plus one-click jumps to a country's regions.
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
 *   3. 面板 —— 标签页容器 + 内置「汇率 / 商品 / 设置」
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

  const VERSION = '0.1.9';
  const REPO_URL = 'https://github.com/Billdex/eclesiar-helper';
  /** jsDelivr 的 GitHub 镜像：国内可达，更新检查与安装都以它为主。 */
  const CDN_RAW = 'https://cdn.jsdelivr.net/gh/Billdex/eclesiar-helper@main/';
  /** GitHub raw 在国内常被拦，只作为备用。 */
  const REPO_RAW = 'https://raw.githubusercontent.com/Billdex/eclesiar-helper/main/';
  /** 版本号只从元数据文件读，检查更新时不需要下载整个脚本。 */
  const UPDATE_META_URLS = [CDN_RAW + 'eclesiar-helper.meta.js', REPO_RAW + 'eclesiar-helper.meta.js'];
  const UPDATE_INSTALL_URL = CDN_RAW + 'eclesiar-helper.user.js';
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

  .eh-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 14px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: rgba(201, 165, 74, .35) transparent;
  }

  .eh-body::-webkit-scrollbar { width: 8px; }

  .eh-body::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 8px;
    background: rgba(201, 165, 74, .25);
    background-clip: content-box;
  }

  .eh-pane[hidden] { display: none; }

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

  /* 该货币还在拉取：行右侧的小转圈 */
  .eh-fx-spin {
    flex: none;
    width: 11px;
    height: 11px;
    margin-left: 2px;
    border: 1.5px solid rgba(201, 165, 74, .22);
    border-top-color: #e8cd8f;
    border-radius: 50%;
    animation: eh-fx-turn .72s linear infinite;
  }

  @keyframes eh-fx-turn {
    to { transform: rotate(1turn); }
  }

  /* 行内右下角的跳转按钮：汇率 → 货币市场，商品 → 该国商品市场 */
  .eh-go {
    position: absolute;
    right: 5px;
    bottom: 4px;
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
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
    /* 右下角要放跳转按钮，文字别顶到那里 */
    padding-right: 30px;
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

  /* 采购 / 销售 切换 */
  .eh-gd-modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-bottom: 7px;
    padding: 3px;
    border: 1px solid var(--eh-line);
    border-radius: 9px;
    background: rgba(255, 255, 255, .03);
  }

  .eh-gd-mode {
    padding: 4px 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--eh-muted);
    font-family: inherit;
    font-size: 11.5px;
    line-height: 1.5;
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

  /* 销售：国籍（决定是否免进口税）与税率提示 */
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

  /* ---------- 商品市场列表金价标注开关 ---------- */

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
    grid-template-columns: 14px 18px minmax(0, 1fr) auto;
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

  .eh-gd-rank {
    font-family: var(--eh-mono);
    font-size: 9.5px;
    color: #5f6e85;
    text-align: right;
  }

  .eh-gd-row.is-best .eh-gd-rank { color: #7fc9a8; }

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
    padding-left: 21px;
    /* 右下角留给跳转按钮 */
    padding-right: 34px;
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

  .eh-gd-row.is-exile .eh-gd-rank { color: #6b5b52; }

  .eh-gd-exile-tag {
    margin-left: 4px;
    font-size: 9.5px;
    white-space: nowrap;
    color: #b07a5c;
  }

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
    .eh-body { padding: 12px; }
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
  }

  function createFeatureContext(feature) {
    const cleanups = [];
    feature.__cleanups = cleanups;

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
   * 市场接口凭据。
   * 登录 JWT 只从游戏自己发往 api.eclesiar.com 的请求里读取，仅保存在内存中：
   * 不写 localStorage、不打日志、不上报。
   * 若用户在「设置」页保存了专用 API 密钥，则所有插件请求优先用它。
   */
  const market = (() => {
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
      return data;
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
        return true;
      },
      /** 移除已保存的密钥，回到使用登录凭据。 */
      clearKey() {
        apiKey.clear();
        apiExpired = false;
      }
    };
  })();

  /** 凭据不可用时的统一提示，汇率与商品共用。 */
  function authHint() {
    if (market.mode === 'api') {
      return market.state === 'expired'
        ? '专用 API 密钥已失效，请到「设置」页重新生成。'
        : '专用 API 密钥暂不可用，请到「设置」页检查。';
    }
    const state = market.state;
    if (state === 'expired') return '登录凭据已失效，请刷新游戏页面后再试。';
    if (state === 'unsupported') return '抓到接口请求了，但凭据格式不是 Bearer，请刷新游戏页面后再试。';
    return '尚未拿到登录凭据：先在游戏里打开任意页面（触发一次接口请求），再点「刷新行情」。';
  }

  /** 429 多半是每日查询额度用尽，提示去换专用密钥。 */
  function quotaHint(err) {
    if (!err || err.code !== 'HTTP' || String(err.message) !== 'HTTP_429') return '';
    return '接口返回 429（请求过多或已达当日查询上限），可到「设置」页生成专用密钥后再试。';
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

  /**
   * 统一两侧挂单的口径：价格一律换成「黄金 / 1 单位法币」，数量换成可成交黄金量。
   * SELL 单：amount 是法币数量，rate 本身就是 黄金/法币。
   * BUY 单：amount 是黄金数量，rate 是 法币/黄金，价格要取倒数。
   */
  function fxBook(sellOrders, buyOrders) {
    const read = (list) =>
      (Array.isArray(list) ? list : [])
        .map((order) => ({
          rate: Number(order && order.rate),
          amount: Number(order && order.amount)
        }))
        .filter(
          (order) =>
            Number.isFinite(order.rate) && order.rate > 0 && Number.isFinite(order.amount) && order.amount > 0
        );

    const asks = read(sellOrders)
      .map((order) => ({ price: order.rate, qty: order.amount, gold: order.amount * order.rate }))
      .sort((a, b) => a.price - b.price);

    const bids = read(buyOrders)
      .map((order) => ({ price: 1 / order.rate, qty: order.amount * order.rate, gold: order.amount }))
      .sort((a, b) => b.price - a.price);

    return { asks, bids };
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

  /* -------- 9.2 汇率数据源：两个标签共用一份缓存 -------- */

  /** 汇率缓存的有效期：两个标签共用一份行情，超过这个时间才重新拉。 */
  const FX_CACHE_MS = 10 * 60 * 1000;

  /**
   * 汇率数据源：全局只保留一份行情，供「汇率」与「商品」共用。
   * 订阅回调签名 (kind, quote)：
   *   reset —— quotes 整体替换，订阅方需要重建列表；
   *   row   —— 单个货币的数据 / 状态变化；
   *   drop  —— 该货币两侧都没有挂单，应从列表移除；
   *   state —— 加载中 / 进度 / 错误等整体状态变化；
   *   done  —— 本轮结束（含失败），订阅方可以排序。
   */
  const fxFeed = (() => {
    const listeners = new Set();
    let countries = null;
    let countriesPromise = null;
    /** 国家 id → { vat, importTax }（百分数，10 表示 10%）；只在「销售」视图用得到。 */
    let taxes = null;
    let taxesPromise = null;
    let quotes = [];
    let updatedAt = 0;
    let loading = false;
    let error = null;
    let progress = { phase: 'idle', done: 0, total: 0, retryIndex: 0, retryTotal: 0 };
    let controller = null;
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

    /** 国家清单只取一次：两个标签都要用，短时间内也不会变。 */
    function ensureCountries() {
      if (countries) return Promise.resolve(countries);
      if (!countriesPromise) {
        countriesPromise = market
          .call('/countries/summary')
          .then((data) => {
            countries = Array.isArray(data) ? data : [];
            return countries;
          })
          .catch((err) => {
            countriesPromise = null;
            throw err;
          });
      }
      return countriesPromise;
    }

    /** 税率字段容错：正常是 10（=10%），个别实现会给 0.1 这种比例。 */
    const toPercent = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return null;
      if (num > 0 && num < 1) return num * 100;
      return num;
    };

    /**
     * 各国税率：/countries 的 laws.vat / laws.import_taxes。
     * 与 summary 分开请求，只在打开「销售」视图时拉一次，结果在页面内缓存。
     */
    function ensureTaxes() {
      if (taxes) return Promise.resolve(taxes);
      if (!taxesPromise) {
        taxesPromise = market
          .call('/countries')
          .then((list) => {
            const map = new Map();
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
              if (vat == null && importTax == null) return;
              map.set(String(country.id), {
                vat: vat == null ? 0 : vat,
                importTax: importTax == null ? 0 : importTax
              });
            });
            taxes = map;
            return taxes;
          })
          .catch((err) => {
            taxesPromise = null;
            throw err;
          });
      }
      return taxesPromise;
    }

    async function load() {
      if (loading) return promise;
      if (market.state !== 'ok') {
        error = { code: 'NO_TOKEN' };
        notify('state');
        return null;
      }

      loading = true;
      error = null;
      progress = { phase: 'fetch', done: 0, total: 0, retryIndex: 0, retryTotal: 0 };
      const previous = quotes; // 本次失败时用来回滚，别让已有结果凭空消失
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          /* ignore */
        }
      }
      controller = new AbortController();
      const signal = controller.signal;
      notify('state');

      promise = (async () => {
        try {
          const list = fxCurrencies(await ensureCountries()).map((entry) =>
            Object.assign({}, entry, { asks: null, bids: null, status: 'pending' })
          );
          if (!list.length) {
            const empty = new Error('没有可用的法币清单');
            empty.code = 'EMPTY_CURRENCIES';
            throw empty;
          }

          quotes = list;
          progress = { phase: 'fetch', done: 0, total: list.length, retryIndex: 0, retryTotal: 0 };
          notify('reset');

          // 遍历用副本：无挂单的货币会从 quotes（就是 list）里 splice 掉，
          // 直接用 list 当队列会让 length 变短、把后面的货币整段跳过。
          const total = list.length;
          const work = list.slice();
          const failures = [];
          let limited = false;
          let cursor = 0;

          const fetchEntry = async (quote) => {
            const [sell, buy] = await Promise.all([
              market.call('/market/coin/get', {
                form: { currency_id: quote.id, transaction: 'SELL' },
                signal
              }),
              market.call('/market/coin/get', {
                form: { currency_id: quote.id, transaction: 'BUY' },
                signal
              })
            ]);
            const book = fxBook(sell, buy);
            if (!book.asks.length && !book.bids.length) {
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
          };

          const worker = async () => {
            while (cursor < work.length) {
              if (signal.aborted) return;
              const quote = work[cursor];
              cursor += 1;

              try {
                await fetchEntry(quote);
              } catch (err) {
                if (err && err.name === 'AbortError') return;
                if (err && err.code === 'UNAUTHORIZED') throw err;
                if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
                quote.status = 'error';
                notify('row', quote);
                failures.push(quote);
              }

              progress = Object.assign({}, progress, { done: progress.done + 1 });
              notify('state');
              await fxSleep(FX_GAP);
            }
          };

          await Promise.all(Array.from({ length: Math.min(FX_CONCURRENCY, total) }, () => worker()));
          if (signal.aborted) return;

          // 失败多半是瞬时 429 / 5xx：串行补一次，行内转圈重新转起来，仍失败才计入结果
          const retry = failures.splice(0);
          progress = Object.assign({}, progress, {
            phase: 'retry',
            retryIndex: 0,
            retryTotal: retry.length
          });
          for (let i = 0; i < retry.length; i += 1) {
            if (signal.aborted) return;
            const quote = retry[i];
            progress = Object.assign({}, progress, { retryIndex: i + 1 });
            quote.status = 'pending';
            notify('row', quote);
            try {
              await fetchEntry(quote);
            } catch (err) {
              if (err && err.name === 'AbortError') return;
              if (err && err.code === 'UNAUTHORIZED') throw err;
              if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
              quote.status = 'error';
              notify('row', quote);
              failures.push(quote);
            }
            notify('state');
            await fxSleep(FX_GAP * 3);
          }

          updatedAt = Date.now();
          progress = Object.assign({}, progress, { phase: 'idle', retryIndex: 0, retryTotal: 0 });
          if (failures.length) error = { code: 'PARTIAL', count: failures.length, limited };
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          quotes = previous;
          if (err && err.code === 'UNAUTHORIZED') {
            try {
              controller.abort();
            } catch (ignore) {
              /* ignore */
            }
          }
          error = { code: (err && err.code) || 'ERROR', message: err && err.message };
          notify('reset');
        } finally {
          loading = false;
          promise = null;
          notify('done');
          notify('state');
        }
      })();

      return promise;
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
      get updatedAt() {
        return updatedAt;
      },
      get error() {
        return error;
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      ensureCountries,
      ensureTaxes,
      load,
      /** 缓存还在有效期内就直接用，否则拉一次；并发调用共享同一个请求。 */
      async ensure(maxAge) {
        if (loading) return promise;
        const age = maxAge == null ? FX_CACHE_MS : maxAge;
        if (updatedAt && Date.now() - updatedAt < age) return quotes;
        return load();
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
      /** 法币 id → 最优卖单价（黄金 / 1 单位法币）；没有行情时返回 null。 */
      rateFor(currencyId) {
        const quote = quotes.find((item) => item.id === currencyId);
        if (!quote || quote.status !== 'ok' || !quote.asks || !quote.asks.length) return null;
        return quote.asks[0].price;
      },
      /**
       * 卖法币换黄金的最优价（黄金 / 1 单位法币）：吃的是别人的买单，
       * 与「买入价」（rateFor，吃卖单）不是一个方向，销售时必须用这个。
       */
      sellRateFor(currencyId) {
        const quote = quotes.find((item) => item.id === currencyId);
        if (!quote || quote.status !== 'ok' || !quote.bids || !quote.bids.length) return null;
        return quote.bids[0].price;
      },
      /** 该国货币在当前买单里还能吃下多少（法币数量），用于提示换汇深度不足。 */
      sellCapacityFor(currencyId) {
        const quote = quotes.find((item) => item.id === currencyId);
        if (!quote || quote.status !== 'ok' || !quote.bids) return 0;
        return quote.bids.reduce((sum, level) => sum + level.qty, 0);
      },
      /** 国家 id → 税率（百分数）；还没拉到 / 该国没有 laws 时返回 null。 */
      taxFor(countryId) {
        if (!taxes || countryId == null) return null;
        return taxes.get(String(countryId)) || null;
      },
      cancel() {
        if (!controller) return;
        try {
          controller.abort();
        } catch (err) {
          /* ignore */
        }
      }
    };
  })();

  /* -------- 9.2b 玩家信息：国籍与当前所在国家 -------- */

  /**
   * 只取两个字段，两个模块共用同一份缓存：
   *  - nationalityId：玩家国籍，「销售」时用来判断本国免进口税；
   *  - countryId：当前所在国家（region.country.id），
   *    商品市场里的价格按「所在国市场的本币」计价（上架表单的单价 / 实收金额就是这种），
   *    折算成黄金必须知道这一条。
   * 固定用 POST /account/getuser（只认游戏登录凭据，带专用密钥会 401），
   * 结果只存内存，不展示原字段、不打印、不上报、不落盘；响应里的 bearer 等字段一律忽略。
   */
  const playerFeed = (() => {
    /** 缓存 2 分钟：换国家后最多 2 分钟就会重新读一次；期间不重复打接口。 */
    const TTL = 2 * 60 * 1000;
    /** 失败冷却：接口挂了就别每条价格都试一遍。 */
    const RETRY = 60 * 1000;

    let info = null;
    let at = 0;
    let promise = null;
    let failedAt = 0;

    const pick = (data) => {
      const account = data && data.user && typeof data.user === 'object' ? data.user : data;
      const nationality = account && account.nationality;
      const rawNationality =
        nationality && nationality.id != null ? nationality.id : account && account.nationality_id;
      const region = account && account.region;
      const country = region && typeof region === 'object' ? region.country : null;
      const rawCountry = country && country.id != null ? country.id : account && account.country_id;
      return {
        nationalityId: Number(rawNationality) || 0,
        countryId: Number(rawCountry) || 0
      };
    };

    function ensure() {
      const now = Date.now();
      if (info && now - at < TTL) return Promise.resolve(info);
      if (promise) return promise;
      if (failedAt && now - failedAt < RETRY) {
        if (info) return Promise.resolve(info);
        return Promise.reject(Object.assign(new Error('COOLDOWN'), { code: 'COOLDOWN' }));
      }

      promise = market
        .call('/account/getuser', { login: true, form: {}, object: true })
        .then((data) => {
          info = pick(data);
          at = Date.now();
          failedAt = 0;
          return info;
        })
        .catch((err) => {
          // 还没捕获到凭据不算「接口坏了」：登录后要能立刻再问一次
          const code = err && err.code;
          if (code !== 'NO_TOKEN' && code !== 'UNAUTHORIZED') failedAt = Date.now();
          throw err;
        });

      const settle = () => {
        promise = null;
      };
      promise.then(settle, settle);
      return promise;
    }

    return {
      get info() {
        return info;
      },
      get nationalityId() {
        return info ? info.nationalityId : 0;
      },
      get countryId() {
        return info ? info.countryId : 0;
      },
      ensure
    };
  })();

  registerFeature({
    id: 'fx',
    title: '汇率',
    order: 20,
    mount(pane, ctx) {
      pane.innerHTML = `
        <div class="eh-section">
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
        <div class="eh-section">
          <div class="eh-h3">全球汇率</div>
          <p class="eh-fx-legend">
            买入 = 花黄金买该国法币（吃卖单，价越低越好）；卖出 = 卖法币换黄金（吃买单，价越高越好）。
            价格单位：黄金 / 1 单位法币。
          </p>
          <div class="eh-fx-pin" data-role="pins"></div>
          <div class="eh-fx-list" data-role="list"></div>
        </div>
        <p class="eh-disclaimer">
          数据来自游戏公开挂单接口，仅供参考；实际下单请以游戏内实时行情为准。
        </p>
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
        const go = buildGoButton('去货币市场（' + quote.code + '）', '/monetary-market/' + quote.id);
        go.hidden = quote.status === 'pending';
        head.appendChild(go);

        const spin = document.createElement('span');
        spin.className = 'eh-fx-spin';
        spin.setAttribute('aria-hidden', 'true');
        head.appendChild(spin);

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
       * 读一次账号的两个 id（与「商品」共用 playerFeed 缓存），
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
        if (err) {
          if (err.code === 'NO_TOKEN') failStatus(tokenHint(), 'warn');
          else if (err.code === 'UNAUTHORIZED') failStatus(tokenHint(), 'error');
          else if (err.code === 'TIMEOUT') failStatus('请求超时，请稍后重试。', 'error');
          else if (quotaHint(err)) failStatus(quotaHint(err), 'error');
          else failStatus('拉取失败：' + (err.message || '未知错误'), 'error');
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
        fxFeed.load();
        loadPins();
      });

      // 凭据晚到（面板先开、游戏还没发过请求）：账号能读到后补一次置顶，行情仍由玩家点刷新
      const offAuth = market.onAuth(() => {
        if (alive && !pinEntries.length) loadPins();
      });

      applyModeUi();

      // 挂载即同步：已有缓存（例如刚在「商品」里拉过）就直接复用，不再重复请求
      const off = fxFeed.subscribe((kind, quote) => {
        sync(kind, quote);
        // 一轮抓取结束后补读账号信息：国籍 / 所在国此时才可读时也能置顶
        if (kind === 'done') loadPins();
      });
      if (fxFeed.quotes.length || fxFeed.loading) sync('reset');
      else sync('state');
      fxFeed.ensure(FX_CACHE_MS);
      loadPins();

      ctx.onDestroy(() => {
        alive = false;
        clearTimeout(targetTimer);
        off();
        offAuth();
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
   * 面板「商品」页抓完后写进这里，游戏市场页的金价标注读它算「比全球最低贵多少」。
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
      /** 面板商品页拉完后写入（含流亡政府标记，算最低价时要跳过）。 */
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

  /** 领土检查结果的缓存时长：战争不会每分钟易手，但刷新时也该能看到新结果。 */
  const LAND_CACHE_MS = 5 * 60 * 1000;

  /** 国家 id → { exiled, at }：记录该国是否有领土，跨面板开关复用，避免重复请求。 */
  const GOODS_LAND = new Map();

  /**
   * 领土：GET /country/regions?country_id=…，返回该国目前实际占有的地区。
   * 已失去全部领土的国家不会返回空数组，而是只有 { code: 200, description: '成功' }、没有 data，
   * 所以这里要 allowEmpty 放行，由调用方把「没有 data」当成没有领土。
   * 这个接口只认 GET（同地址的 POST 是 404，路由根本不存在），所以只发 GET：
   * noMethodRetry 挡掉通用逻辑里「GET 404/405 就改发空表单 POST」的兜底，
   * 失败直接上报，由调用方按「领土未知」处理，不浪费额度也不制造假的 POST。
   */
  async function goodsFetchRegions(countryId, signal) {
    const path = '/country/regions?country_id=' + encodeURIComponent(String(countryId));
    return market.call(path, { signal, noMethodRetry: true, allowEmpty: true });
  }

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

  /**
   * 全球商品行情快照：面板「商品」页与「商品市场自动加载比价数据」共用同一份。
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
    let updatedAt = 0;
    let loading = false;
    let error = null;
    /** 上一次失败的时间：面板反复切标签时不要每次都重打一轮。 */
    let errorAt = 0;
    let progress = { done: 0, total: 0 };
    let failures = 0;
    let landFailures = 0;
    let limited = false;
    let controller = null;
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
     * 领土检查：/country/regions 没有 data（或返回空数组）即流亡政府（已失去全部领土）。
     * 只查有挂单的国家——没挂单的市场本来就不进列表，没必要多打请求。
     * 请求本身失败（超时 / 4xx / 429）才按「有领土」处理，宁可留在主列表也不误判。
     */
    const checkLand = async (entry, signal) => {
      const cached = GOODS_LAND.get(String(entry.id));
      if (cached && Date.now() - cached.at < LAND_CACHE_MS) {
        entry.exiled = cached.exiled;
        return;
      }
      const list = await goodsFetchRegions(entry.id, signal);
      // 已失去全部领土的国家只回 { code: 200, description: '成功' }：没有 data 就是没有领土
      const exiled = list == null || (Array.isArray(list) && list.length === 0);
      GOODS_LAND.set(String(entry.id), { exiled, at: Date.now() });
      entry.exiled = exiled;
    };

    /**
     * 凭据晚到的场景：面板可能在游戏还没发过任何接口请求时就打开了，
     * 这时先挂一次 market.onAuth，等登录凭据被捕获后自动补一轮，
     * 而不是让面板停在空列表上等玩家手动点「刷新行情」。
     * （与「商品市场自动加载比价数据」无关：那个开关只管游戏市场页的自动刷新。）
     */
    let offAuthRetry = null;
    const armAuthRetry = () => {
      if (offAuthRetry) return;
      offAuthRetry = market.onAuth(() => {
        offAuthRetry = null;
        if (!loading && !updatedAt) load();
      });
    };

    /** 拉一轮全球行情；并发调用共享同一个请求。 */
    function load() {
      if (loading) return promise;
      if (market.state !== 'ok') {
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
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          /* ignore */
        }
      }
      controller = new AbortController();
      const signal = controller.signal;
      notify('state');

      promise = (async () => {
        try {
          // 汇率与市场并行：汇率优先吃缓存，只有缓存过期才真的去拉
          fxFeed.ensure(FX_CACHE_MS).catch(() => null);
          const countries = await fxFeed.ensureCountries();
          if (signal.aborted) return;

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
              if (signal.aborted) return;
              const entry = entries[cursor];
              cursor += 1;

              try {
                // 不带 type/quality 时接口一次返回该国全部商品，一个市场只需一次请求
                const data = await market.call('/market/get', {
                  form: { countryid: entry.id },
                  object: true,
                  signal
                });
                entry.items = goodsIndex(data && data.offers);
                entry.status = 'ok';
              } catch (err) {
                if (err && err.name === 'AbortError') return;
                if (err && err.code === 'UNAUTHORIZED') throw err;
                if (err && err.code === 'HTTP' && String(err.message) === 'HTTP_429') limited = true;
                entry.status = 'error';
                failures += 1;
              }

              // 市场拉回来之后再核对领土：没挂单的国家根本不进列表，省一次请求
              if (entry.status === 'ok' && entry.items && entry.items.size) {
                try {
                  await checkLand(entry, signal);
                } catch (err) {
                  if (err && err.name === 'AbortError') return;
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
          if (signal.aborted) return;

          // 领土查不到不影响结果展示（这些国家按「有领土」留在主列表），只在调试日志里留个汇总
          if (landFailures) log('领土检查部分失败', landFailures + ' 个国家按「有领土」处理');

          updatedAt = Date.now();
          errorAt = 0;
          entries = entries.filter((entry) => entry.status === 'ok');
          // 共享给游戏市场页的金价标注：它要拿这份数据算「比全球最低贵多少」
          goodsFeed.publish(entries);
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          entries = previous;
          if (err && err.code === 'UNAUTHORIZED') {
            try {
              controller.abort();
            } catch (ignore) {
              /* ignore */
            }
          }
          error = {
            code: (err && err.code) || 'ERROR',
            message: err && err.message,
            limited
          };
          errorAt = Date.now();
        } finally {
          loading = false;
          promise = null;
          // 中止（destroy / 新一轮接管）不算结束：只更新状态，不发 done
          if (!signal.aborted) notify(error ? 'error' : 'done');
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
        if (updatedAt && now - updatedAt < age && entries.length) return Promise.resolve(entries);
        // 刚失败过：一分钟内不自动重试（手动点「刷新行情」走 load，不受此限）
        if (error && errorAt && now - errorAt < 60 * 1000) return Promise.resolve(null);
        return load();
      },
      load,
      cancel() {
        if (offAuthRetry) {
          offAuthRetry();
          offAuthRetry = null;
        }
        if (!controller) return;
        try {
          controller.abort();
        } catch (err) {
          /* ignore */
        }
      }
    };
  })();

  /* -------- 9.3b 自动比价：启动即抓、按缓存有效期自动更新 -------- */

  /**
   * 「商品市场自动加载比价数据」开关（默认关闭）。
   * 开启后插件启动就抓一次全球汇率与商品行情，之后每分钟在本地看一次快照年龄，
   * 超过 GOODS_CACHE_MS 才真正重拉；后台标签页不刷新，凭据没到手时等 onAuth 再补。
   * 一轮要 45 个国家的市场 + 换汇 + 领土请求，所以默认关闭，
   * 开启前会在「商品」页明确提示请求量与启动变慢的风险。
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
      // 凭据还没捕获到时先不动，由 market.onAuth 触发一次
      if (market.state !== 'ok') return;
      if (goodsSnapshot.loading) return;

      const now = Date.now();
      // 缓存还没过期：什么都不做（下次检查继续等）
      if (goodsSnapshot.updatedAt && now - goodsSnapshot.updatedAt < GOODS_CACHE_MS) return;
      // 上一轮失败过：至少隔 5 分钟再试，避免烧光额度
      if (lastAttemptAt && now - lastAttemptAt < RETRY_MS) return;
      lastAttemptAt = now;
      goodsSnapshot.load();
    };

    function start(immediate) {
      if (!enabled || destroyed) return;
      if (!offAuth) offAuth = market.onAuth(sync);
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
    title: '商品',
    order: 30,
    mount(pane, ctx) {
      pane.innerHTML = `
        <div class="eh-section">
          <div class="eh-h3">商品与市场</div>
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
          <label class="eh-gd-switch">
            <input type="checkbox" data-role="badge">
            <span>商品市场与上架表单显示金价</span>
          </label>
          <label class="eh-gd-switch">
            <input type="checkbox" data-role="regions">
            <span>商品市场显示该国地区快捷入口</span>
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
          <div class="eh-h3" data-role="listtitle">各国市场 · 黄金单价</div>
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
        </div>
        <p class="eh-disclaimer">
          报价来自各国市场的公开挂单，未计入可能的手续费；汇率取自「汇率」标签的最近一次结果。
        </p>
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

      /** 国籍对应的中文国名，只用于提示文案。 */
      const ownCountryLabel = () => {
        if (!myCountryId) return '';
        const country = fxFeed.countries.find((row) => Number(row && row.id) === myCountryId);
        if (!country) return '';
        const code = country.currency ? String(country.currency.name || '') : '';
        const locale = code ? fxLocale(code) : null;
        return locale ? locale[0] : String(country.name || '');
      };

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
        } else {
          text = '国籍：' + (ownCountryLabel() || '已识别') + ' · 本国销售只扣增值税，免进口税。';
        }
        taxHintEl.textContent = text;
        if (tone) taxHintEl.dataset.tone = tone;
        else delete taxHintEl.dataset.tone;
      };

      /** 税率只在进入「销售」时拉一次（/countries 的 laws），失败可重试。 */
      const loadTaxes = () => {
        if (!alive || fxFeed.taxesKnown || taxesLoading) return;
        taxesLoading = true;
        taxesFailed = false;
        taxesError = null;
        syncTaxHint();
        fxFeed
          .ensureTaxes()
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
       * 采购模式也要标，所以挂载就读一次；与「销售」的国籍读取共用同一份缓存（2 分钟）。
       */
      const loadHere = () => {
        if (!alive || hereLoading) return;
        hereLoading = true;
        let changed = false;
        playerFeed
          .ensure()
          .then((info) => {
            if (!alive) return;
            const next = (info && info.countryId) || 0;
            if (next !== hereCountryId) {
              hereCountryId = next;
              changed = true;
            }
          })
          .catch((err) => {
            if (!alive) return;
            // 读不到就静默不标，只在调试日志里留一条
            ctx.log('当前所在国家读取失败', err && err.message ? err.message : err);
          })
          .then(() => {
            if (!alive) return;
            hereLoading = false;
            if (!changed) return;
            render();
            ctx.ui.reposition();
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

        if (market.state !== 'ok') {
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
            setStatus('拉取失败：' + (err.message || '未知错误'), 'error');
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

        const rank = document.createElement('span');
        rank.className = 'eh-gd-rank';
        rank.textContent = row.exiled ? '—' : String(index + 1);
        el.appendChild(rank);

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
        // 人可能已经换了国家：刷新时顺手重读一次（playerFeed 自带 2 分钟缓存）
        loadHere();
        if (mode === 'sell') {
          loadPlayer();
          loadTaxes();
        }
        goodsSnapshot.load();
      };

      on(refreshBtn, 'click', () => load());

      // 市场页面上的金价标注：开关只影响游戏 DOM，不影响本面板
      const badgeToggle = pane.querySelector('[data-role="badge"]');
      badgeToggle.checked = marketBadge.enabled;
      on(badgeToggle, 'change', () => {
        marketBadge.setEnabled(badgeToggle.checked);
        ctx.log('市场列表金价标注', badgeToggle.checked ? '开' : '关');
      });

      // 市场页的地区快捷入口：同样只影响游戏 DOM，不影响本面板
      const regionToggle = pane.querySelector('[data-role="regions"]');
      regionToggle.checked = regionJump.enabled;
      on(regionToggle, 'change', () => {
        regionJump.setEnabled(regionToggle.checked);
        ctx.log('地区快捷跳转', regionToggle.checked ? '开' : '关');
      });

      // 自动比价：默认关闭。关闭时不显示任何说明，勾选时才提示请求量并等玩家确认
      const autoToggle = pane.querySelector('[data-role="auto-compare"]');
      const autoNote = pane.querySelector('[data-role="auto-note"]');
      const autoConfirm = pane.querySelector('[data-role="auto-confirm"]');
      const autoYes = pane.querySelector('[data-role="auto-yes"]');
      const autoNo = pane.querySelector('[data-role="auto-no"]');
      const AUTO_WARN = '开启后会在游戏启动时自动获取全球行情，数据请求量比较大，可能拖慢游戏启动速度。该选项关闭时，也可以在当前面板获取完整数据后正常展示比价。';

      const syncAuto = () => {
        autoToggle.checked = goodsAuto.enabled;
        autoConfirm.hidden = true;
        autoNote.hidden = true;
        autoNote.textContent = '';
      };

      on(autoToggle, 'change', () => {
        if (!autoToggle.checked) {
          goodsAuto.setEnabled(false);
          syncAuto();
          ctx.ui.reposition();
          return;
        }
        // 先不生效：勾选只用来展开提醒，点「仍然开启」才真正开启
        autoToggle.checked = false;
        autoConfirm.hidden = false;
        autoNote.textContent = AUTO_WARN;
        autoNote.hidden = false;
        ctx.ui.reposition();
      });

      on(autoYes, 'click', () => {
        goodsAuto.setEnabled(true);
        syncAuto();
        ctx.ui.reposition();
      });

      on(autoNo, 'click', () => {
        syncAuto();
        ctx.ui.reposition();
      });

      // 「清除本地设置」等其它入口也会改开关，勾选状态跟着同步
      const offAuto = goodsAuto.subscribe(() => {
        syncAuto();
        if (alive) ctx.ui.reposition();
      });

      syncAuto();

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
      const offAuth = market.onAuth(() => {
        if (alive && !hereCountryId) loadHere();
      });
      // 面板自己做主：有新鲜快照就直接复用，否则拉一轮。与「商品市场自动加载比价数据」无关
      goodsSnapshot.ensure(GOODS_CACHE_MS);

      // 每次切回本页也检查一次：快照过期就补一轮，不需要玩家记得点「刷新行情」
      const watchPane = new MutationObserver(() => {
        if (!alive || pane.hidden) return;
        goodsSnapshot.ensure(GOODS_CACHE_MS);
      });
      watchPane.observe(pane, { attributes: true, attributeFilter: ['hidden'] });

      ctx.onDestroy(() => {
        alive = false;
        off();
        offSnap();
        offAuto();
        offAuth();
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
   * 汇率优先复用「汇率」标签那份缓存（fxFeed），缺少时才按单个货币查一次挂单，
   * 结果缓存 5 分钟；一次页面访问最多按币种数个请求，不轮询。
   */
  const marketBadge = (() => {
    const ATTR = 'data-eh-gold';
    const RATE_TTL = 5 * 60 * 1000;
    const RATE_RETRY = 60 * 1000;
    /** 国家清单拉失败后 30 秒内不再重试；单次请求超过 10 秒视为卡住，允许重来。 */
    const MAP_RETRY = 30 * 1000;
    const MAP_TIMEOUT = 10 * 1000;
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
    let credentialTries = 0;
    let currencyMap = null;
    let currencyByCountry = null;
    let currencyPromise = null;
    let currencyStartedAt = 0;
    let currencyFailedAt = 0;
    /** 当前认定的商品列表容器；离开页面或它被移除后重新找。 */
    let scope = null;
    /** 上架面板容器（含「上架身份」与「实收金额」的那一栏）；同样会失效重找。 */
    let listingRoot = null;
    /** 已为「当前所在国家」发过请求，避免每轮扫描都问一次。 */
    let playerAsked = false;
    /** 两类标注各自是否画成功过：决定热身重试何时收工。 */
    let rowPainted = false;
    let grossPainted = false;

    /** 货币 id → { at, rate, failed }：rate 为 null 表示该币种确实没有挂单。 */
    const rates = new Map();
    const pending = new Set();
    /** 同上，但记的是「卖币换金」方向（吃买单），给上架实收金额用。 */
    const sellRates = new Map();
    const sellPending = new Set();
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
     * 自己发这一次请求、不借用 fxFeed 的缓存 promise：那份是给汇率 / 商品用的，
     * 它失败或挂住时不该连带市场页标注一起失效。
     */
    function ensureCurrencyMap() {
      const now = Date.now();
      if (currencyMap) return;
      if (currencyPromise) {
        // 请求卡住超过 10 秒就不再等它，允许下一轮重来
        if (now - currencyStartedAt < MAP_TIMEOUT) return;
        currencyPromise = null;
      }
      if (market.state !== 'ok') return;
      if (currencyFailedAt && now - currencyFailedAt < MAP_RETRY) return;

      currencyStartedAt = now;
      currencyPromise = fxFeed
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
          currencyFailedAt = Date.now();
          log('市场金价：国家清单读取失败', err && (err.message || err.code));
        })
        .then(() => {
          currencyPromise = null;
        });
    }

    /**
     * 没有对应方向挂单的币种只查一次并记住；失败则冷却 1 分钟，避免反复打接口。
     * selling=true 查买单（卖币换金），false 查卖单（买币花金）。
     */
    function fetchRate(id, selling) {
      if (market.state !== 'ok') return;
      const bucket = selling ? sellRates : rates;
      const waiting = selling ? sellPending : pending;
      waiting.add(id);
      market
        .call('/market/coin/get', { form: { currency_id: id, transaction: selling ? 'BUY' : 'SELL' } })
        .then((orders) => {
          const book = selling ? fxBook(null, orders) : fxBook(orders, null);
          const levels = selling ? book.bids : book.asks;
          bucket.set(id, { at: Date.now(), rate: levels.length ? levels[0].price : null });
        })
        .catch((err) => {
          bucket.set(id, { at: Date.now(), rate: null, failed: true });
          log('市场金价：换汇挂单读取失败', err && (err.message || err.code));
        })
        .then(() => {
          waiting.delete(id);
          schedule();
        });
    }

    /**
     * 黄金/单位货币；null = 没有这个方向的挂单；undefined = 正在取或刚失败，先不画。
     * selling=true 走买单（你把手里的法币卖成黄金），false 走卖单（你花黄金买法币）。
     */
    function goldRateOf(id, selling) {
      const direct = selling ? fxFeed.sellRateFor(id) : fxFeed.rateFor(id);
      if (direct) return direct;

      const cached = (selling ? sellRates : rates).get(id);
      const now = Date.now();
      if (cached) {
        if (cached.failed && now - cached.at < RATE_RETRY) return undefined;
        if (!cached.failed && now - cached.at < RATE_TTL) return cached.rate;
      }
      if ((selling ? sellPending : pending).has(id)) return undefined;
      fetchRate(id, selling);
      return undefined;
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
      // 全球最低价来自面板「商品」页抓过的行情，没有数据就只显示本国折算价
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
        title += '；在面板「商品」页抓取一次行情后，会显示与全球最低价的对比';
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
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      clearTimeout(timer);
      clearInterval(retryTimer);
      timer = 0;
      retryTimer = 0;
      credentialTries = 0;
      scope = null;
      listingRoot = null;
      playerAsked = false;
      rowPainted = false;
      grossPainted = false;
      pending.clear();
      sellPending.clear();
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
    market.onAuth(() => {
      if (running) schedule();
    });
    // 面板「商品」页抓到新行情后，市场页上的「比全球最低贵多少」跟着刷新
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
   * 数据：GET /country/regions?country_id=…（与商品比价的领土检查同一个接口），
   * 每个国家缓存 5 分钟；没有 data 说明该国已失去全部领土（流亡政府），照实提示。
   *
   * DOM：只往页面追加一个带 data-eh-regions 的宿主节点，界面全在自己的 Shadow DOM 里，
   * 不改游戏原有节点、不接管它们的点击；离开市场页 / 关掉开关 / destroy() 时整块移除。
   */
  const regionJump = (() => {
    const ATTR = 'data-eh-regions';
    const TTL = 5 * 60 * 1000;
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

    /** 国家 id → { at, list }：同一国家短时间反复进出不重复打接口。 */
    const cache = new Map();

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
      const cached = cache.get(id);
      if (cached && Date.now() - cached.at < TTL) {
        if (list !== cached.list) {
          list = cached.list;
          paintedKey = '';
        }
        return;
      }
      if (pending) return;
      if (failedAt && Date.now() - failedAt < RETRY) return;
      if (market.state !== 'ok') return;

      pending = goodsFetchRegions(id)
        .then((data) => {
          const regions = Array.isArray(data) ? data : [];
          failed = false;
          cache.set(id, { at: Date.now(), list: regions });
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
      if (!list && market.state !== 'ok') {
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
      const cached = cache.get(id);
      list = cached && Date.now() - cached.at < TTL ? cached.list : null;

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
    market.onAuth(() => {
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

  /* -------- 9.5 设置与版本检查 -------- */

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

  /**
   * 只读取元数据文件里的 @version（几行注释而已），
   * 检查更新的流量与脚本体积无关，确认有新版本再让玩家手动安装。
   * 每个源单独限时：raw 在某些网络下会一直挂着，不能让它吃掉备用源的时间。
   */
  async function fetchLatestVersion(signal) {
    let lastError = null;
    for (let i = 0; i < UPDATE_META_URLS.length; i += 1) {
      if (signal && signal.aborted) break;
      try {
        const response = await window.fetch(UPDATE_META_URLS[i], {
          cache: 'no-cache',
          credentials: 'omit',
          signal: withTimeout(signal)
        });
        if (!response.ok) throw new Error('HTTP_' + response.status);
        const text = await response.text();
        const match = /^\s*\/\/\s*@version\s+(\S+)/m.exec(text);
        if (!match) throw new Error('BAD_META');
        return match[1];
      } catch (err) {
        // 外部主动取消（重新检查 / 关闭面板）要立刻停，单源超时则换下一个源
        if (signal && signal.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError || new Error('NO_SOURCE');
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
            <a href="${UPDATE_INSTALL_FALLBACK}" target="_blank" rel="noopener noreferrer">备用地址（GitHub）</a>
          </p>
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
        const mode = market.mode;
        const expired = market.state === 'expired';
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
       */
      const loadUsage = async () => {
        if (!alive || usageLoading) return;
        if (market.mode !== 'api' || market.state !== 'ok') return;

        usageLoading = true;
        syncApi();
        try {
          const usage = await market.call('/account/apikey/usage', { login: true, object: true });
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
          await market.generateKey();
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
        if (!market.setKey(raw)) {
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
        market.clearKey();
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
          const timeout = name === 'AbortError' || name === 'TimeoutError';
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
        // 自动比价也回到默认关闭，同时停掉后台的自动刷新（商品页的勾选状态由订阅同步）
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
    const now = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
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
      market.install();
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
    market.uninstall();

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
    destroy
  };

  if (document.body) {
    boot();
  } else {
    on(document, 'DOMContentLoaded', boot, { once: true });
  }
})();
