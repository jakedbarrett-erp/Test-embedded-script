// intacct-allocation-tool.js — ported entry for the Sage Intacct Allocation
// Tool, running inside an Intacct customization page.
//
// Architecture:
//   1. Page script (in Intacct's customization editor) loads
//      intacct-sage-client.js, then this file.
//   2. This file injects a launcher button into Intacct's page.
//   3. Click → fullscreen overlay opens (95vw × 95vh modal).
//   4. Overlay opens with a loading state, preloads all reference lists via
//      IntacctSageClient, then mounts the React UI.
//   5. Esc or X closes the overlay; localStorage caches list data so re-opens
//      are instant.
//
// CURRENT STATUS: Phase 2 — Frame + Step 1 (Period) + Step 2 (Source pool).
//   • Header with theme toggle (light/dark, persisted)
//   • 4-step navigation indicator
//   • Sidebar layout (336px) with step cards
//   • Step 1: Period selector wired to live Sage data via getPeriods()
//   • Step 2: Source pool — account mode (single/range/multi), GL picker,
//     dimension filters (location required), auto-fetch via getBalances()
//   • Right panel: dynamic — period summary, then balance table with totals
//   Steps 3–4 (Basis, Target/Post) and saved-allocations panel are the next
//   build phases.
//
// Dependencies (all expected to live on the same GitHub Pages origin as this
// file — derived automatically from this script's own src):
//   react.production.min.js          — React 18.2 UMD build
//   react-dom.production.min.js      — ReactDOM 18.2 UMD build
//   htm.umd.js                       — htm@3.1.1 (~1KB tagged-template helper)
//   intacct-sage-client.js           — preloaded by the page script

