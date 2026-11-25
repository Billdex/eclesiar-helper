// ==UserScript==
// @name         Eclesiar 助手
// @name:en      Eclesiar Helper
// @namespace    https://app.eclesiar.com/
// @version      0.3.0
// @description  Eclesiar 经济 / 政治计算辅助插件：悬浮球面板 + 全球汇率总览。
// @description:en Eclesiar helper: floating panel + global exchange-rate overview.
// @author       billdex
// @match        https://app.eclesiar.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
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
 *   3. 面板 —— 标签页容器 + 内置「概览 / 关于」
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

  const VERSION = '0.3.0';
  const NS = 'eclesiar-helper';
  const ROOT_ID = NS + '-root';
  const Z_INDEX = '2147483000';
  const BALL_SIZE = 54;
  const EDGE = 8;
  const DEFAULT_BALL = { rx: 1, ry: 0.78 };
  const DEBUG = /[?&]eh-debug=1(?:&|$)/.test(location.search);

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
    gap: 10px;
    flex: none;
    padding: 13px 14px 12px;
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
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid var(--eh-brass-line);
    border-radius: 9px;
    background: linear-gradient(160deg, #24395a, #152337);
    color: #ecd79f;
    font-family: var(--eh-serif);
    font-size: 16px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .1);
  }

  .eh-head__text {
    flex: 1;
    min-width: 0;
  }

  .eh-title {
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: .04em;
    color: #f6efdf;
    white-space: nowrap;
  }

  .eh-sub {
    margin-top: 1px;
    font-size: 10.5px;
    letter-spacing: .08em;
    color: var(--eh-dim);
    white-space: nowrap;
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
    gap: 4px;
    flex: none;
    padding: 8px 10px;
    border-bottom: 1px solid var(--eh-line);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .eh-tabs::-webkit-scrollbar { display: none; }

  .eh-tab {
    flex: none;
    padding: 5px 11px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--eh-muted);
    font-family: inherit;
    font-size: 12px;
    line-height: 1.6;
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

  .eh-flash {
    margin: 10px 0 0;
    font-size: 11.5px;
    color: #8fd6a8;
  }

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

  .eh-fx-field {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 10px;
    border: 1px solid var(--eh-line);
    border-radius: 9px;
    background: rgba(255, 255, 255, .03);
    font-size: 11.5px;
    color: var(--eh-muted);
  }

  .eh-fx-field input {
    width: 54px;
    padding: 1px 2px;
    border: 0;
    border-bottom: 1px dashed rgba(201, 165, 74, .45);
    background: transparent;
    color: #f0d9a4;
    font-family: var(--eh-mono);
    font-size: 12px;
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

  .eh-fx-row.is-error {
    border-color: rgba(227, 154, 154, .3);
    background: rgba(227, 154, 154, .04);
  }

  .eh-fx-prices {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 5px;
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

  .eh-fx-cost {
    margin-top: 4px;
    font-size: 10.5px;
    line-height: 1.7;
    color: #8d9bb0;
  }

  .eh-fx-cost b {
    font-family: var(--eh-mono);
    font-weight: 600;
    color: #e7dfcd;
  }

  .eh-fx-deep {
    margin-left: 3px;
    color: #d9a35e;
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
    .eh-head { padding: 11px 12px 10px; }
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
        <div class="eh-head__text">
          <div class="eh-title">Eclesiar 助手</div>
          <div class="eh-sub">经济 · 政治 · 计算辅助</div>
        </div>
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
        onChange: (fn) => route.subscribe(fn)
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

    return {
      get current() {
        return current;
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        subscribers.add(fn);
        return () => subscribers.delete(fn);
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
      storage.clear();
      state.ball = { ...DEFAULT_BALL };
      state.panelPinned = false;
      state.panelPos = null;
      applyBall();
      if (state.open) placePanel();
    }
  };

  /* =========================================================================
   * 9. 内置功能
   * ========================================================================= */

  registerFeature({
    id: 'overview',
    title: '概览',
    order: 10,
    mount(pane, ctx) {
      pane.innerHTML = `
        <div class="eh-section">
          <div class="eh-h3">当前页面</div>
          <div class="eh-kv">
            <span>路由</span><b class="eh-mono" data-role="route">—</b>
            <span>标题</span><b data-role="title">—</b>
          </div>
        </div>
        <div class="eh-section">
          <div class="eh-h3">运行环境</div>
          <div class="eh-kv">
            <span>视口</span><b data-role="viewport">—</b>
            <span>语言</span><b data-role="lang">—</b>
            <span>本地时间</span><b class="eh-mono" data-role="clock">—</b>
          </div>
        </div>
        <div class="eh-callout">
          插件基座已就绪。这里是后续「行情 / 税率 / 生产 / 选举」等模块的接入位置，
          新功能只需注册一个标签页，外壳无需改动。
        </div>
      `;

      const routeEl = pane.querySelector('[data-role="route"]');
      const titleEl = pane.querySelector('[data-role="title"]');
      const viewportEl = pane.querySelector('[data-role="viewport"]');
      const langEl = pane.querySelector('[data-role="lang"]');
      const clockEl = pane.querySelector('[data-role="clock"]');

      const refreshPage = () => {
        routeEl.textContent = ctx.route.current || '/';
        titleEl.textContent = document.title || '—';
      };

      const refreshClock = () => {
        clockEl.textContent = formatClock();
      };

      const refreshViewport = () => {
        viewportEl.textContent = window.innerWidth + ' × ' + window.innerHeight;
      };

      refreshPage();
      refreshClock();
      refreshViewport();
      langEl.textContent = document.documentElement.lang || navigator.language || '—';

      const offRoute = ctx.route.onChange(() => {
        refreshPage();
        refreshClock();
      });
      const timer = window.setInterval(() => {
        refreshClock();
        if (document.title !== titleEl.textContent) refreshPage();
      }, 1000);
      on(window, 'resize', refreshViewport);

      ctx.onDestroy(() => {
        offRoute();
        clearInterval(timer);
      });
    }
  });

  /* -------- 9.1 汇率总览：接口、凭据与计算 -------- */

  const FX_API = 'https://api.eclesiar.com';
  const FX_CONCURRENCY = 3;
  const FX_GAP = 60;

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
   * 只从游戏自己发往 api.eclesiar.com 的请求里读取 Authorization，
   * 仅保存在内存中：不写 localStorage、不打日志、不上报。
   */
  const market = (() => {
    let token = '';
    let seenAuth = false;
    let expired = false;
    let installed = false;
    const restores = [];

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
      if (value === token) return;
      token = value;
      expired = false;
      log('已捕获接口凭据（仅内存）');
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
      token = '';
    }

    const normalize = (err) => {
      if (err && err.name === 'TimeoutError') {
        const error = new Error('请求超时');
        error.code = 'TIMEOUT';
        return error;
      }
      return err;
    };

    async function call(path, options) {
      const opts = options || {};
      if (!token) {
        const error = new Error('NO_TOKEN');
        error.code = 'NO_TOKEN';
        throw error;
      }

      const headers = { accept: 'application/json', authorization: token };
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

      if (opts.form) {
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
        token = '';
        expired = true;
        const error = new Error('UNAUTHORIZED');
        error.code = 'UNAUTHORIZED';
        throw error;
      }

      if (!response.ok) {
        // 列表接口可能只接受 POST：GET 被拒时补一次空表单请求
        if (init.method === 'GET' && (response.status === 404 || response.status === 405)) {
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

      if (!payload || payload.code !== 200 || !Array.isArray(payload.data)) {
        const error = new Error('BAD_PAYLOAD');
        error.code = 'BAD_PAYLOAD';
        throw error;
      }
      return payload.data;
    }

    return {
      get token() {
        return token;
      },
      /** none：没见过凭据头；unsupported：见过但格式不符；expired：服务端判失效 */
      get state() {
        if (token) return 'ok';
        if (expired) return 'expired';
        return seenAuth ? 'unsupported' : 'none';
      },
      install,
      uninstall,
      call
    };
  })();

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

  registerFeature({
    id: 'fx',
    title: '汇率',
    order: 20,
    mount(pane, ctx) {
      pane.innerHTML = `
        <div class="eh-section">
          <div class="eh-h3">换汇目标</div>
          <div class="eh-fx-bar">
            <label class="eh-fx-field">目标黄金
              <input type="number" min="0.01" step="1" inputmode="decimal" data-role="target" />
            </label>
            <button class="eh-btn" type="button" data-role="refresh">刷新行情</button>
          </div>
          <p class="eh-fx-status" data-role="status">…</p>
        </div>
        <div class="eh-section">
          <div class="eh-h3">全球汇率</div>
          <p class="eh-fx-legend">
            买入 = 花黄金买该国法币（吃卖单，价越低越好）；卖出 = 卖法币换黄金（吃买单，价越高越好）。
            价格单位：黄金 / 1 单位法币。
          </p>
          <div class="eh-fx-list" data-role="list"></div>
        </div>
        <p class="eh-disclaimer">
          数据来自游戏公开挂单接口，仅供参考；实际下单请以游戏内实时行情为准。
        </p>
      `;

      const targetInput = pane.querySelector('[data-role="target"]');
      const listEl = pane.querySelector('[data-role="list"]');
      const statusEl = pane.querySelector('[data-role="status"]');
      const refreshBtn = pane.querySelector('[data-role="refresh"]');

      let target = Number(ctx.storage.get('target', 10));
      if (!Number.isFinite(target) || target <= 0) target = 10;
      targetInput.value = String(target);

      let quotes = [];      // 列表里正在展示的货币（含尚未返回的 pending 行）
      let rows = new Map(); // 法币 id → 行内节点，用于原地更新而不重建整块列表
      let loading = false;
      let alive = true;
      let controller = null;
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
        setStatus(quotes.length ? text + ' · 下方为上次结果' : text, tone);
      };

      const tokenHint = () => {
        const state = market.state;
        if (state === 'expired') return '登录凭据已失效，请刷新游戏页面后再试。';
        if (state === 'unsupported') return '抓到接口请求了，但凭据格式不是 Bearer，请刷新游戏页面后再试。';
        return '尚未拿到登录凭据：先在游戏里打开任意页面（触发一次接口请求），再点「刷新行情」。';
      };

      const goldLabel = (value) => {
        const rounded = Math.round(value * 100) / 100;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
      };

      const syncEmpty = () => {
        emptyEl.hidden = quotes.length > 0 || loading;
      };

      /** 国旗：优先用 summary 里的 avatar 图，加载失败再退回本地 emoji。 */
      const buildFlag = (quote) => {
        const wrap = document.createElement('span');
        wrap.className = 'eh-fx-flag';
        const locale = fxLocale(quote.code);

        const useGlyph = () => {
          const glyph = locale ? locale[1] : '';
          wrap.classList.add('eh-fx-flag--glyph');
          wrap.textContent = glyph;
          // 图没有、本地也没有兜底时不占位，免得留一个空框
          if (!glyph) wrap.hidden = true;
        };

        const src = fxAvatarUrl(quote.avatar);
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
      };

      /** 一行的骨架只建一次，之后数据回来只改内容，转圈动画不会被重建打断。 */
      const buildRow = (quote) => {
        const el = document.createElement('div');
        el.className = 'eh-fx-row';

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

        const spin = document.createElement('span');
        spin.className = 'eh-fx-spin';
        spin.setAttribute('aria-hidden', 'true');
        head.appendChild(spin);

        const prices = document.createElement('div');
        prices.className = 'eh-fx-prices';

        const costs = document.createElement('div');
        const buyEl = document.createElement('div');
        buyEl.className = 'eh-fx-cost';
        const sellEl = document.createElement('div');
        sellEl.className = 'eh-fx-cost';
        costs.appendChild(buyEl);
        costs.appendChild(sellEl);

        el.appendChild(head);
        el.appendChild(prices);
        el.appendChild(costs);

        rows.set(quote.id, { el, spin, prices, costs, buyEl, sellEl });
        listEl.appendChild(el);
      };

      const paintRow = (quote) => {
        const view = rows.get(quote.id);
        if (!view) return;

        const pending = quote.status === 'pending';
        const failed = quote.status === 'error';

        view.spin.hidden = !pending;
        view.el.classList.toggle('is-error', failed);
        view.prices.hidden = pending;
        view.costs.hidden = pending;
        if (pending) return;

        if (failed) {
          view.prices.innerHTML = '<span class="eh-fx-tag eh-fx-tag--idle">挂单拉取失败</span>';
          view.costs.innerHTML = '<div class="eh-fx-cost">稍后点「刷新行情」会重新拉取</div>';
          return;
        }

        const code = escapeHtml(quote.code);
        const ask = quote.asks.length ? quote.asks[0].price : null;
        const bid = quote.bids.length ? quote.bids[0].price : null;
        const buy = fxFill(quote.asks, target);
        const sell = fxFill(quote.bids, target);

        view.prices.innerHTML =
          `<span class="eh-fx-tag ${ask == null ? 'eh-fx-tag--idle' : 'eh-fx-tag--buy'}">买入<b>${fxPrice(ask)}</b></span>` +
          `<span class="eh-fx-tag ${bid == null ? 'eh-fx-tag--idle' : 'eh-fx-tag--sell'}">卖出<b>${fxPrice(bid)}</b></span>`;

        // 吃不满时如实显示实际成交的黄金量，不能让人误以为按目标额度全部成交
        view.buyEl.innerHTML =
          buy.avg == null
            ? '买入：暂无卖单'
            : `买入 <b>${goldLabel(buy.gold)}</b> 金 → <b>${fxQty(buy.currency)}</b> ${code} · 均价 <b>${fxPrice(buy.avg)}</b>` +
              (buy.filled ? '' : ' <span class="eh-fx-deep">深度不足</span>');

        view.sellEl.innerHTML =
          sell.avg == null
            ? '卖出：暂无买单'
            : `卖出 <b>${fxQty(sell.currency)}</b> ${code} → <b>${goldLabel(sell.gold)}</b> 金 · 均价 <b>${fxPrice(sell.avg)}</b>` +
              (sell.filled ? '' : ' <span class="eh-fx-deep">深度不足</span>');
      };

      const addRow = (quote) => {
        quotes.push(quote);
        buildRow(quote);
        paintRow(quote);
      };

      const dropRow = (quote) => {
        const view = rows.get(quote.id);
        if (view) view.el.remove();
        rows.delete(quote.id);
        const index = quotes.indexOf(quote);
        if (index !== -1) quotes.splice(index, 1);
      };

      const clearList = () => {
        rows.forEach((view) => view.el.remove());
        rows.clear();
        quotes = [];
      };

      /** 按买入均价升序；还没拿到数据 / 拉取失败的排最后。 */
      const sortList = () => {
        const keyed = quotes.map((quote) => ({
          quote,
          avg: quote.status === 'ok' ? fxFill(quote.asks, target).avg : null
        }));
        keyed.sort((a, b) => {
          const av = a.avg == null ? Infinity : a.avg;
          const bv = b.avg == null ? Infinity : b.avg;
          if (av !== bv) return av - bv;
          return a.quote.code.localeCompare(b.quote.code);
        });
        quotes = keyed.map((item) => item.quote);
        quotes.forEach((quote) => {
          const view = rows.get(quote.id);
          if (view) listEl.appendChild(view.el);
        });
      };

      /** 本次刷新失败时，把上一次的结果原样放回列表。 */
      const restore = (snapshot) => {
        if (!snapshot || !snapshot.length) return;
        const keep = snapshot.slice();
        clearList();
        keep.forEach(addRow);
        sortList();
      };

      const load = async () => {
        if (loading) return;

        if (market.state !== 'ok') {
          setStatus(tokenHint(), 'warn');
          syncEmpty();
          return;
        }

        const previous = quotes; // 本次失败时用来回滚，别让已有结果凭空消失
        loading = true;
        if (controller) controller.abort();
        controller = new AbortController();
        const signal = controller.signal;
        refreshBtn.disabled = true;
        setStatus('正在读取国家与货币清单…');
        syncEmpty();

        try {
          const countries = await market.call('/countries/summary', { signal });
          const entries = fxCurrencies(countries);
          if (!entries.length) {
            const error = new Error('没有可用的法币清单');
            error.code = 'EMPTY_CURRENCIES';
            throw error;
          }

          const list = entries.map((entry) =>
            Object.assign({}, entry, { asks: null, bids: null, status: 'pending' })
          );
          const total = list.length;
          const failures = [];
          let cursor = 0;
          let done = 0;

          // 先按清单把每行摆出来（右侧带转圈），谁的数据回来就填谁
          clearList();
          list.forEach(addRow);
          syncEmpty();
          ctx.ui.reposition();
          setStatus(`正在拉取挂单 0/${total}…`);

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
              dropRow(quote);
              return;
            }
            quote.asks = book.asks;
            quote.bids = book.bids;
            quote.status = 'ok';
            paintRow(quote);
          };

          const worker = async () => {
            while (cursor < list.length) {
              if (signal.aborted) return;
              const quote = list[cursor];
              cursor += 1;

              try {
                await fetchEntry(quote);
              } catch (err) {
                if (err && err.name === 'AbortError') return;
                if (err && err.code === 'UNAUTHORIZED') throw err;
                quote.status = 'error';
                paintRow(quote);
                failures.push(quote);
              }

              done += 1;
              if (signal.aborted) return;
              setStatus(`正在拉取挂单 ${done}/${total}…`);
              await fxSleep(FX_GAP);
            }
          };

          await Promise.all(Array.from({ length: Math.min(FX_CONCURRENCY, total) }, () => worker()));
          if (signal.aborted) return;

          // 失败多半是瞬时 429 / 5xx：串行补一次，行内转圈重新转起来，仍失败才计入结果
          const retry = failures.splice(0);
          for (let i = 0; i < retry.length; i += 1) {
            if (signal.aborted) return;
            const quote = retry[i];
            setStatus(`正在重试 ${i + 1}/${retry.length}…`);
            quote.status = 'pending';
            paintRow(quote);
            try {
              await fetchEntry(quote);
            } catch (err) {
              if (err && err.name === 'AbortError') return;
              if (err && err.code === 'UNAUTHORIZED') throw err;
              quote.status = 'error';
              paintRow(quote);
              failures.push(quote);
            }
            await fxSleep(FX_GAP * 3);
          }

          sortList();
          const okCount = quotes.filter((quote) => quote.status === 'ok').length;
          const suffix = failures.length ? ` · ${failures.length} 个货币拉取失败` : '';
          setStatus(`${okCount} 种货币有挂单 · 更新于 ${formatClock()}${suffix}`);
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          const code = err && err.code;

          // 有上次结果就放回去；没有则清掉半成品，别让一串转圈一直转下去
          restore(previous);
          if (!previous.length) clearList();

          if (code === 'NO_TOKEN') {
            failStatus(tokenHint(), 'warn');
          } else if (code === 'UNAUTHORIZED') {
            try {
              controller.abort();
            } catch (ignore) {
              /* ignore */
            }
            failStatus(tokenHint(), 'error');
          } else if (code === 'TIMEOUT') {
            failStatus('请求超时，请稍后重试。', 'error');
          } else {
            failStatus('拉取失败：' + (err && err.message ? err.message : '未知错误'), 'error');
          }
        } finally {
          if (alive) {
            loading = false;
            refreshBtn.disabled = false;
            syncEmpty();
            ctx.ui.reposition();
          }
        }
      };

      const applyTarget = () => {
        const value = Number(targetInput.value);
        const valid = Number.isFinite(value) && value > 0;
        target = valid ? value : 10;
        if (!valid) targetInput.value = String(target);
        ctx.storage.set('target', target);
        quotes.forEach((quote) => paintRow(quote));
        // 加载中不动顺序，等收尾统一排，免得边填数边跳行
        if (!loading) sortList();
        ctx.ui.reposition();
      };

      on(targetInput, 'input', () => {
        clearTimeout(targetTimer);
        targetTimer = window.setTimeout(applyTarget, 220);
      });
      on(targetInput, 'change', applyTarget);

      // 面板在 Shadow DOM 内，游戏若在 document 上监听按键，拿到的 target 会被重定向成宿主元素，
      // 很容易被当成「在页面里按键」；这里把输入框的按键拦在组件内部，避免打字误触游戏快捷键。
      ['keydown', 'keypress', 'keyup'].forEach((type) => {
        on(targetInput, type, (event) => event.stopPropagation());
      });

      on(refreshBtn, 'click', () => {
        load();
      });

      if (market.state === 'ok') load();
      else {
        setStatus(tokenHint(), 'warn');
        syncEmpty();
      }

      ctx.onDestroy(() => {
        alive = false;
        clearTimeout(targetTimer);
        if (controller) controller.abort();
      });
    }
  });

  registerFeature({
    id: 'about',
    title: '关于',
    order: 900,
    mount(pane, ctx) {
      pane.innerHTML = `
        <div class="eh-section">
          <div class="eh-h3">插件</div>
          <div class="eh-kv">
            <span>版本</span><b>v${VERSION}</b>
            <span>形态</span><b>油猴用户脚本 · 无外部依赖</b>
            <span>样式隔离</span><b>Shadow DOM</b>
          </div>
          <p class="eh-note">社区自制工具，与 Eclesiar 官方无关。</p>
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
            <a href="https://app.eclesiar.com/" target="_blank" rel="noopener noreferrer">游戏入口</a>
            <a href="https://wiki.eclesiar.com/" target="_blank" rel="noopener noreferrer">官方 Wiki</a>
          </p>
        </div>
        <div class="eh-section">
          <div class="eh-h3">维护</div>
          <p class="eh-note">重置只影响插件保存在浏览器本地的界面设置，不会改动游戏数据。</p>
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

      pane.querySelector('[data-role="reset-ball"]').addEventListener('click', () => {
        ctx.ui.resetBall();
        say('悬浮球位置已重置');
      });

      pane.querySelector('[data-role="reset-all"]').addEventListener('click', () => {
        ctx.ui.resetAll();
        say('已清除本地设置，界面恢复默认');
      });

      ctx.onDestroy(() => clearTimeout(flashTimer));
    }
  });

  /* =========================================================================
   * 10. 启动 / 销毁
   * ========================================================================= */

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  function formatClock() {
    const now = new Date();
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
    route.destroy();
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
      onChange: (fn) => route.subscribe(fn)
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
