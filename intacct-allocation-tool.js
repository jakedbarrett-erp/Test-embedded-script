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
// CURRENT STATUS: Phase 4 — full end-to-end allocation flow.
//   • Step 1: Period selector
//   • Step 2: Source pool (single/range/multi GL, dimension filters,
//     auto-fetch via getBalances)
//   • Step 3: Basis — account type (Stat/GL), required split dimension,
//     optional filters, per-dimension breakdown with allocation %
//   • Step 4: Target & Post — target GL override (or reuse source), optional
//     credit GL override, target dimension overrides, journal posting form,
//     computed JE preview with debits/credits/balance check, Post button
//     with confirmation, success/error display
//   Saved-allocations panel + dark-mode polish are the next phases.
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

  const fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum   = new Intl.NumberFormat('en-US');
  const fmtPct   = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtBasis = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Styles (scoped) ──────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      /* Launcher */
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

      /* Overlay shell */
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

      /* Theme variables */
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

      /* App layout */
      .iat-app {
        flex: 1;
        display: flex; flex-direction: column;
        background: var(--iat-bg); color: var(--iat-fg);
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
      .iat-app-title { flex: 1; font-size: 15px; font-weight: 600; letter-spacing: -0.2px; color: var(--iat-fg); }
      .iat-app-title-sub { font-size: 12px; color: var(--iat-fg-muted); font-weight: 400; margin-left: 8px; }
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

      /* Body */
      .iat-app-body {
        flex: 1; display: grid; grid-template-columns: 336px 1fr; overflow: hidden;
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

      /* Step indicator */
      .iat-stepnav {
        display: flex; align-items: center; gap: 6px;
        padding: 10px 14px;
        background: var(--iat-bg-card); border: 1px solid var(--iat-border);
        border-radius: 8px; margin-bottom: 4px;
      }
      .iat-stepnav-dot {
        width: 22px; height: 22px; border-radius: 50%;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        color: var(--iat-fg-muted);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; transition: all .15s;
      }
      .iat-stepnav-dot.active { background: var(--iat-accent); border-color: var(--iat-accent); color: #fff; }
      .iat-stepnav-dot.done   { background: var(--iat-accent-soft); border-color: var(--iat-accent); color: var(--iat-accent); }
      .iat-stepnav-line { flex: 1; height: 2px; background: var(--iat-border); border-radius: 1px; }
      .iat-stepnav-line.done { background: var(--iat-accent); }

      /* Step card */
      .iat-step {
        background: var(--iat-bg-card); border: 1px solid var(--iat-border);
        border-radius: 8px; padding: 12px 14px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .iat-step.active { border-color: var(--iat-accent); box-shadow: 0 0 0 3px var(--iat-accent-soft); }
      .iat-step-head { display: flex; align-items: center; gap: 10px; }
      .iat-step-num {
        width: 22px; height: 22px; border-radius: 50%;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        color: var(--iat-fg-soft);
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; flex-shrink: 0;
      }
      .iat-step.active .iat-step-num { background: var(--iat-accent); border-color: var(--iat-accent); color: #fff; }
      .iat-step.done   .iat-step-num { background: var(--iat-accent-soft); border-color: var(--iat-accent); color: var(--iat-accent); }
      .iat-step-title { font-size: 13px; font-weight: 600; color: var(--iat-fg); flex: 1; letter-spacing: -0.1px; }
      .iat-step-status { font-size: 11px; color: var(--iat-fg-muted); }
      .iat-step-body { display: flex; flex-direction: column; gap: 10px; }
      .iat-step-section { display: flex; flex-direction: column; gap: 6px; }
      .iat-step-section + .iat-step-section {
        margin-top: 4px; padding-top: 10px;
        border-top: 1px solid var(--iat-border-soft);
      }

      /* Form controls */
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
      .iat-select:disabled, .iat-input:disabled { opacity: .55; cursor: not-allowed; }
      .iat-readout {
        margin-top: 4px; padding: 8px 10px;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border-soft);
        border-radius: 6px; font-size: 12px; color: var(--iat-fg-soft);
      }
      .iat-readout-strong { color: var(--iat-fg); font-weight: 500; }

      .iat-checkbox-row {
        display: flex; align-items: center; gap: 8px;
        font-size: 12px; color: var(--iat-fg);
        cursor: pointer;
      }
      .iat-checkbox-row input { margin: 0; cursor: pointer; }

      /* Segmented */
      .iat-seg {
        display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border);
        border-radius: 6px; padding: 2px; gap: 2px;
      }
      .iat-seg-btn {
        background: transparent; border: none;
        padding: 6px 10px;
        font-size: 12px; font-weight: 500; color: var(--iat-fg-soft);
        cursor: pointer; border-radius: 4px; font-family: inherit;
        transition: background .12s, color .12s;
      }
      .iat-seg-btn:hover { color: var(--iat-fg); }
      .iat-seg-btn.active {
        background: var(--iat-bg); color: var(--iat-fg);
        box-shadow: 0 1px 2px rgba(0,0,0,.06);
      }

      .iat-range-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

      /* Multi-select */
      .iat-multilist {
        max-height: 200px; overflow-y: auto;
        border: 1px solid var(--iat-border);
        border-radius: 6px; background: var(--iat-bg);
      }
      .iat-multilist-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        font-size: 12px; color: var(--iat-fg);
        cursor: pointer; border-bottom: 1px solid var(--iat-border-soft);
      }
      .iat-multilist-row:last-child { border-bottom: none; }
      .iat-multilist-row:hover { background: var(--iat-bg-soft); }
      .iat-multilist-row input { margin: 0; cursor: pointer; }
      .iat-multilist-meta { font-size: 11px; color: var(--iat-fg-muted); padding: 6px 10px 0; }
      .iat-multilist-search { padding: 6px 10px; border-bottom: 1px solid var(--iat-border-soft); }
      .iat-multilist-search input {
        width: 100%; padding: 4px 8px;
        border: 1px solid var(--iat-border); border-radius: 4px;
        background: var(--iat-bg); color: var(--iat-fg);
        font-size: 12px; font-family: inherit; box-sizing: border-box;
      }

      /* Empty state */
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

      /* Content panel */
      .iat-panel-h1 { font-size: 18px; font-weight: 600; color: var(--iat-fg); margin: 0 0 4px; letter-spacing: -0.3px; }
      .iat-panel-sub { font-size: 13px; color: var(--iat-fg-soft); margin: 0 0 20px; }
      .iat-panel-section + .iat-panel-section { margin-top: 24px; }
      .iat-panel-h2 { font-size: 13px; font-weight: 600; color: var(--iat-fg-soft); margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; }

      /* Tables */
      .iat-table {
        width: 100%; border-collapse: collapse; font-size: 13px;
        background: var(--iat-bg-card);
        border: 1px solid var(--iat-border);
        border-radius: 8px; overflow: hidden;
      }
      .iat-table thead th {
        text-align: left; padding: 10px 14px;
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

      /* % bar */
      .iat-pctbar { position: relative; width: 100%; height: 6px; background: var(--iat-border-soft); border-radius: 3px; overflow: hidden; }
      .iat-pctbar-fill { height: 100%; background: var(--iat-accent); border-radius: 3px; transition: width .2s ease; }
      .iat-pctbar-cell { display: flex; flex-direction: column; gap: 4px; min-width: 100px; }
      .iat-pctbar-label {
        display: flex; justify-content: space-between;
        font-size: 11px; color: var(--iat-fg-soft);
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }

      /* Chips */
      .iat-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .iat-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px;
        background: var(--iat-accent-soft); color: var(--iat-accent);
        border-radius: 100px;
        font-size: 11px; font-weight: 500;
      }
      .iat-chip-key { color: var(--iat-fg-muted); font-weight: 400; margin-right: 2px; }

      /* Mini cards */
      .iat-minicards {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;
        margin-bottom: 20px;
      }
      .iat-minicard {
        padding: 10px 14px;
        background: var(--iat-bg-soft); border: 1px solid var(--iat-border-soft);
        border-radius: 8px;
      }
      .iat-minicard-label { font-size: 10px; color: var(--iat-fg-muted); text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
      .iat-minicard-value { font-size: 16px; font-weight: 600; color: var(--iat-fg); margin-top: 2px; letter-spacing: -0.2px; font-variant-numeric: tabular-nums; }
      .iat-minicard-success { background: var(--iat-success-soft); border-color: var(--iat-success); }
      .iat-minicard-success .iat-minicard-value { color: var(--iat-success); }
      .iat-minicard-danger { background: var(--iat-danger-soft); border-color: var(--iat-danger); }
      .iat-minicard-danger .iat-minicard-value { color: var(--iat-danger); }

      /* Loading & error */
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

      /* Phase 4: post button & success result */
      .iat-postbar {
        margin-top: 28px;
        padding: 18px;
        background: var(--iat-bg-soft);
        border: 1px solid var(--iat-border);
        border-radius: 8px;
        display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
      }
      .iat-postbar-info { flex: 1; min-width: 240px; }
      .iat-postbar-info-title { font-size: 13px; font-weight: 600; color: var(--iat-fg); }
      .iat-postbar-info-detail { font-size: 11px; color: var(--iat-fg-muted); margin-top: 2px; }
      .iat-btn-primary {
        background: var(--iat-accent); color: #fff;
        border: none; border-radius: 6px;
        padding: 10px 20px;
        font-size: 13px; font-weight: 600;
        cursor: pointer; font-family: inherit;
        display: inline-flex; align-items: center; gap: 8px;
        transition: filter .12s, box-shadow .12s;
      }
      .iat-btn-primary:hover:not(:disabled) { filter: brightness(1.05); box-shadow: 0 2px 8px rgba(200,112,85,.3); }
      .iat-btn-primary:disabled { opacity: .55; cursor: not-allowed; }
      .iat-btn-secondary {
        background: var(--iat-bg-card); color: var(--iat-fg);
        border: 1px solid var(--iat-border); border-radius: 6px;
        padding: 9px 18px;
        font-size: 13px; font-weight: 500;
        cursor: pointer; font-family: inherit;
      }
      .iat-btn-secondary:hover:not(:disabled) { background: var(--iat-bg-soft); border-color: var(--iat-fg-muted); }
      .iat-btn-secondary:disabled { opacity: .55; cursor: not-allowed; }

      .iat-result {
        margin-top: 28px;
        padding: 20px;
        border-radius: 8px;
        border: 1px solid;
      }
      .iat-result-success {
        background: var(--iat-success-soft);
        border-color: var(--iat-success);
        color: var(--iat-success);
      }
      .iat-result-success-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
      .iat-result-success-detail { font-size: 13px; color: var(--iat-fg); }
      .iat-result-success-key {
        display: inline-block;
        margin-top: 10px; padding: 6px 12px;
        background: var(--iat-bg-card); color: var(--iat-fg);
        border: 1px solid var(--iat-border); border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px; font-weight: 600;
      }

      /* Two-column form for Step 4 sidebar (more compact) */
      .iat-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
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

    const SPLIT_DIMS = [
      { id: 'department', name: 'Department' },
      { id: 'location',   name: 'Location'   },
      { id: 'project',    name: 'Project'    },
      { id: 'class',      name: 'Class'      },
    ];

    // Map a SPLIT_DIM id to the line property the Sage client expects
    const SPLIT_LINE_FIELD = {
      department: 'dept',
      location:   'loc',
      project:    'proj',
      class:      'cls',
    };

    function App() {
      // ── Phase 1 ─────────────────────────────────────────────────────────
      const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
      const [activeStep, setActiveStep] = useState(1);
      const [periodName, setPeriodName] = useState('');

      // ── Phase 2 ─────────────────────────────────────────────────────────
      const [sourceMode, setSourceMode]         = useState('single');
      const [sourceGL, setSourceGL]             = useState('');
      const [rangeFrom, setRangeFrom]           = useState('');
      const [rangeTo, setRangeTo]               = useState('');
      const [multiAccounts, setMultiAccounts]   = useState([]);
      const [multiSearch, setMultiSearch]       = useState('');
      const [sourceLoc, setSourceLoc]           = useState('');
      const [sourceDept, setSourceDept]         = useState('');
      const [sourceClass, setSourceClass]       = useState('');
      const [sourceProj, setSourceProj]         = useState('');

      const [sourceBalances, setSourceBalances] = useState([]);
      const [sourceLoading, setSourceLoading]   = useState(false);
      const [sourceError, setSourceError]       = useState(null);
      const [sourceFetched, setSourceFetched]   = useState(false);

      // ── Phase 3 ─────────────────────────────────────────────────────────
      const [basisAcctType, setBasisAcctType]       = useState('stat');
      const [basisMode, setBasisMode]               = useState('single');
      const [basisAccount, setBasisAccount]         = useState('');
      const [basisRangeFrom, setBasisRangeFrom]     = useState('');
      const [basisRangeTo, setBasisRangeTo]         = useState('');
      const [basisMultiAccounts, setBasisMultiAccounts] = useState([]);
      const [basisMultiSearch, setBasisMultiSearch]     = useState('');
      const [splitDimension, setSplitDimension]     = useState('');
      const [basisLoc, setBasisLoc]                 = useState('');
      const [basisDept, setBasisDept]               = useState('');
      const [basisClass, setBasisClass]             = useState('');
      const [basisProj, setBasisProj]               = useState('');

      const [basisBalances, setBasisBalances] = useState([]);
      const [basisLoading, setBasisLoading]   = useState(false);
      const [basisError, setBasisError]       = useState(null);
      const [basisFetched, setBasisFetched]   = useState(false);

      // ── Phase 4: target & posting ──────────────────────────────────────
      const [useSourceAsTarget, setUseSourceAsTarget] = useState(true);
      const [targetGL, setTargetGL]                   = useState('');
      const [creditGLOverride, setCreditGLOverride]   = useState('');
      const [targetDept, setTargetDept]               = useState('');
      const [targetLoc, setTargetLoc]                 = useState('');
      const [targetClass, setTargetClass]             = useState('');
      const [targetProj, setTargetProj]               = useState('');
      const [journalSymbol, setJournalSymbol]         = useState('');
      const [batchTitle, setBatchTitle]               = useState('');
      const [jeDescription, setJeDescription]         = useState('');
      const [postingDate, setPostingDate]             = useState('');
      const [posting, setPosting]                     = useState(false);
      const [postResult, setPostResult]               = useState(null); // {success, key} or {success:false, error, sageDetail}

      useEffect(() => { localStorage.setItem(THEME_KEY, theme); }, [theme]);

      // Reset basis account when account type switches (stat ids ≠ gl ids)
      useEffect(() => {
        setBasisAccount('');
        setBasisRangeFrom('');
        setBasisRangeTo('');
        setBasisMultiAccounts([]);
        setBasisMultiSearch('');
      }, [basisAcctType]);

      const selectedPeriod = useMemo(
        () => data.periods.find(p => p.name === periodName) || null,
        [periodName]
      );

      // Default journal symbol once journals are loaded; user can change
      useEffect(() => {
        if (!journalSymbol && data.journals.length) {
          // Prefer 'GJ' if it exists, else first
          const gj = data.journals.find(j => j.id === 'GJ');
          setJournalSymbol((gj || data.journals[0]).id);
        }
      }, [data.journals, journalSymbol]);

      // Default posting date to period end when period changes (don't
      // overwrite if user has already typed a custom one — only fill empty)
      useEffect(() => {
        if (selectedPeriod && !postingDate) {
          setPostingDate(selectedPeriod.endDate);
        }
      }, [selectedPeriod, postingDate]);

      // Default batch title to a sensible string when period changes
      useEffect(() => {
        if (selectedPeriod && !batchTitle) {
          setBatchTitle('Allocation — ' + selectedPeriod.name);
        }
      }, [selectedPeriod, batchTitle]);

      // ── Source params ───────────────────────────────────────────────────
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

      useEffect(() => {
        if (!sourceParams) {
          setSourceBalances([]); setSourceFetched(false); setSourceError(null);
          return;
        }
        let cancelled = false;
        setSourceLoading(true); setSourceError(null);
        window.IntacctSageClient.getBalances(sourceParams).then(rows => {
          if (cancelled) return;
          setSourceBalances(rows); setSourceFetched(true); setSourceLoading(false);
        }).catch(err => {
          if (cancelled) return;
          setSourceError(err && err.message || String(err)); setSourceLoading(false);
        });
        return () => { cancelled = true; };
      }, [sourceParams]);

      const sourceTotal = useMemo(
        () => sourceBalances.reduce((sum, r) => sum + (r.periodbalance || 0), 0),
        [sourceBalances]
      );

      // ── Basis params ───────────────────────────────────────────────────
      const basisParams = useMemo(() => {
        if (!selectedPeriod || !splitDimension) return null;
        let acc = null;
        if (basisMode === 'single') {
          if (!basisAccount) return null;
          acc = { accountMode: 'single', accountNo: basisAccount };
        } else if (basisMode === 'range') {
          if (!basisRangeFrom || !basisRangeTo) return null;
          acc = { accountMode: 'range', startAccountNo: basisRangeFrom, endAccountNo: basisRangeTo };
        } else {
          if (!basisMultiAccounts.length) return null;
          acc = { accountMode: 'multi', accounts: basisMultiAccounts };
        }
        return Object.assign({
          startDate:    selectedPeriod.startDate,
          endDate:      selectedPeriod.endDate,
          groupby:      splitDimension,
          locationid:   basisLoc || undefined,
          departmentid: basisDept || undefined,
          classid:      basisClass || undefined,
          projectid:    basisProj || undefined,
        }, acc);
      }, [selectedPeriod, splitDimension, basisMode, basisAccount, basisRangeFrom, basisRangeTo, basisMultiAccounts, basisLoc, basisDept, basisClass, basisProj]);

      useEffect(() => {
        if (!basisParams) {
          setBasisBalances([]); setBasisFetched(false); setBasisError(null);
          return;
        }
        let cancelled = false;
        setBasisLoading(true); setBasisError(null);
        window.IntacctSageClient.getBalances(basisParams).then(rows => {
          if (cancelled) return;
          setBasisBalances(rows); setBasisFetched(true); setBasisLoading(false);
        }).catch(err => {
          if (cancelled) return;
          setBasisError(err && err.message || String(err)); setBasisLoading(false);
        });
        return () => { cancelled = true; };
      }, [basisParams]);

      const basisRows = useMemo(() => {
        if (!basisBalances.length || !splitDimension) return [];
        const idField   = splitDimension + 'id';
        const nameField = splitDimension + 'name';
        const grouped = {};
        for (const r of basisBalances) {
          const id = r[idField];
          if (!id) continue;
          if (!grouped[id]) grouped[id] = { id, name: r[nameField] || id, value: 0 };
          grouped[id].value += Math.abs(r.periodbalance || 0);
        }
        const rows = Object.values(grouped);
        const totalBasis = rows.reduce((sum, r) => sum + r.value, 0);
        return rows.map(r => ({
          id:    r.id,
          name:  r.name,
          value: r.value,
          pct:   totalBasis > 0 ? r.value / totalBasis : 0,
          alloc: totalBasis > 0 ? sourceTotal * (r.value / totalBasis) : 0,
        })).sort((a, b) => b.value - a.value);
      }, [basisBalances, splitDimension, sourceTotal]);

      const basisTotal = useMemo(() => basisRows.reduce((s, r) => s + r.value, 0), [basisRows]);

      // ── Phase 4: effective target & journal entry composition ───────────
      // If useSourceAsTarget is true and we have a single source, that's the
      // debit GL. Otherwise targetGL must be picked. For range/multi source,
      // useSourceAsTarget is ambiguous so we require an explicit targetGL.
      const effectiveTargetGL = useMemo(() => {
        if (useSourceAsTarget && sourceMode === 'single') return sourceGL || '';
        return targetGL || '';
      }, [useSourceAsTarget, sourceMode, sourceGL, targetGL]);

      // Build the journal entry: debit lines per basis row, credit lines per
      // source GL. Amounts are always positive (Sage convention); TR_TYPE=1
      // is debit, -1 is credit. If pool is negative, swap which side gets
      // the target vs the source so amounts stay positive.
      const je = useMemo(() => {
        if (!basisRows.length || !sourceBalances.length || !effectiveTargetGL) return null;

        const negativePool   = sourceTotal < 0;
        const targetTrType   = negativePool ? -1 : 1;  // debit by default
        const sourceTrType   = negativePool ?  1 : -1; // credit by default
        const splitField     = SPLIT_LINE_FIELD[splitDimension];
        const descBase       = jeDescription || ('Allocation — ' + (selectedPeriod ? selectedPeriod.name : ''));

        // Debit lines (one per basis row above 1¢)
        const targetLines = basisRows
          .filter(r => Math.abs(r.alloc) >= 0.005)
          .map(r => {
            const line = {
              gl:       effectiveTargetGL,
              trType:   targetTrType,
              amount:   Math.abs(r.alloc),
              desc:     descBase + ' · ' + r.name,
              billable: false,
            };
            if (splitField) line[splitField] = r.id;
            // Apply target overrides for non-split dimensions (split-dim is
            // already set from the basis row; overrides shouldn't clobber it)
            if (splitDimension !== 'department' && targetDept) line.dept = targetDept;
            if (splitDimension !== 'location'   && targetLoc)  line.loc  = targetLoc;
            if (splitDimension !== 'project'    && targetProj) line.proj = targetProj;
            if (splitDimension !== 'class'      && targetClass) line.cls = targetClass;
            return line;
          });

        // Adjust the largest target line by any rounding diff so debit total
        // exactly matches |sourceTotal|. Without this, Sage will reject the
        // batch because debits ≠ credits by a few cents.
        const targetSum = targetLines.reduce((s, l) => s + l.amount, 0);
        const adjust = Math.abs(sourceTotal) - targetSum;
        if (Math.abs(adjust) >= 0.005 && targetLines.length > 0) {
          let mi = 0;
          for (let i = 1; i < targetLines.length; i++) {
            if (targetLines[i].amount > targetLines[mi].amount) mi = i;
          }
          targetLines[mi].amount = Math.max(0, targetLines[mi].amount + adjust);
        }

        // Credit lines (one per source GL, mirroring its source balance)
        const creditLines = sourceBalances
          .filter(b => Math.abs(b.periodbalance) >= 0.005)
          .map(b => ({
            gl:       creditGLOverride || b.glaccountno,
            trType:   sourceTrType,
            amount:   Math.abs(b.periodbalance),
            desc:     descBase + ' · reversal',
            billable: false,
            // Use original source dimensions so the credit nets out cleanly
            dept: b.departmentid || undefined,
            loc:  b.locationid   || undefined,
            proj: b.projectid    || undefined,
            cls:  b.classid      || undefined,
          }));

        const allLines = targetLines.concat(creditLines);
        const totalDr  = allLines.filter(l => l.trType ===  1).reduce((s, l) => s + l.amount, 0);
        const totalCr  = allLines.filter(l => l.trType === -1).reduce((s, l) => s + l.amount, 0);
        const balanced = Math.abs(totalDr - totalCr) < 0.01;

        return {
          lines: allLines,
          targetLines, creditLines,
          totalDr, totalCr, balanced,
          negativePool,
        };
      }, [basisRows, sourceBalances, sourceTotal, splitDimension, effectiveTargetGL, creditGLOverride, targetDept, targetLoc, targetClass, targetProj, jeDescription, selectedPeriod]);

      // ── Posting handler ─────────────────────────────────────────────────
      const canPost = !!je && je.balanced && !posting && !!effectiveTargetGL && !!journalSymbol && !!postingDate && !postResult;
      const postReason = (() => {
        if (postResult && postResult.success) return null;
        if (!je) return 'Complete basis selection to compute the journal entry.';
        if (!effectiveTargetGL) return 'Pick a target GL (or leave "Use source as target" on for single-source mode).';
        if (!je.balanced) return 'Journal entry is out of balance — debits and credits must match exactly.';
        if (!journalSymbol) return 'Select a journal type.';
        if (!postingDate) return 'Set a posting date.';
        return null;
      })();

      async function handlePost() {
        if (!je) return;
        const ok = window.confirm(
          'Post journal entry to Sage?\n\n' +
          'Journal: '       + journalSymbol + '\n' +
          'Date: '          + postingDate + '\n' +
          'Title: '         + (batchTitle || '(none)') + '\n' +
          'Lines: '         + je.lines.length + '\n' +
          'Debit total: '   + fmtMoney.format(je.totalDr) + '\n' +
          'Credit total: '  + fmtMoney.format(je.totalCr) + '\n\n' +
          'This will create a posted batch in Sage. Continue?'
        );
        if (!ok) return;
        setPosting(true);
        setPostResult(null);
        try {
          const result = await window.IntacctSageClient.postJournal({
            journal:    journalSymbol,
            batchDate:  postingDate,
            batchTitle: batchTitle || ('Allocation ' + (selectedPeriod ? selectedPeriod.name : '')),
            lines:      je.lines,
          });
          setPostResult({ success: true, key: result.key });
        } catch (err) {
          setPostResult({
            success: false,
            error:   err && err.message || String(err),
            sageDetail: err && err.sageDetail || null,
            xmlSent: err && err.xmlSent || null,
          });
        } finally {
          setPosting(false);
        }
      }

      function resetForNewAllocation() {
        // Keep the period; clear everything downstream so user can start a new allocation
        setPostResult(null);
        setSourceMode('single'); setSourceGL(''); setRangeFrom(''); setRangeTo('');
        setMultiAccounts([]); setMultiSearch('');
        setSourceLoc(''); setSourceDept(''); setSourceClass(''); setSourceProj('');
        setBasisAcctType('stat'); setBasisMode('single'); setBasisAccount('');
        setBasisRangeFrom(''); setBasisRangeTo(''); setBasisMultiAccounts([]); setBasisMultiSearch('');
        setSplitDimension('');
        setBasisLoc(''); setBasisDept(''); setBasisClass(''); setBasisProj('');
        setUseSourceAsTarget(true); setTargetGL(''); setCreditGLOverride('');
        setTargetDept(''); setTargetLoc(''); setTargetClass(''); setTargetProj('');
        setJeDescription('');
        if (selectedPeriod) setBatchTitle('Allocation — ' + selectedPeriod.name);
        setActiveStep(2);
      }

      // ── Step completion ─────────────────────────────────────────────────
      const stepDone = useMemo(() => ({
        1: !!periodName,
        2: sourceFetched && sourceBalances.length > 0,
        3: basisFetched && basisRows.length > 0,
        4: !!(postResult && postResult.success),
      }), [periodName, sourceFetched, sourceBalances.length, basisFetched, basisRows.length, postResult]);

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
        // source
        sourceMode, setSourceMode, sourceGL, setSourceGL,
        rangeFrom, setRangeFrom, rangeTo, setRangeTo,
        multiAccounts, setMultiAccounts, multiSearch, setMultiSearch,
        sourceLoc, setSourceLoc, sourceDept, setSourceDept,
        sourceClass, setSourceClass, sourceProj, setSourceProj,
        sourceBalances, sourceLoading, sourceError, sourceFetched, sourceTotal, sourceParams,
        // basis
        basisAcctType, setBasisAcctType, basisMode, setBasisMode,
        basisAccount, setBasisAccount,
        basisRangeFrom, setBasisRangeFrom, basisRangeTo, setBasisRangeTo,
        basisMultiAccounts, setBasisMultiAccounts, basisMultiSearch, setBasisMultiSearch,
        splitDimension, setSplitDimension,
        basisLoc, setBasisLoc, basisDept, setBasisDept,
        basisClass, setBasisClass, basisProj, setBasisProj,
        basisBalances, basisLoading, basisError, basisFetched, basisRows, basisTotal, basisParams,
        // target & post
        useSourceAsTarget, setUseSourceAsTarget,
        targetGL, setTargetGL, effectiveTargetGL,
        creditGLOverride, setCreditGLOverride,
        targetDept, setTargetDept, targetLoc, setTargetLoc,
        targetClass, setTargetClass, targetProj, setTargetProj,
        journalSymbol, setJournalSymbol,
        batchTitle, setBatchTitle,
        jeDescription, setJeDescription,
        postingDate, setPostingDate,
        je, posting, postResult, canPost, postReason,
        handlePost, resetForNewAllocation,
        // shared
        selectedPeriod,
      };

      return html`
        <div class="iat-app" data-theme=${theme}>
          <header class="iat-app-header">
            <div class="iat-app-icon">A</div>
            <div class="iat-app-title">
              Allocation Tool
              <span class="iat-app-title-sub">Phase 4 · Target & Post</span>
            </div>
            <div class="iat-app-actions">
              <button class="iat-icon-btn" type="button"
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

              <${StepCard} num=${2} title="Source pool" status=${stepStatus(2)}
                onActivate=${() => periodName && setActiveStep(2)} disabled=${!periodName}
              ><${SourceStepBody} ctx=${ctx} /><//>

              <${StepCard} num=${3} title="Allocation basis" status=${stepStatus(3)}
                onActivate=${() => stepDone[2] && setActiveStep(3)} disabled=${!stepDone[2]}
              ><${BasisStepBody} ctx=${ctx} /><//>

              <${StepCard} num=${4} title="Target & post" status=${stepStatus(4)}
                onActivate=${() => stepDone[3] && setActiveStep(4)} disabled=${!stepDone[3]}
              ><${TargetStepBody} ctx=${ctx} /><//>
            </aside>

            <main class="iat-content">
              <${ContentPanel} activeStep=${activeStep} ctx=${ctx} />
            </main>
          </div>
        </div>
      `;
    }

    // ── Reusable components ──────────────────────────────────────────────
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

    function SingleAcctPicker({ accounts, value, onChange, placeholder }) {
      return html`
        <select class="iat-select" value=${value} onChange=${(e) => onChange(e.target.value)}>
          <option value="">${placeholder || '— select account —'}</option>
          ${accounts.map(a => html`<option key=${a.id} value=${a.id}>${a.id} · ${a.name}</option>`)}
        </select>
      `;
    }
    function RangeAcctPicker({ from, to, onChangeFrom, onChangeTo }) {
      return html`
        <div class="iat-range-row">
          <input class="iat-input" placeholder="From" value=${from} onChange=${(e) => onChangeFrom(e.target.value)} />
          <input class="iat-input" placeholder="To"   value=${to}   onChange=${(e) => onChangeTo(e.target.value)} />
        </div>
      `;
    }
    function MultiAcctPicker({ accounts, selected, onChangeSelected, search, onChangeSearch }) {
      const filtered = useMemo(() => {
        const q = (search || '').trim().toLowerCase();
        if (!q) return accounts;
        return accounts.filter(a =>
          (a.id || '').toLowerCase().includes(q) ||
          (a.name || '').toLowerCase().includes(q)
        );
      }, [search, accounts]);
      const set = new Set(selected);
      const toggle = (id) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id); else next.add(id);
        onChangeSelected(Array.from(next));
      };
      return html`
        <div class="iat-multilist">
          <div class="iat-multilist-search">
            <input type="search" placeholder=${'Filter ' + fmtNum.format(accounts.length) + ' accounts…'}
              value=${search} onChange=${(e) => onChangeSearch(e.target.value)} />
          </div>
          ${filtered.slice(0, 200).map(a => html`
            <label key=${a.id} class="iat-multilist-row">
              <input type="checkbox" checked=${set.has(a.id)} onChange=${() => toggle(a.id)} />
              <span style=${{ flex: 1 }}>${a.id} · ${a.name}</span>
            </label>
          `)}
          ${filtered.length > 200 ? html`<div class="iat-multilist-meta">Showing first 200 of ${fmtNum.format(filtered.length)} matches — refine search to see more.</div>` : null}
        </div>
        <div class="iat-multilist-meta">${selected.length} selected</div>
      `;
    }

    function DimSelect({ id, rows, value, onChange, placeholder }) {
      return html`
        <select id=${id} class="iat-select" value=${value} onChange=${(e) => onChange(e.target.value)}>
          <option value="">${placeholder}</option>
          ${rows.map(r => html`<option key=${r.id} value=${r.id}>${r.id} · ${r.name}</option>`)}
        </select>
      `;
    }

    function Segmented({ options, value, onChange }) {
      return html`
        <div class="iat-seg">
          ${options.map(o => html`
            <button key=${o.id} type="button" class=${'iat-seg-btn' + (value === o.id ? ' active' : '')}
              onClick=${() => onChange(o.id)}>${o.label}</button>
          `)}
        </div>
      `;
    }

    // ── Step 2 sidebar body ──────────────────────────────────────────────
    function SourceStepBody({ ctx }) {
      const { data, sourceMode, setSourceMode } = ctx;
      return html`
        <div class="iat-step-section">
          <span class="iat-label">Account selection</span>
          <${Segmented} options=${[{id:'single',label:'Single'},{id:'range',label:'Range'},{id:'multi',label:'Multi'}]}
            value=${sourceMode} onChange=${setSourceMode} />
          ${sourceMode === 'single' ? html`<${SingleAcctPicker} accounts=${data.glAccounts} value=${ctx.sourceGL} onChange=${ctx.setSourceGL} placeholder="— select GL account —" />` : null}
          ${sourceMode === 'range'  ? html`<${RangeAcctPicker} from=${ctx.rangeFrom} to=${ctx.rangeTo} onChangeFrom=${ctx.setRangeFrom} onChangeTo=${ctx.setRangeTo} />` : null}
          ${sourceMode === 'multi'  ? html`<${MultiAcctPicker} accounts=${data.glAccounts} selected=${ctx.multiAccounts} onChangeSelected=${ctx.setMultiAccounts} search=${ctx.multiSearch} onChangeSearch=${ctx.setMultiSearch} />` : null}
        </div>

        <div class="iat-step-section">
          <span class="iat-label">Dimension filters</span>
          <label class="iat-label iat-label-req" for="iat-src-loc" style=${{ marginTop: '4px' }}>Location</label>
          <${DimSelect} id="iat-src-loc" rows=${data.locations}   value=${ctx.sourceLoc}   onChange=${ctx.setSourceLoc}   placeholder="— select location —" />
          <label class="iat-label" for="iat-src-dept" style=${{ marginTop: '4px' }}>Department</label>
          <${DimSelect} id="iat-src-dept" rows=${data.departments} value=${ctx.sourceDept}  onChange=${ctx.setSourceDept}  placeholder="Any" />
          <label class="iat-label" for="iat-src-cls" style=${{ marginTop: '4px' }}>Class</label>
          <${DimSelect} id="iat-src-cls" rows=${data.classes}     value=${ctx.sourceClass} onChange=${ctx.setSourceClass} placeholder="Any" />
          <label class="iat-label" for="iat-src-prj" style=${{ marginTop: '4px' }}>Project</label>
          <${DimSelect} id="iat-src-prj" rows=${data.projects}    value=${ctx.sourceProj}  onChange=${ctx.setSourceProj}  placeholder="Any" />
        </div>
      `;
    }

    // ── Step 3 sidebar body ──────────────────────────────────────────────
    function BasisStepBody({ ctx }) {
      const { data, basisAcctType, setBasisAcctType, basisMode, setBasisMode } = ctx;
      const accounts = basisAcctType === 'stat' ? data.statAccounts : data.glAccounts;
      const acctPlaceholder = basisAcctType === 'stat' ? '— select stat account —' : '— select GL account —';
      return html`
        <div class="iat-step-section">
          <span class="iat-label">Account type</span>
          <${Segmented} options=${[{id:'stat',label:'Statistical'},{id:'gl',label:'GL'}]} value=${basisAcctType} onChange=${setBasisAcctType} />
        </div>
        <div class="iat-step-section">
          <span class="iat-label">Account selection</span>
          <${Segmented} options=${[{id:'single',label:'Single'},{id:'range',label:'Range'},{id:'multi',label:'Multi'}]} value=${basisMode} onChange=${setBasisMode} />
          ${basisMode === 'single' ? html`<${SingleAcctPicker} accounts=${accounts} value=${ctx.basisAccount} onChange=${ctx.setBasisAccount} placeholder=${acctPlaceholder} />` : null}
          ${basisMode === 'range'  ? html`<${RangeAcctPicker} from=${ctx.basisRangeFrom} to=${ctx.basisRangeTo} onChangeFrom=${ctx.setBasisRangeFrom} onChangeTo=${ctx.setBasisRangeTo} />` : null}
          ${basisMode === 'multi'  ? html`<${MultiAcctPicker} accounts=${accounts} selected=${ctx.basisMultiAccounts} onChangeSelected=${ctx.setBasisMultiAccounts} search=${ctx.basisMultiSearch} onChangeSearch=${ctx.setBasisMultiSearch} />` : null}
        </div>
        <div class="iat-step-section">
          <label class="iat-label iat-label-req" for="iat-basis-split">Split by</label>
          <select id="iat-basis-split" class="iat-select" value=${ctx.splitDimension} onChange=${(e) => ctx.setSplitDimension(e.target.value)}>
            <option value="">— select dimension —</option>
            ${SPLIT_DIMS.map(d => html`<option key=${d.id} value=${d.id}>${d.name}</option>`)}
          </select>
        </div>
        <div class="iat-step-section">
          <span class="iat-label">Dimension filters (optional)</span>
          <label class="iat-label" for="iat-bs-loc" style=${{ marginTop: '4px' }}>Location</label>
          <${DimSelect} id="iat-bs-loc" rows=${data.locations}   value=${ctx.basisLoc}   onChange=${ctx.setBasisLoc}   placeholder="Any" />
          <label class="iat-label" for="iat-bs-dept" style=${{ marginTop: '4px' }}>Department</label>
          <${DimSelect} id="iat-bs-dept" rows=${data.departments} value=${ctx.basisDept}  onChange=${ctx.setBasisDept}  placeholder="Any" />
          <label class="iat-label" for="iat-bs-cls" style=${{ marginTop: '4px' }}>Class</label>
          <${DimSelect} id="iat-bs-cls" rows=${data.classes}     value=${ctx.basisClass} onChange=${ctx.setBasisClass} placeholder="Any" />
          <label class="iat-label" for="iat-bs-prj" style=${{ marginTop: '4px' }}>Project</label>
          <${DimSelect} id="iat-bs-prj" rows=${data.projects}    value=${ctx.basisProj}  onChange=${ctx.setBasisProj}  placeholder="Any" />
        </div>
      `;
    }

    // ── Step 4 sidebar body ──────────────────────────────────────────────
    function TargetStepBody({ ctx }) {
      const { data, sourceMode, useSourceAsTarget, setUseSourceAsTarget } = ctx;
      // useSourceAsTarget only makes sense in single-source mode — for
      // range/multi the source GL is ambiguous, so we force explicit target.
      const sourceAsTargetAvailable = sourceMode === 'single';
      const targetGLDisabled = useSourceAsTarget && sourceAsTargetAvailable;

      return html`
        <div class="iat-step-section">
          <span class="iat-label">Target account</span>
          ${sourceAsTargetAvailable ? html`
            <label class="iat-checkbox-row">
              <input type="checkbox" checked=${useSourceAsTarget}
                onChange=${(e) => setUseSourceAsTarget(e.target.checked)} />
              <span>Use source GL as target</span>
            </label>
          ` : html`<div class="iat-step-status">Range/Multi source — explicit target required.</div>`}
          <label class="iat-label" for="iat-tgt-gl" style=${{ marginTop: '4px' }}>Target GL${!targetGLDisabled ? ' *' : ''}</label>
          <select id="iat-tgt-gl" class="iat-select" value=${ctx.targetGL}
            disabled=${targetGLDisabled}
            onChange=${(e) => ctx.setTargetGL(e.target.value)}
          >
            <option value="">— select target GL —</option>
            ${data.glAccounts.map(g => html`<option key=${g.id} value=${g.id}>${g.id} · ${g.name}</option>`)}
          </select>
          <label class="iat-label" for="iat-tgt-credit" style=${{ marginTop: '4px' }}>Credit GL override (optional)</label>
          <select id="iat-tgt-credit" class="iat-select" value=${ctx.creditGLOverride}
            onChange=${(e) => ctx.setCreditGLOverride(e.target.value)}
          >
            <option value="">— use source GL(s) —</option>
            ${data.glAccounts.map(g => html`<option key=${g.id} value=${g.id}>${g.id} · ${g.name}</option>`)}
          </select>
        </div>

        <div class="iat-step-section">
          <span class="iat-label">Target dimensions (overrides)</span>
          <label class="iat-label" for="iat-tgt-dept" style=${{ marginTop: '4px' }}>Department</label>
          <${DimSelect} id="iat-tgt-dept" rows=${data.departments} value=${ctx.targetDept}  onChange=${ctx.setTargetDept}  placeholder="Any" />
          <label class="iat-label" for="iat-tgt-loc" style=${{ marginTop: '4px' }}>Location</label>
          <${DimSelect} id="iat-tgt-loc" rows=${data.locations}    value=${ctx.targetLoc}   onChange=${ctx.setTargetLoc}   placeholder="Any" />
          <label class="iat-label" for="iat-tgt-cls" style=${{ marginTop: '4px' }}>Class</label>
          <${DimSelect} id="iat-tgt-cls" rows=${data.classes}      value=${ctx.targetClass} onChange=${ctx.setTargetClass} placeholder="Any" />
          <label class="iat-label" for="iat-tgt-prj" style=${{ marginTop: '4px' }}>Project</label>
          <${DimSelect} id="iat-tgt-prj" rows=${data.projects}     value=${ctx.targetProj}  onChange=${ctx.setTargetProj}  placeholder="Any" />
        </div>

        <div class="iat-step-section">
          <span class="iat-label">Posting</span>
          <label class="iat-label iat-label-req" for="iat-tgt-jnl" style=${{ marginTop: '4px' }}>Journal type</label>
          <select id="iat-tgt-jnl" class="iat-select" value=${ctx.journalSymbol}
            onChange=${(e) => ctx.setJournalSymbol(e.target.value)}
          >
            <option value="">— select journal —</option>
            ${data.journals.map(j => html`<option key=${j.id} value=${j.id}>${j.id} · ${j.name}</option>`)}
          </select>
          <label class="iat-label iat-label-req" for="iat-tgt-date" style=${{ marginTop: '4px' }}>Posting date</label>
          <input id="iat-tgt-date" class="iat-input" type="date" value=${ctx.postingDate}
            onChange=${(e) => ctx.setPostingDate(e.target.value)} />
          <label class="iat-label" for="iat-tgt-title" style=${{ marginTop: '4px' }}>Batch title</label>
          <input id="iat-tgt-title" class="iat-input" type="text" placeholder="Allocation — Q4 2025" value=${ctx.batchTitle}
            onChange=${(e) => ctx.setBatchTitle(e.target.value)} />
          <label class="iat-label" for="iat-tgt-desc" style=${{ marginTop: '4px' }}>Line description (optional)</label>
          <input id="iat-tgt-desc" class="iat-input" type="text" placeholder="(auto-generated)" value=${ctx.jeDescription}
            onChange=${(e) => ctx.setJeDescription(e.target.value)} />
        </div>
      `;
    }

    // ── Right panel dispatcher ───────────────────────────────────────────
    function ContentPanel({ activeStep, ctx }) {
      const { selectedPeriod, data } = ctx;
      if (!selectedPeriod) {
        return html`
          <div class="iat-content-empty">
            <div class="iat-content-empty-icon">①</div>
            <div class="iat-content-empty-title">Select a period to begin</div>
            <div class="iat-content-empty-detail">Pick a reporting period in the sidebar. Subsequent steps unlock once a period is selected.</div>
          </div>
        `;
      }
      if (activeStep === 1) {
        return html`
          <div style=${{ maxWidth: '720px' }}>
            <h2 class="iat-panel-h1">${selectedPeriod.name}</h2>
            <p class="iat-panel-sub">${selectedPeriod.startDate} → ${selectedPeriod.endDate}</p>
            <div class="iat-readout">Period selected. Move to <strong>Step 2</strong> to choose the source pool.</div>
          </div>
        `;
      }
      if (activeStep === 2) return html`<${SourceContentPanel} ctx=${ctx} />`;
      if (activeStep === 3) return html`<${BasisContentPanel}  ctx=${ctx} />`;
      if (activeStep === 4) return html`<${PostContentPanel}   ctx=${ctx} />`;
      return null;
    }

    function renderDimChip(label, id, list) {
      if (!id) return null;
      const row = list.find(r => r.id === id);
      const name = row ? row.name : id;
      return html`<span class="iat-chip"><span class="iat-chip-key">${label}</span>${name}</span>`;
    }

    // ── Step 2 right panel ───────────────────────────────────────────────
    function SourceContentPanel({ ctx }) {
      const {
        selectedPeriod, sourceParams, sourceBalances, sourceLoading, sourceError, sourceFetched, sourceTotal,
        sourceMode, sourceGL, rangeFrom, rangeTo, multiAccounts,
        sourceLoc, sourceDept, sourceClass, sourceProj, data,
      } = ctx;

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
            ${renderDimChip('Location',   sourceLoc,   data.locations)}
            ${renderDimChip('Department', sourceDept,  data.departments)}
            ${renderDimChip('Class',      sourceClass, data.classes)}
            ${renderDimChip('Project',    sourceProj,  data.projects)}
          </div>
          ${!sourceParams ? html`
            <div class="iat-warning" style=${{ marginTop: '20px' }}>
              ${ !sourceLoc ? 'Pick a location to fetch balances. Location is required for the source pool.'
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
                <div class="iat-readout">No balances returned for this combination of filters.</div>
              ` : html`
                <table class="iat-table">
                  <thead><tr><th style=${{ width: '120px' }}>Account</th><th>Title</th><th class="iat-num" style=${{ width: '160px' }}>Period balance</th></tr></thead>
                  <tbody>
                    ${sourceBalances.map((r, i) => html`
                      <tr key=${i}>
                        <td style=${{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>${r.glaccountno}</td>
                        <td>${r.gltitle || '—'}</td>
                        <td class="iat-num">${fmtMoney.format(r.periodbalance || 0)}</td>
                      </tr>
                    `)}
                  </tbody>
                  <tfoot><tr><td colspan="2">Total</td><td class="iat-num">${fmtMoney.format(sourceTotal)}</td></tr></tfoot>
                </table>
              `}
            </div>
          ` : null}
        </div>
      `;
    }

    // ── Step 3 right panel ───────────────────────────────────────────────
    function BasisContentPanel({ ctx }) {
      const {
        selectedPeriod, sourceTotal, sourceFetched,
        basisParams, basisLoading, basisError, basisFetched, basisRows, basisTotal,
        basisAcctType, basisMode, basisAccount, basisRangeFrom, basisRangeTo, basisMultiAccounts,
        splitDimension, basisLoc, basisDept, basisClass, basisProj, data,
      } = ctx;

      const accounts = basisAcctType === 'stat' ? data.statAccounts : data.glAccounts;
      const splitDimName = (SPLIT_DIMS.find(d => d.id === splitDimension) || {}).name || '—';

      const acctChip = (() => {
        const typeLabel = basisAcctType === 'stat' ? 'Stat' : 'GL';
        if (basisMode === 'single' && basisAccount) {
          const row = accounts.find(a => a.id === basisAccount);
          return html`<span class="iat-chip"><span class="iat-chip-key">${typeLabel}</span>${basisAccount}${row ? ' · ' + row.name : ''}</span>`;
        }
        if (basisMode === 'range' && basisRangeFrom && basisRangeTo) {
          return html`<span class="iat-chip"><span class="iat-chip-key">${typeLabel} range</span>${basisRangeFrom} → ${basisRangeTo}</span>`;
        }
        if (basisMode === 'multi' && basisMultiAccounts.length) {
          return html`<span class="iat-chip"><span class="iat-chip-key">${typeLabel} multi</span>${basisMultiAccounts.length} accounts</span>`;
        }
        return null;
      })();

      const negativePool = sourceTotal < 0;

      return html`
        <div style=${{ maxWidth: '960px' }}>
          <h2 class="iat-panel-h1">Allocation basis</h2>
          <p class="iat-panel-sub">${selectedPeriod.name} · split by <strong>${splitDimName}</strong></p>

          <div class="iat-minicards">
            <div class="iat-minicard"><div class="iat-minicard-label">Source pool total</div><div class="iat-minicard-value">${fmtMoney.format(sourceTotal)}</div></div>
            <div class="iat-minicard"><div class="iat-minicard-label">Basis total (abs)</div><div class="iat-minicard-value">${fmtBasis.format(basisTotal)}</div></div>
            <div class="iat-minicard"><div class="iat-minicard-label">Split groups</div><div class="iat-minicard-value">${fmtNum.format(basisRows.length)}</div></div>
          </div>

          <div class="iat-chip-row">
            ${acctChip}
            ${splitDimension ? html`<span class="iat-chip"><span class="iat-chip-key">Split</span>${splitDimName}</span>` : null}
            ${renderDimChip('Loc',   basisLoc,   data.locations)}
            ${renderDimChip('Dept',  basisDept,  data.departments)}
            ${renderDimChip('Class', basisClass, data.classes)}
            ${renderDimChip('Proj',  basisProj,  data.projects)}
          </div>

          ${!sourceFetched ? html`
            <div class="iat-warning" style=${{ marginTop: '20px' }}>Complete the source pool first — the allocation amount comes from its total.</div>
          ` : !basisParams ? html`
            <div class="iat-warning" style=${{ marginTop: '20px' }}>
              ${ !splitDimension ? 'Pick a split dimension — the basis is grouped by this.'
                  : basisMode === 'single' && !basisAccount ? 'Pick a basis account.'
                  : basisMode === 'range'  && (!basisRangeFrom || !basisRangeTo) ? 'Enter both range endpoints for the basis accounts.'
                  : basisMode === 'multi'  && !basisMultiAccounts.length ? 'Select at least one basis account.'
                  : 'Complete the basis inputs to fetch.' }
            </div>
          ` : basisLoading ? html`
            <div class="iat-inline-loading" style=${{ marginTop: '20px' }}>
              <span class="iat-spinner iat-spinner-sm"></span>
              <span>Fetching basis balances from Sage…</span>
            </div>
          ` : basisError ? html`
            <div class="iat-error">
              <div class="iat-error-title">Basis fetch failed</div>
              <div class="iat-error-detail">${basisError}</div>
            </div>
          ` : basisFetched ? html`
            ${negativePool ? html`<div class="iat-warning" style=${{ marginTop: '20px' }}>Source pool total is negative — Phase 4 will flip DR/CR appropriately when posting.</div>` : null}
            <div class="iat-panel-section">
              <h3 class="iat-panel-h2">Breakdown by ${splitDimName} · ${fmtNum.format(basisRows.length)} ${basisRows.length === 1 ? 'group' : 'groups'}</h3>
              ${basisRows.length === 0 ? html`
                <div class="iat-readout">No grouped rows came back. The basis accounts may not have any postings tagged with a <strong>${splitDimName}</strong> for this period, or the dimension filters may exclude everything.</div>
              ` : html`
                <table class="iat-table">
                  <thead><tr><th>${splitDimName}</th><th class="iat-num" style=${{ width: '120px' }}>Basis</th><th style=${{ width: '160px' }}>Share</th><th class="iat-num" style=${{ width: '160px' }}>Allocation</th></tr></thead>
                  <tbody>
                    ${basisRows.map((r, i) => html`
                      <tr key=${r.id || i}>
                        <td>
                          <div style=${{ fontWeight: 500 }}>${r.name}</div>
                          <div style=${{ fontSize: '11px', color: 'var(--iat-fg-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>${r.id}</div>
                        </td>
                        <td class="iat-num">${fmtBasis.format(r.value)}</td>
                        <td>
                          <div class="iat-pctbar-cell">
                            <div class="iat-pctbar"><div class="iat-pctbar-fill" style=${{ width: (r.pct * 100).toFixed(2) + '%' }}></div></div>
                            <div class="iat-pctbar-label"><span></span><span>${fmtPct.format(r.pct)}</span></div>
                          </div>
                        </td>
                        <td class="iat-num">${fmtMoney.format(r.alloc)}</td>
                      </tr>
                    `)}
                  </tbody>
                  <tfoot><tr><td>Total</td><td class="iat-num">${fmtBasis.format(basisTotal)}</td><td>${fmtPct.format(1)}</td><td class="iat-num">${fmtMoney.format(sourceTotal)}</td></tr></tfoot>
                </table>
              `}
            </div>
          ` : null}
        </div>
      `;
    }

    // ── Step 4 right panel: JE preview + Post ───────────────────────────
    function PostContentPanel({ ctx }) {
      const {
        selectedPeriod, je, posting, postResult, canPost, postReason,
        handlePost, resetForNewAllocation,
        effectiveTargetGL, journalSymbol, postingDate, batchTitle,
        data, splitDimension,
      } = ctx;

      const splitDimName = (SPLIT_DIMS.find(d => d.id === splitDimension) || {}).name || '—';

      // Helper: human-readable dimension cell from a line
      function dimsCell(line) {
        const parts = [];
        if (line.dept) {
          const r = data.departments.find(d => d.id === line.dept);
          parts.push(html`<span><span style=${{ color: 'var(--iat-fg-muted)' }}>D:</span> ${r ? r.name : line.dept}</span>`);
        }
        if (line.loc) {
          const r = data.locations.find(d => d.id === line.loc);
          parts.push(html`<span><span style=${{ color: 'var(--iat-fg-muted)' }}>L:</span> ${r ? r.name : line.loc}</span>`);
        }
        if (line.proj) {
          const r = data.projects.find(d => d.id === line.proj);
          parts.push(html`<span><span style=${{ color: 'var(--iat-fg-muted)' }}>P:</span> ${r ? r.name : line.proj}</span>`);
        }
        if (line.cls) {
          const r = data.classes.find(d => d.id === line.cls);
          parts.push(html`<span><span style=${{ color: 'var(--iat-fg-muted)' }}>C:</span> ${r ? r.name : line.cls}</span>`);
        }
        if (parts.length === 0) return html`<span style=${{ color: 'var(--iat-fg-muted)' }}>—</span>`;
        // Interleave parts with bullet separators
        const out = [];
        parts.forEach((p, i) => { if (i) out.push(html`<span key=${'sep' + i} style=${{ color: 'var(--iat-fg-muted)', margin: '0 6px' }}>·</span>`); out.push(p); });
        return html`<span style=${{ fontSize: '11px' }}>${out}</span>`;
      }

      function renderLineTable(lines, kind) {
        if (!lines.length) return html`<div class="iat-readout">No ${kind} lines.</div>`;
        return html`
          <table class="iat-table">
            <thead><tr><th style=${{ width: '110px' }}>Account</th><th>Description</th><th>Dimensions</th><th class="iat-num" style=${{ width: '140px' }}>Amount</th></tr></thead>
            <tbody>
              ${lines.map((l, i) => html`
                <tr key=${i}>
                  <td style=${{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>${l.gl}</td>
                  <td style=${{ fontSize: '12px' }}>${l.desc}</td>
                  <td>${dimsCell(l)}</td>
                  <td class="iat-num">${fmtMoney.format(l.amount)}</td>
                </tr>
              `)}
            </tbody>
            <tfoot><tr><td colspan="3">Total</td><td class="iat-num">${fmtMoney.format(lines.reduce((s, l) => s + l.amount, 0))}</td></tr></tfoot>
          </table>
        `;
      }

      // Success result — show batch number and reset button
      if (postResult && postResult.success) {
        return html`
          <div style=${{ maxWidth: '720px' }}>
            <h2 class="iat-panel-h1">Journal entry posted</h2>
            <p class="iat-panel-sub">${selectedPeriod.name} · ${postingDate}</p>
            <div class="iat-result iat-result-success">
              <div class="iat-result-success-title">✓ Posted to Sage Intacct</div>
              <div class="iat-result-success-detail">
                Batch <span class="iat-result-success-key">${postResult.key}</span> created in journal <strong>${journalSymbol}</strong>.
              </div>
            </div>
            <div style=${{ marginTop: '20px', display: 'flex', gap: '10px' }}>
              <button class="iat-btn-primary" onClick=${resetForNewAllocation}>New allocation</button>
              <button class="iat-btn-secondary" onClick=${closeOverlay}>Close</button>
            </div>
          </div>
        `;
      }

      return html`
        <div style=${{ maxWidth: '960px' }}>
          <h2 class="iat-panel-h1">Journal entry preview</h2>
          <p class="iat-panel-sub">${selectedPeriod ? selectedPeriod.name + ' · ' + selectedPeriod.startDate + ' → ' + selectedPeriod.endDate : ''}</p>

          ${je ? html`
            <div class="iat-minicards">
              <div class="iat-minicard"><div class="iat-minicard-label">Lines</div><div class="iat-minicard-value">${je.lines.length}</div></div>
              <div class="iat-minicard"><div class="iat-minicard-label">Total debits</div><div class="iat-minicard-value">${fmtMoney.format(je.totalDr)}</div></div>
              <div class="iat-minicard"><div class="iat-minicard-label">Total credits</div><div class="iat-minicard-value">${fmtMoney.format(je.totalCr)}</div></div>
              <div class=${'iat-minicard ' + (je.balanced ? 'iat-minicard-success' : 'iat-minicard-danger')}>
                <div class="iat-minicard-label">${je.balanced ? 'Balanced' : 'Out of balance'}</div>
                <div class="iat-minicard-value">${je.balanced ? '✓' : fmtMoney.format(je.totalDr - je.totalCr)}</div>
              </div>
            </div>

            <div class="iat-chip-row">
              <span class="iat-chip"><span class="iat-chip-key">Target GL</span>${effectiveTargetGL || '—'}</span>
              <span class="iat-chip"><span class="iat-chip-key">Journal</span>${journalSymbol || '—'}</span>
              <span class="iat-chip"><span class="iat-chip-key">Date</span>${postingDate || '—'}</span>
              ${je.negativePool ? html`<span class="iat-chip" style=${{ background: 'var(--iat-warning-soft)', color: 'var(--iat-warning)' }}><span class="iat-chip-key">Pool</span>negative — DR/CR flipped</span>` : null}
            </div>

            <div class="iat-panel-section">
              <h3 class="iat-panel-h2">${je.negativePool ? 'Credits' : 'Debits'} · target lines · ${fmtNum.format(je.targetLines.length)} (split by ${splitDimName})</h3>
              ${renderLineTable(je.targetLines, 'target')}
            </div>

            <div class="iat-panel-section">
              <h3 class="iat-panel-h2">${je.negativePool ? 'Debits' : 'Credits'} · source reversal · ${fmtNum.format(je.creditLines.length)}</h3>
              ${renderLineTable(je.creditLines, 'source reversal')}
            </div>
          ` : html`
            <div class="iat-warning">${postReason || 'Complete the previous steps to compute the journal entry.'}</div>
          `}

          ${postResult && !postResult.success ? html`
            <div class="iat-error">
              <div class="iat-error-title">Posting failed</div>
              <div class="iat-error-detail">${postResult.error || 'Unknown error'}${postResult.sageDetail && postResult.sageDetail.correction ? '\n\nCorrection: ' + postResult.sageDetail.correction : ''}</div>
            </div>
          ` : null}

          <div class="iat-postbar">
            <div class="iat-postbar-info">
              <div class="iat-postbar-info-title">${canPost ? 'Ready to post' : 'Not ready to post'}</div>
              <div class="iat-postbar-info-detail">${postReason || 'A confirmation dialog appears before anything is sent to Sage.'}</div>
            </div>
            <button class="iat-btn-primary" disabled=${!canPost} onClick=${handlePost}>
              ${posting ? html`<span class="iat-spinner iat-spinner-sm" style=${{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.3)' }}></span> Posting…` : 'Post to Sage'}
            </button>
            ${postResult && !postResult.success ? html`
              <button class="iat-btn-secondary" onClick=${() => ctx.handlePost()} disabled=${posting}>Retry</button>
            ` : null}
          </div>
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
  console.log('[IntacctAllocationTool] launcher attached — Phase 4 (full end-to-end allocation flow)');
})();