(function () {
  'use strict';

  // ── IDs & constants ───────────────────────────────────────────────────────
  const STYLE_ID    = 'iat-style';
  const LAUNCHER_ID = 'iat-launcher';
  const OVERLAY_ID  = 'iat-overlay';
  const ROOT_ID     = 'iat-root';
  const THEME_KEY   = 'iat-theme';

  const SELF_SRC = (() => {
    if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    const all = document.querySelectorAll('script[src*="intacct-allocation-tool"]');
    return (all[all.length - 1] && all[all.length - 1].src) || '';
  })();
  const BASE_URL      = SELF_SRC.replace(/[^/]+$/, '');
  const REACT_URL     = BASE_URL + 'react.production.min.js';
  const REACT_DOM_URL = BASE_URL + 'react-dom.production.min.js';
  const HTM_URL       = BASE_URL + 'htm.umd.js';

  if (!window.IntacctSageClient) {
    console.error('[IntacctAllocationTool] IntacctSageClient missing — load intacct-sage-client.js first');
    return;
  }

  // ── Currency formatter (USD default; can be made currency-aware later) ───
  const fmtMoney = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const fmtNum = new Intl.NumberFormat('en-US');

  // ── Styles (scoped under #iat-* and .iat-* — cannot leak into Intacct) ──
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      /* ── Launcher button ──────────────────────────────────────────────── */
      #${LAUNCHER_ID} {
        position: fixed; right: 20px; bottom: 20px; z-index: 999998;
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 16px;
        background: #C87055; color: #fff;
        border: none; border-radius: 100px; cursor: pointer;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
        font-size: 13px; font-weight: 600;
        box-shadow: 0 4px 14px rgba(200,112,85,.35);
        transition: transform .12s ease, box-shadow .12s ease;
      }
      #${LAUNCHER_ID}:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(200,112,85,.45); }
      #${LAUNCHER_ID} .iat-launcher-icon {
        width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
        background: rgba(255,255,255,.15); border-radius: 4px; font-size: 11px; font-weight: 700;
      }

      /* ── Overlay shell ────────────────────────────────────────────────── */
      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 999999;
        background: rgba(15, 15, 20, 0.55);
        backdrop-filter: blur(2px);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
      }
      #${OVERLAY_ID} .iat-modal {
        width: 95vw; height: 95vh;
        background: var(--iat-bg, #fff);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,.35);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: iat-modal-in .15s ease-out;
      }
      @keyframes iat-modal-in {
        from { opacity: 0; transform: scale(0.98); }
        to   { opacity: 1; transform: scale(1); }
      }

      /* ── Theme variables ──────────────────────────────────────────────── */
      .iat-app {
        --iat-bg:        #ffffff;
        --iat-bg-soft:   #fafafa;
        --iat-bg-card:   #ffffff;
        --iat-fg:        #18181b;
        --iat-fg-soft:   #52525b;
        --iat-fg-muted:  #a1a1aa;
        --iat-border:    #e4e4e7;
        --iat-border-soft:#f4f4f5;
        --iat-accent:    #C87055;
        --iat-accent-soft:rgba(200,112,85,.10);
        --iat-success:   #16a34a;
        --iat-success-soft:#f0fdf4;
        --iat-warning:   #92400e;
        --iat-warning-soft:#fef3c7;
        --iat-danger:    #dc2626;
        --iat-danger-soft:#fef2f2;
      }
      .iat-app[data-theme="dark"] {
        --iat-bg:        #0a0a0b;
        --iat-bg-soft:   #18181b;
        --iat-bg-card:   #161618;
        --iat-fg:        #fafafa;
        --iat-fg-soft:   #a1a1aa;
        --iat-fg-muted:  #71717a;
        --iat-border:    #27272a;
        --iat-border-soft:#1f1f22;
        --iat-accent:    #e8956d;
        --iat-accent-soft:rgba(232,149,109,.18);
        --iat-success-soft:rgba(22,163,74,.12);
        --iat-warning-soft:rgba(146,64,14,.18);
        --iat-danger-soft:rgba(220,38,38,.12);
      }

      /* ── App layout ──────────────────────────────────────────────────── */
      .iat-app {
        flex: 1;
        display: flex; flex-direction: column;
        background: var(--iat-bg);
        color: var(--iat-fg);
        overflow: hidden;
      }
      .iat-app-header {
        display: flex; align-items: center; gap: 14px;
        padding: 12px 20px;
        border-bottom: 1px solid var(--iat-border);
        background: var(--iat-bg-soft);
        flex-shrink: 0;
      }
      .iat-app-icon {
        width: 28px; height: 28px; border-radius: 6px;
        background: var(--iat-accent); color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 13px;
      }
      .iat-app-title {
        flex: 1; font-size: 15px; font-weight: 600; letter-spacing: -0.2px; color: var(--iat-fg);
      }
      .iat-app-title-sub {
        font-size: 12px; color: var(--iat-fg-muted); font-weight: 400; margin-left: 8px;
      }
      .iat-app-actions { display: flex; gap: 8px; }
      .iat-icon-btn {
        width: 32px; height: 32px;
        border: 1px solid var(--iat-border); background: var(--iat-bg-card);
        color: var(--iat-fg-soft); cursor: pointer; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 14px; line-height: 1;
        transition: background .12s, border-color .12s, color .12s;
      }
      .iat-icon-btn:hover { background: var(--iat-bg-soft); color: var(--iat-fg); border-color: var(--iat-fg-muted); }
      .iat-close-btn {
        width: 32px; height: 32px; border: 1px solid var(--iat-border); background: var(--iat-bg-card);
        color: var(--iat-fg-soft); cursor: pointer; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 16px; line-height: 1;
      }
      .iat-close-btn:hover { background: var(--iat-bg-soft); color: var(--iat-fg); }

      /* ── Body grid ────────────────────────────────────────────────────── */
      .iat-app-body {
        flex: 1;
        display: grid; grid-template-columns: 336px 1fr;
        overflow: hidden;
      }
      .iat-sidebar {
        border-right: 1px solid var(--iat-border);
        background: var(--iat-bg-soft);
        overflow-y: auto;
        padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
      }
      .iat-content {
        background: var(--iat-bg);
        overflow-y: auto;
        padding: 24px 28px;
      }

      /* ── Step indicator ───────────────────────────────────────────────── */
      .iat-stepnav {
        display: flex; align-items: center; gap: 6px;
        padding: 10px 14px;
        background: var(--iat-bg-card);
        border: 1px solid var(--iat-border);
        border-radius: 8px;
        margin-bottom: 4px;
      }
      .iat-stepnav-dot {
        width: 22px; height: 22px; border-radius: 50%;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        color: var(--iat-fg-muted);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700;
        transition: all .15s;
      }
      .iat-stepnav-dot.active { background: var(--iat-accent); border-color: var(--iat-accent); color: #fff; }
      .iat-stepnav-dot.done   { background: var(--iat-accent-soft); border-color: var(--iat-accent); color: var(--iat-accent); }
      .iat-stepnav-line {
        flex: 1; height: 2px; background: var(--iat-border);
        border-radius: 1px;
      }
      .iat-stepnav-line.done { background: var(--iat-accent); }

      /* ── Step card ────────────────────────────────────────────────────── */
      .iat-step {
        background: var(--iat-bg-card);
        border: 1px solid var(--iat-border);
        border-radius: 8px;
        padding: 12px 14px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .iat-step.active { border-color: var(--iat-accent); box-shadow: 0 0 0 3px var(--iat-accent-soft); }
      .iat-step-head { display: flex; align-items: center; gap: 10px; }
      .iat-step-num {
        width: 22px; height: 22px; border-radius: 50%;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        color: var(--iat-fg-soft);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700;
        flex-shrink: 0;
      }
      .iat-step.active .iat-step-num { background: var(--iat-accent); border-color: var(--iat-accent); color: #fff; }
      .iat-step.done   .iat-step-num { background: var(--iat-accent-soft); border-color: var(--iat-accent); color: var(--iat-accent); }
      .iat-step-title {
        font-size: 13px; font-weight: 600; color: var(--iat-fg); flex: 1;
        letter-spacing: -0.1px;
      }
      .iat-step-status { font-size: 11px; color: var(--iat-fg-muted); }
      .iat-step-body { display: flex; flex-direction: column; gap: 10px; }
      .iat-step-section {
        display: flex; flex-direction: column; gap: 6px;
      }
      .iat-step-section + .iat-step-section {
        margin-top: 4px;
        padding-top: 10px;
        border-top: 1px solid var(--iat-border-soft);
      }

      /* ── Form controls ────────────────────────────────────────────────── */
      .iat-label {
        font-size: 11px; font-weight: 600; color: var(--iat-fg-soft);
        text-transform: uppercase; letter-spacing: .04em;
      }
      .iat-label-req::after { content: ' *'; color: var(--iat-danger); }
      .iat-select, .iat-input {
        width: 100%;
        padding: 8px 10px;
        background: var(--iat-bg);
        border: 1px solid var(--iat-border);
        border-radius: 6px;
        color: var(--iat-fg);
        font-size: 13px; font-family: inherit;
        cursor: pointer;
        transition: border-color .12s, box-shadow .12s;
        box-sizing: border-box;
      }
      .iat-input { cursor: text; }
      .iat-select:hover, .iat-input:hover { border-color: var(--iat-fg-muted); }
      .iat-select:focus, .iat-input:focus { outline: none; border-color: var(--iat-accent); box-shadow: 0 0 0 3px var(--iat-accent-soft); }
      .iat-readout {
        margin-top: 4px;
        padding: 8px 10px;
        background: var(--iat-bg-soft);
        border: 1px solid var(--iat-border-soft);
        border-radius: 6px;
        font-size: 12px;
        color: var(--iat-fg-soft);
      }
      .iat-readout-strong { color: var(--iat-fg); font-weight: 500; }

      /* ── Segmented control (mode toggle) ─────────────────────────────── */
      .iat-seg {
        display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
        background: var(--iat-bg-soft);
        border: 1px solid var(--iat-border);
        border-radius: 6px;
        padding: 2px;
        gap: 2px;
      }
      .iat-seg-btn {
        background: transparent; border: none;
        padding: 6px 10px;
        font-size: 12px; font-weight: 500; color: var(--iat-fg-soft);
        cursor: pointer; border-radius: 4px;
        font-family: inherit;
        transition: background .12s, color .12s;
      }
      .iat-seg-btn:hover { color: var(--iat-fg); }
      .iat-seg-btn.active {
        background: var(--iat-bg); color: var(--iat-fg);
        box-shadow: 0 1px 2px rgba(0,0,0,.06);
      }

      /* ── Range inputs (two-up) ────────────────────────────────────────── */
      .iat-range-row {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
      }

      /* ── Multi-select checkbox list ──────────────────────────────────── */
      .iat-multilist {
        max-height: 200px; overflow-y: auto;
        border: 1px solid var(--iat-border);
        border-radius: 6px;
        background: var(--iat-bg);
      }
      .iat-multilist-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        font-size: 12px; color: var(--iat-fg);
        cursor: pointer;
        border-bottom: 1px solid var(--iat-border-soft);
      }
      .iat-multilist-row:last-child { border-bottom: none; }
      .iat-multilist-row:hover { background: var(--iat-bg-soft); }
      .iat-multilist-row input { margin: 0; cursor: pointer; }
      .iat-multilist-meta {
        font-size: 11px; color: var(--iat-fg-muted);
        padding: 6px 10px 0;
      }
      .iat-multilist-search {
        padding: 6px 10px;
        border-bottom: 1px solid var(--iat-border-soft);
      }
      .iat-multilist-search input {
        width: 100%; padding: 4px 8px;
        border: 1px solid var(--iat-border); border-radius: 4px;
        background: var(--iat-bg); color: var(--iat-fg);
        font-size: 12px; font-family: inherit;
        box-sizing: border-box;
      }

      /* ── Right-panel placeholder ──────────────────────────────────────── */
      .iat-content-empty {
        height: 100%;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        text-align: center; gap: 10px; padding: 40px;
        color: var(--iat-fg-muted);
      }
      .iat-content-empty-icon {
        width: 48px; height: 48px; border-radius: 50%;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        display: flex; align-items: center; justify-content: center;
        font-size: 18px; color: var(--iat-fg-muted);
      }
      .iat-content-empty-title { font-size: 14px; color: var(--iat-fg-soft); font-weight: 500; }
      .iat-content-empty-detail { font-size: 12px; max-width: 360px; line-height: 1.5; }

      /* ── Content panel headings & sections ───────────────────────────── */
      .iat-panel-h1 { font-size: 18px; font-weight: 600; color: var(--iat-fg); margin: 0 0 4px; letter-spacing: -0.3px; }
      .iat-panel-sub { font-size: 13px; color: var(--iat-fg-soft); margin: 0 0 20px; }
      .iat-panel-section + .iat-panel-section { margin-top: 24px; }
      .iat-panel-h2 { font-size: 13px; font-weight: 600; color: var(--iat-fg-soft); margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; }

      /* ── Balance table ───────────────────────────────────────────────── */
      .iat-table {
        width: 100%; border-collapse: collapse; font-size: 13px;
        background: var(--iat-bg-card);
        border: 1px solid var(--iat-border);
        border-radius: 8px; overflow: hidden;
      }
      .iat-table thead th {
        text-align: left;
        padding: 10px 14px;
        background: var(--iat-bg-soft);
        border-bottom: 1px solid var(--iat-border);
        font-size: 11px; font-weight: 600; color: var(--iat-fg-soft);
        text-transform: uppercase; letter-spacing: .04em;
      }
      .iat-table tbody td {
        padding: 10px 14px;
        border-bottom: 1px solid var(--iat-border-soft);
        color: var(--iat-fg);
      }
      .iat-table tbody tr:last-child td { border-bottom: none; }
      .iat-table tbody tr:hover { background: var(--iat-bg-soft); }
      .iat-table .iat-num {
        font-variant-numeric: tabular-nums;
        text-align: right;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .iat-table tfoot td {
        padding: 10px 14px;
        background: var(--iat-bg-soft);
        border-top: 2px solid var(--iat-border);
        font-weight: 600; color: var(--iat-fg);
      }

      /* ── Filter chips ────────────────────────────────────────────────── */
      .iat-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .iat-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px;
        background: var(--iat-accent-soft); color: var(--iat-accent);
        border-radius: 100px;
        font-size: 11px; font-weight: 500;
      }
      .iat-chip-key { color: var(--iat-fg-muted); font-weight: 400; margin-right: 2px; }

      /* ── Loading & error states ───────────────────────────────────────── */
      .iat-loading {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        height: 100%; gap: 14px; color: var(--iat-fg-soft, #52525b);
      }
      .iat-spinner {
        width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid var(--iat-border, #e4e4e7); border-top-color: var(--iat-accent, #C87055);
        animation: iat-spin 0.8s linear infinite;
      }
      .iat-spinner-sm { width: 16px; height: 16px; border-width: 2px; display: inline-block; vertical-align: middle; }
      @keyframes iat-spin { to { transform: rotate(360deg); } }
      .iat-loading-msg { font-size: 13px; }
      .iat-loading-detail { font-size: 11px; color: var(--iat-fg-muted, #a1a1aa); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      .iat-inline-loading {
        display: flex; align-items: center; gap: 10px;
        padding: 16px; color: var(--iat-fg-soft);
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        border-radius: 8px; font-size: 13px;
      }

      .iat-error {
        margin: 32px 0; padding: 16px;
        background: var(--iat-danger-soft, #fef2f2); border: 1px solid #fecaca; border-radius: 8px;
        color: var(--iat-danger, #991b1b);
      }
      .iat-error-title { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
      .iat-error-detail { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; white-space: pre-wrap; }

      .iat-warning {
        margin: 12px 0; padding: 12px;
        background: var(--iat-warning-soft, #fef3c7); border: 1px solid #fde68a; border-radius: 6px;
        color: var(--iat-warning, #92400e);
        font-size: 12px;
      }
    `;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Dependency loader ─────────────────────────────────────────────────────
  function loadOnce(url) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-iat-src="' + url + '"]');
      if (existing) {
        if (existing.dataset.iatLoaded === '1') return resolve();
        existing.addEventListener('load',  () => resolve());
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = url;
      s.dataset.iatSrc = url;
      s.onload  = () => { s.dataset.iatLoaded = '1'; resolve(); };
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }
  async function ensureDeps() {
    if (!window.React)    await loadOnce(REACT_URL);
    if (!window.ReactDOM) await loadOnce(REACT_DOM_URL);
    if (!window.htm)      await loadOnce(HTM_URL);
  }

  // ── Launcher ──────────────────────────────────────────────────────────────
  function renderLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return;
    const btn = document.createElement('button');
    btn.id = LAUNCHER_ID;
    btn.type = 'button';
    btn.innerHTML = '<span class="iat-launcher-icon">A</span><span>Allocation Tool</span>';
    btn.addEventListener('click', openOverlay);
    document.body.appendChild(btn);
  }

  // ── Overlay ──────────────────────────────────────────────────────────────
  let escListener = null;

  function openOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = '<div class="iat-modal" role="dialog" aria-modal="true" aria-label="Allocation Tool"><div id="' + ROOT_ID + '" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div></div>';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    document.body.appendChild(overlay);

    escListener = (e) => { if (e.key === 'Escape') closeOverlay(); };
    document.addEventListener('keydown', escListener);

    bootstrapApp();
  }

  function closeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  async function bootstrapApp() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    root.innerHTML =
      '<div class="iat-loading">' +
        '<div class="iat-spinner"></div>' +
        '<div class="iat-loading-msg" data-loading-msg>Loading dependencies…</div>' +
        '<div class="iat-loading-detail" data-loading-detail></div>' +
      '</div>';
    const setMsg    = (m) => { const el = root.querySelector('[data-loading-msg]');    if (el) el.textContent = m; };
    const setDetail = (m) => { const el = root.querySelector('[data-loading-detail]'); if (el) el.textContent = m; };

    try {
      await ensureDeps();
      setMsg('Loading Intacct reference data…');

      const C = window.IntacctSageClient;
      const labels = ['departments', 'locations', 'projects', 'classes', 'GL accounts', 'stat accounts', 'periods', 'journals'];
      let done = 0;
      const tick = (label) => () => { done += 1; setDetail(done + ' / ' + labels.length + ' · ' + label); };
      const [departments, locations, projects, classes, glAccounts, statAccounts, periods, journals] =
        await Promise.all([
          C.getDepartments() .then(r => (tick('departments')(),    r)),
          C.getLocations()   .then(r => (tick('locations')(),      r)),
          C.getProjects()    .then(r => (tick('projects')(),       r)),
          C.getClasses()     .then(r => (tick('classes')(),        r)),
          C.getGlAccounts()  .then(r => (tick('GL accounts')(),    r)),
          C.getStatAccounts().then(r => (tick('stat accounts')(),  r)),
          C.getPeriods()     .then(r => (tick('periods')(),        r)),
          C.getJournals()    .then(r => (tick('journals')(),       r)),
        ]);

      const data = { departments, locations, projects, classes, glAccounts, statAccounts, periods, journals };
      window.__intacctAllocationData = data;
      mountReactApp(root, data);
    } catch (err) {
      console.error('[IntacctAllocationTool] bootstrap failed:', err);
      root.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'iat-error';
      const safe = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      box.innerHTML =
        '<div class="iat-error-title">Failed to load reference data</div>' +
        '<div class="iat-error-detail">' + safe(err && err.message) + '</div>';
      root.appendChild(box);
    }
  }

  // ── React app ────────────────────────────────────────────────────────────
  function mountReactApp(rootEl, data) {
    const React    = window.React;
    const ReactDOM = window.ReactDOM;
    const htm      = window.htm;
    const html     = htm.bind(React.createElement);
    const { useState, useMemo, useEffect } = React;

    // "Any" sentinel for optional dimension filters — we send undefined to
    // the Sage client when this is selected.
    const ANY = '';

    function App() {
      // Phase 1: theme + step nav + period
      const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
      const [activeStep, setActiveStep] = useState(1);
      const [periodName, setPeriodName] = useState('');

      // Phase 2: source pool selection
      const [sourceMode, setSourceMode]         = useState('single'); // 'single' | 'range' | 'multi'
      const [sourceGL, setSourceGL]             = useState('');
      const [rangeFrom, setRangeFrom]           = useState('');
      const [rangeTo, setRangeTo]               = useState('');
      const [multiAccounts, setMultiAccounts]   = useState([]); // array of GL ids
      const [multiSearch, setMultiSearch]       = useState('');
      const [sourceLoc, setSourceLoc]           = useState(ANY);
      const [sourceDept, setSourceDept]         = useState(ANY);
      const [sourceClass, setSourceClass]       = useState(ANY);
      const [sourceProj, setSourceProj]         = useState(ANY);

      // Phase 2: source balance results
      const [sourceBalances, setSourceBalances] = useState([]);
      const [sourceLoading, setSourceLoading]   = useState(false);
      const [sourceError, setSourceError]       = useState(null);
      const [sourceFetched, setSourceFetched]   = useState(false);

      useEffect(() => { localStorage.setItem(THEME_KEY, theme); }, [theme]);

      const selectedPeriod = useMemo(
        () => data.periods.find(p => p.name === periodName) || null,
        [periodName]
      );

      // Build the params object for IntacctSageClient.getBalances. Returns
      // null if the inputs aren't yet sufficient to fetch (no period, no
      // location, or no account selection). Acts as the validity gate.
      const sourceParams = useMemo(() => {
        if (!selectedPeriod || !sourceLoc) return null;
        let acc = null;
        if (sourceMode === 'single') {
          if (!sourceGL) return null;
          acc = { accountMode: 'single', accountNo: sourceGL };
        } else if (sourceMode === 'range') {
          if (!rangeFrom || !rangeTo) return null;
          acc = { accountMode: 'range', startAccountNo: rangeFrom, endAccountNo: rangeTo };
        } else {
          if (!multiAccounts.length) return null;
          acc = { accountMode: 'multi', accounts: multiAccounts };
        }
        return Object.assign({
          startDate:    selectedPeriod.startDate,
          endDate:      selectedPeriod.endDate,
          locationid:   sourceLoc,
          departmentid: sourceDept || undefined,
          classid:      sourceClass || undefined,
          projectid:    sourceProj || undefined,
        }, acc);
      }, [selectedPeriod, sourceMode, sourceGL, rangeFrom, rangeTo, multiAccounts, sourceLoc, sourceDept, sourceClass, sourceProj]);

      // Auto-fetch balances when params become valid (or change). Use cancel
      // flag so a stale response from a prior request can't overwrite a
      // newer one.
      useEffect(() => {
        if (!sourceParams) {
          setSourceBalances([]);
          setSourceFetched(false);
          setSourceError(null);
          return;
        }
        let cancelled = false;
        setSourceLoading(true);
        setSourceError(null);
        window.IntacctSageClient.getBalances(sourceParams).then(rows => {
          if (cancelled) return;
          setSourceBalances(rows);
          setSourceFetched(true);
          setSourceLoading(false);
        }).catch(err => {
          if (cancelled) return;
          setSourceError(err && err.message || String(err));
          setSourceLoading(false);
        });
        return () => { cancelled = true; };
      }, [sourceParams]);

      const sourceTotal = useMemo(
        () => sourceBalances.reduce((sum, r) => sum + (r.periodbalance || 0), 0),
        [sourceBalances]
      );

      // Step completion: 1 done when period picked; 2 done when fetched
      const stepDone = useMemo(() => ({
        1: !!periodName,
        2: sourceFetched && sourceBalances.length > 0,
      }), [periodName, sourceFetched, sourceBalances.length]);

      const stepStatus = (n) => {
        if (stepDone[n]) return 'done';
        if (n === activeStep) return 'active';
        return '';
      };

      const onPickPeriod = (e) => {
        const v = e.target.value;
        setPeriodName(v);
        if (v && activeStep === 1) setActiveStep(2);
      };

      const ctx = {
        data, html, React,
        sourceMode, setSourceMode,
        sourceGL, setSourceGL,
        rangeFrom, setRangeFrom, rangeTo, setRangeTo,
        multiAccounts, setMultiAccounts, multiSearch, setMultiSearch,
        sourceLoc, setSourceLoc, sourceDept, setSourceDept,
        sourceClass, setSourceClass, sourceProj, setSourceProj,
        sourceBalances, sourceLoading, sourceError, sourceFetched, sourceTotal,
        sourceParams, selectedPeriod,
      };

      return html`
        <div class="iat-app" data-theme=${theme}>
          <header class="iat-app-header">
            <div class="iat-app-icon">A</div>
            <div class="iat-app-title">
              Allocation Tool
              <span class="iat-app-title-sub">Phase 2 · Source pool</span>
            </div>
            <div class="iat-app-actions">
              <button
                class="iat-icon-btn"
                type="button"
                title=${theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >${theme === 'dark' ? '☀' : '☾'}</button>
              <button class="iat-close-btn" type="button" aria-label="Close" onClick=${closeOverlay}>×</button>
            </div>
          </header>

          <div class="iat-app-body">
            <aside class="iat-sidebar">
              <${StepNav} activeStep=${activeStep} done=${stepDone} />

              <${StepCard}
                num=${1}
                title="Period"
                status=${stepStatus(1)}
                onActivate=${() => setActiveStep(1)}
              >
                <label class="iat-label" for="iat-period-select">Reporting period</label>
                <select id="iat-period-select" class="iat-select" value=${periodName} onChange=${onPickPeriod}>
                  <option value="">— select a period —</option>
                  ${data.periods.map(p => html`<option key=${p.name} value=${p.name}>${p.name}</option>`)}
                </select>
                ${selectedPeriod ? html`
                  <div class="iat-readout">
                    <span class="iat-readout-strong">${selectedPeriod.name}</span>
                    <br/>${selectedPeriod.startDate} → ${selectedPeriod.endDate}
                  </div>
                ` : null}
              <//>

              <${StepCard}
                num=${2}
                title="Source pool"
                status=${stepStatus(2)}
                onActivate=${() => periodName && setActiveStep(2)}
                disabled=${!periodName}
              >
                <${SourceStepBody} ctx=${ctx} />
              <//>

              <${StepCard}
                num=${3}
                title="Allocation basis"
                status=${stepStatus(3)}
                onActivate=${() => stepDone[2] && setActiveStep(3)}
                disabled=${!stepDone[2]}
              >
                <div class="iat-step-status">${stepDone[2] ? 'Coming in Phase 3' : 'Complete the source pool first'}</div>
              <//>

              <${StepCard}
                num=${4}
                title="Target & post"
                status=${stepStatus(4)}
                onActivate=${() => stepDone[2] && setActiveStep(4)}
                disabled=${!stepDone[2]}
              >
                <div class="iat-step-status">Coming in Phase 4</div>
              <//>
            </aside>

            <main class="iat-content">
              <${ContentPanel} activeStep=${activeStep} ctx=${ctx} />
            </main>
          </div>
        </div>
      `;
    }

    // Step indicator across the top of the sidebar.
    function StepNav({ activeStep, done }) {
      const dots = [1, 2, 3, 4].map(n => {
        const cls = ['iat-stepnav-dot'];
        if (done && done[n]) cls.push('done');
        if (n === activeStep) cls.push('active');
        return html`<span key=${'d' + n} class=${cls.join(' ')}>${done && done[n] ? '✓' : n}</span>`;
      });
      const items = [];
      for (let i = 0; i < dots.length; i++) {
        items.push(dots[i]);
        if (i < dots.length - 1) {
          const lineDone = done && done[i + 1];
          items.push(html`<span key=${'l' + i} class=${'iat-stepnav-line' + (lineDone ? ' done' : '')}></span>`);
        }
      }
      return html`<div class="iat-stepnav">${items}</div>`;
    }

    function StepCard({ num, title, status, onActivate, disabled, children }) {
      const cls = 'iat-step' + (status === 'active' ? ' active' : status === 'done' ? ' done' : '');
      const handleClick = (e) => {
        if (disabled) return;
        const tag = e.target.tagName;
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'LABEL' || tag === 'TEXTAREA') return;
        if (onActivate) onActivate();
      };
      return html`
        <section class=${cls} onClick=${handleClick} style=${{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
          <div class="iat-step-head">
            <div class="iat-step-num">${status === 'done' ? '✓' : num}</div>
            <div class="iat-step-title">${title}</div>
          </div>
          <div class="iat-step-body">${children}</div>
        </section>
      `;
    }

    // ── Step 2 sidebar body: mode toggle + GL picker(s) + dim filters ────
    function SourceStepBody({ ctx }) {
      const { data, sourceMode, setSourceMode } = ctx;

      return html`
        <div class="iat-step-section">
          <span class="iat-label">Account selection</span>
          <div class="iat-seg">
            ${['single', 'range', 'multi'].map(m => html`
              <button
                key=${m}
                type="button"
                class=${'iat-seg-btn' + (sourceMode === m ? ' active' : '')}
                onClick=${() => setSourceMode(m)}
              >${m === 'single' ? 'Single' : m === 'range' ? 'Range' : 'Multi'}</button>
            `)}
          </div>
          ${sourceMode === 'single'  ? html`<${SingleGLPicker} ctx=${ctx} />` : null}
          ${sourceMode === 'range'   ? html`<${RangeGLPicker}  ctx=${ctx} />` : null}
          ${sourceMode === 'multi'   ? html`<${MultiGLPicker}  ctx=${ctx} />` : null}
        </div>

        <div class="iat-step-section">
          <span class="iat-label">Dimension filters</span>
          <label class="iat-label iat-label-req" for="iat-src-loc" style=${{ marginTop: '4px' }}>Location</label>
          <${DimSelect} id="iat-src-loc" rows=${data.locations} value=${ctx.sourceLoc}     onChange=${ctx.setSourceLoc}     placeholder="— select location —" />
          <label class="iat-label" for="iat-src-dept" style=${{ marginTop: '4px' }}>Department</label>
          <${DimSelect} id="iat-src-dept" rows=${data.departments} value=${ctx.sourceDept}  onChange=${ctx.setSourceDept}    placeholder="Any" />
          <label class="iat-label" for="iat-src-cls" style=${{ marginTop: '4px' }}>Class</label>
          <${DimSelect} id="iat-src-cls" rows=${data.classes}     value=${ctx.sourceClass} onChange=${ctx.setSourceClass}   placeholder="Any" />
          <label class="iat-label" for="iat-src-prj" style=${{ marginTop: '4px' }}>Project</label>
          <${DimSelect} id="iat-src-prj" rows=${data.projects}    value=${ctx.sourceProj}  onChange=${ctx.setSourceProj}    placeholder="Any" />
        </div>
      `;
    }

    function SingleGLPicker({ ctx }) {
      const { data, sourceGL, setSourceGL } = ctx;
      return html`
        <select class="iat-select" value=${sourceGL} onChange=${(e) => setSourceGL(e.target.value)}>
          <option value="">— select GL account —</option>
          ${data.glAccounts.map(g => html`<option key=${g.id} value=${g.id}>${g.id} · ${g.name}</option>`)}
        </select>
      `;
    }

    function RangeGLPicker({ ctx }) {
      const { rangeFrom, setRangeFrom, rangeTo, setRangeTo } = ctx;
      return html`
        <div class="iat-range-row">
          <input class="iat-input" placeholder="From" value=${rangeFrom} onChange=${(e) => setRangeFrom(e.target.value)} />
          <input class="iat-input" placeholder="To"   value=${rangeTo}   onChange=${(e) => setRangeTo(e.target.value)} />
        </div>
      `;
    }

    function MultiGLPicker({ ctx }) {
      const { data, multiAccounts, setMultiAccounts, multiSearch, setMultiSearch } = ctx;
      const filtered = useMemo(() => {
        const q = multiSearch.trim().toLowerCase();
        if (!q) return data.glAccounts;
        return data.glAccounts.filter(g =>
          (g.id || '').toLowerCase().includes(q) ||
          (g.name || '').toLowerCase().includes(q)
        );
      }, [multiSearch]);
      const set = new Set(multiAccounts);
      const toggle = (id) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id); else next.add(id);
        setMultiAccounts(Array.from(next));
      };
      return html`
        <div class="iat-multilist">
          <div class="iat-multilist-search">
            <input
              type="search"
              placeholder="Filter ${fmtNum.format(data.glAccounts.length)} accounts…"
              value=${multiSearch}
              onChange=${(e) => setMultiSearch(e.target.value)}
            />
          </div>
          ${filtered.slice(0, 200).map(g => html`
            <label key=${g.id} class="iat-multilist-row">
              <input type="checkbox" checked=${set.has(g.id)} onChange=${() => toggle(g.id)} />
              <span style=${{ flex: 1 }}>${g.id} · ${g.name}</span>
            </label>
          `)}
          ${filtered.length > 200 ? html`<div class="iat-multilist-meta">Showing first 200 of ${fmtNum.format(filtered.length)} matches — refine search to see more.</div>` : null}
        </div>
        <div class="iat-multilist-meta">${multiAccounts.length} selected</div>
      `;
    }

    // Reusable dimension dropdown (Location / Dept / Class / Project) —
    // empty value means "any" / no filter.
    function DimSelect({ id, rows, value, onChange, placeholder }) {
      return html`
        <select id=${id} class="iat-select" value=${value} onChange=${(e) => onChange(e.target.value)}>
          <option value="">${placeholder}</option>
          ${rows.map(r => html`<option key=${r.id} value=${r.id}>${r.id} · ${r.name}</option>`)}
        </select>
      `;
    }

    // ── Right panel content dispatcher ───────────────────────────────────
    function ContentPanel({ activeStep, ctx }) {
      const { selectedPeriod, data } = ctx;

      if (!selectedPeriod) {
        return html`
          <div class="iat-content-empty">
            <div class="iat-content-empty-icon">①</div>
            <div class="iat-content-empty-title">Select a period to begin</div>
            <div class="iat-content-empty-detail">
              Pick a reporting period in the sidebar. Subsequent steps unlock once a period is selected.
            </div>
          </div>
        `;
      }

      // Step 1 selected & active → period summary
      if (activeStep === 1) {
        return html`
          <div style=${{ maxWidth: '720px' }}>
            <h2 class="iat-panel-h1">${selectedPeriod.name}</h2>
            <p class="iat-panel-sub">${selectedPeriod.startDate} → ${selectedPeriod.endDate}</p>
            <div class="iat-readout">Period selected. Move to <strong>Step 2</strong> to choose the source pool.</div>
            <div style=${{ marginTop: '12px', fontSize: '11px', color: 'var(--iat-fg-muted)' }}>
              Reference data:&nbsp;
              ${fmtNum.format(data.glAccounts.length)} GL · ${fmtNum.format(data.statAccounts.length)} stat ·
              ${fmtNum.format(data.departments.length)} depts · ${fmtNum.format(data.locations.length)} locs ·
              ${fmtNum.format(data.projects.length)} projects · ${fmtNum.format(data.classes.length)} classes ·
              ${fmtNum.format(data.periods.length)} periods · ${fmtNum.format(data.journals.length)} journals
            </div>
          </div>
        `;
      }

      // Step 2 active → source pool & balance results
      if (activeStep === 2) {
        return html`<${SourceContentPanel} ctx=${ctx} />`;
      }

      // Steps 3+ — placeholders for now
      return html`
        <div class="iat-content-empty">
          <div class="iat-content-empty-icon">${activeStep}</div>
          <div class="iat-content-empty-title">Step ${activeStep} — coming in a later phase</div>
          <div class="iat-content-empty-detail">This phase is built out incrementally. Phase 3 wires up the basis selection; Phase 4 adds target GL and the journal posting flow.</div>
        </div>
      `;
    }

    // Step 2 right-panel: source summary + balance table
    function SourceContentPanel({ ctx }) {
      const {
        selectedPeriod, sourceParams, sourceBalances, sourceLoading, sourceError, sourceFetched, sourceTotal,
        sourceMode, sourceGL, rangeFrom, rangeTo, multiAccounts,
        sourceLoc, sourceDept, sourceClass, sourceProj, data,
      } = ctx;

      const dimChip = (label, id, list) => {
        if (!id) return null;
        const row = list.find(r => r.id === id);
        const name = row ? row.name : id;
        return html`<span class="iat-chip"><span class="iat-chip-key">${label}</span>${name}</span>`;
      };

      const accountChips = (() => {
        if (sourceMode === 'single' && sourceGL) {
          const row = data.glAccounts.find(g => g.id === sourceGL);
          return html`<span class="iat-chip"><span class="iat-chip-key">GL</span>${sourceGL}${row ? ' · ' + row.name : ''}</span>`;
        }
        if (sourceMode === 'range' && rangeFrom && rangeTo) {
          return html`<span class="iat-chip"><span class="iat-chip-key">Range</span>${rangeFrom} → ${rangeTo}</span>`;
        }
        if (sourceMode === 'multi' && multiAccounts.length) {
          return html`<span class="iat-chip"><span class="iat-chip-key">Multi</span>${multiAccounts.length} accounts</span>`;
        }
        return null;
      })();

      return html`
        <div style=${{ maxWidth: '900px' }}>
          <h2 class="iat-panel-h1">Source pool</h2>
          <p class="iat-panel-sub">${selectedPeriod.name} · ${selectedPeriod.startDate} → ${selectedPeriod.endDate}</p>

          <div class="iat-chip-row">
            ${accountChips}
            ${dimChip('Location',   sourceLoc,   data.locations)}
            ${dimChip('Department', sourceDept,  data.departments)}
            ${dimChip('Class',      sourceClass, data.classes)}
            ${dimChip('Project',    sourceProj,  data.projects)}
          </div>

          ${!sourceParams ? html`
            <div class="iat-warning" style=${{ marginTop: '20px' }}>
              ${ !sourceLoc
                  ? 'Pick a location to fetch balances. Location is required for the source pool.'
                  : sourceMode === 'single' && !sourceGL ? 'Pick a GL account.'
                  : sourceMode === 'range'  && (!rangeFrom || !rangeTo) ? 'Enter both range endpoints.'
                  : sourceMode === 'multi'  && !multiAccounts.length ? 'Select at least one GL account.'
                  : 'Complete the source pool inputs to fetch balances.' }
            </div>
          ` : sourceLoading ? html`
            <div class="iat-inline-loading" style=${{ marginTop: '20px' }}>
              <span class="iat-spinner iat-spinner-sm"></span>
              <span>Fetching balances from Sage…</span>
            </div>
          ` : sourceError ? html`
            <div class="iat-error">
              <div class="iat-error-title">Balance fetch failed</div>
              <div class="iat-error-detail">${sourceError}</div>
            </div>
          ` : sourceFetched ? html`
            <div class="iat-panel-section">
              <h3 class="iat-panel-h2">Balances · ${fmtNum.format(sourceBalances.length)} ${sourceBalances.length === 1 ? 'row' : 'rows'}</h3>
              ${sourceBalances.length === 0 ? html`
                <div class="iat-readout">No balances returned for this combination of filters. Try widening the dimension filters or picking different accounts.</div>
              ` : html`
                <table class="iat-table">
                  <thead>
                    <tr>
                      <th style=${{ width: '120px' }}>Account</th>
                      <th>Title</th>
                      <th class="iat-num" style=${{ width: '160px' }}>Period balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${sourceBalances.map((r, i) => html`
                      <tr key=${i}>
                        <td style=${{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>${r.glaccountno}</td>
                        <td>${r.gltitle || '—'}</td>
                        <td class="iat-num">${fmtMoney.format(r.periodbalance || 0)}</td>
                      </tr>
                    `)}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan="2">Total</td>
                      <td class="iat-num">${fmtMoney.format(sourceTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              `}
            </div>
          ` : null}
        </div>
      `;
    }

    ReactDOM.createRoot(rootEl).render(html`<${App} />`);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  injectStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderLauncher);
  } else {
    renderLauncher();
  }
  console.log('[IntacctAllocationTool] launcher attached — Phase 2 (Frame + Step 1 + Step 2)');
})();
