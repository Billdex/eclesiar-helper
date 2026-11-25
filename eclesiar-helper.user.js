// ==UserScript==
// @name         Eclesiar 助手
// @name:en      Eclesiar Helper
// @namespace    https://app.eclesiar.com/
// @version      0.1.0
// @description  Eclesiar 经济 / 政治计算辅助插件：悬浮球 + 可展开面板的基础框架。
// @description:en A floating assistant skeleton for Eclesiar (economy & politics helper).
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

  const VERSION = '0.1.0';
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
