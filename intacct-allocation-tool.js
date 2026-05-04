// intacct-allocation-tool.js — ported entry for the Sage Intacct Allocation
// Tool, running inside an Intacct customization page.
//
// Architecture:
//   1. Page script (in Intacct's customization editor) loads
//      intacct-sage-client.js, then this file.
//   2. This file mounts the allocation tool directly into the page on load,
//      sized to fill the Intacct customization frame.
//   3. The customization page IS the allocation tool — no launcher button,
//      no modal overlay. Loading state shows while deps + reference data
//      fetch, then the React UI replaces it in place.
//   4. localStorage caches list data so re-loads are instant.
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
  const OVERLAY_ID  = 'iat-app-frame';
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
      /* Full-frame container — fills the Intacct customization iframe */
      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 100;
        background: var(--iat-bg, #fff);
        display: flex; flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
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
      .iat-step-toggle {
        width: 22px; height: 22px; padding: 0;
        background: transparent; border: 1px solid transparent;
        color: var(--iat-fg-muted);
        cursor: pointer; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 11px; line-height: 1; flex-shrink: 0;
        transition: background .12s, color .12s, border-color .12s;
      }
      .iat-step-toggle:hover { background: var(--iat-bg-soft); color: var(--iat-fg); border-color: var(--iat-border); }
      .iat-step-toggle:focus { outline: none; border-color: var(--iat-accent); box-shadow: 0 0 0 3px var(--iat-accent-soft); }
      .iat-step-chev { display: inline-block; transition: transform .15s ease; line-height: 1; }
      .iat-step.collapsed .iat-step-chev { transform: rotate(-90deg); }
      .iat-step.collapsed { padding-bottom: 12px; }
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

      /* ─── Right-panel rework: panel cards + tables (mirrors original) ─── */
      .iat-content {
        padding: 16px 20px;
        display: flex; flex-direction: column; gap: 14px;
      }
      .iat-app[data-theme="light"] .iat-content {
        background-image:
          linear-gradient(rgba(0,0,0,.045) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0,0,0,.045) 1px, transparent 1px);
        background-size: 20px 20px;
      }
      .iat-app[data-theme="dark"] .iat-content {
        background-image:
          linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
        background-size: 20px 20px;
      }

      .iat-panel-card {
        background: var(--iat-bg-card);
        border: 1px solid var(--iat-border);
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
      }
      .iat-panel-card-header {
        padding: 10px 16px;
        background: var(--iat-bg-soft);
        cursor: pointer; user-select: none;
        display: flex; flex-direction: column; gap: 0;
        transition: background .1s, filter .1s;
      }
      .iat-panel-card-header:hover { filter: brightness(1.03); }
      .iat-panel-card-header-row {
        display: flex; align-items: center; gap: 8px; width: 100%;
      }
      .iat-panel-card-header.open .iat-panel-card-header-row {
        padding-bottom: 6px;
        border-bottom: 1px solid var(--iat-border);
      }
      .iat-panel-card-icon {
        width: 14px; height: 14px; flex-shrink: 0;
        color: var(--iat-fg-muted);
      }
      .iat-panel-card-title {
        font-size: 13px; font-weight: 600; color: var(--iat-fg);
        letter-spacing: -0.1px;
      }
      .iat-panel-card-sub {
        font-size: 12px; color: var(--iat-fg-muted);
        padding-top: 6px;
      }
      .iat-panel-card-chev {
        margin-left: auto; flex-shrink: 0;
        color: var(--iat-fg-muted);
        transition: transform .2s;
      }
      .iat-panel-card-header.open .iat-panel-card-chev {
        transform: rotate(90deg);
      }
      .iat-panel-card-body { display: block; }
      .iat-panel-card-filter-chips {
        display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
        padding-top: 6px;
      }
      .iat-panel-card-filter-label {
        font-size: 12px; color: var(--iat-fg-muted);
      }

      /* data-table — used by Pool & Basis cards */
      .iat-data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .iat-data-table th {
        background: var(--iat-bg-soft); color: var(--iat-fg-muted);
        font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .03em;
        padding: 8px 14px; text-align: left;
        border-bottom: 1px solid var(--iat-border);
      }
      .iat-data-table th.r { text-align: right; }
      .iat-data-table td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--iat-border-soft);
        color: var(--iat-fg); vertical-align: middle;
      }
      .iat-data-table td.r {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .iat-data-table tr:last-child td { border-bottom: none; }
      .iat-data-table tbody tr:hover td { background: var(--iat-bg-soft); }
      .iat-data-table .iat-total-row td {
        background: var(--iat-bg-soft); font-weight: 600;
        border-top: 1px solid var(--iat-border);
        color: var(--iat-fg);
      }

      /* je-table — dark header, REALLOC/REVERSAL row tints */
      .iat-je-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .iat-je-table th {
        background: #18181b; color: #a1a1aa;
        font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .03em;
        padding: 9px 14px; text-align: left;
      }
      .iat-app[data-theme="dark"] .iat-je-table th {
        background: #0a0a0b; color: #71717a;
      }
      .iat-je-table th.r { text-align: right; }
      .iat-je-table td {
        padding: 8px 14px;
        border-bottom: 1px solid var(--iat-border-soft);
        color: var(--iat-fg); vertical-align: middle;
      }
      .iat-je-table td.r {
        text-align: right;
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .iat-je-table tr:last-child td { border-bottom: none; }
      .iat-je-table .iat-row-realloc td  { background: rgba(200,112,85,.07);  border-bottom-color: rgba(200,112,85,.12); }
      .iat-je-table .iat-row-reversal td { background: rgba(59,130,246,.07);  border-bottom-color: rgba(59,130,246,.12); }
      .iat-je-table tr.iat-row-realloc:hover td  { background: rgba(200,112,85,.13); }
      .iat-je-table tr.iat-row-reversal:hover td { background: rgba(59,130,246,.13); }
      .iat-je-table .iat-total-row td {
        background: #18181b; color: #a1a1aa;
        font-weight: 600;
        border-top: 1px solid rgba(255,255,255,.06);
      }
      .iat-app[data-theme="dark"] .iat-je-table .iat-total-row td {
        background: #0a0a0b; color: #71717a;
      }
      .iat-je-table .iat-total-row td.r { color: #fafafa; }

      /* JE chips */
      .iat-chip-realloc {
        display: inline-flex; align-items: center;
        padding: 2px 6px; border-radius: 4px;
        font-size: 11px; font-weight: 500;
        background: var(--iat-accent-soft); color: var(--iat-accent);
      }
      .iat-chip-reversal {
        display: inline-flex; align-items: center;
        padding: 2px 6px; border-radius: 4px;
        font-size: 11px; font-weight: 500;
        background: rgba(59,130,246,.10); color: #3b82f6;
      }
      .iat-app[data-theme="dark"] .iat-chip-reversal {
        background: rgba(59,130,246,.15); color: #93c5fd;
      }
      .iat-chip-dim {
        display: inline-flex; align-items: center;
        padding: 2px 6px; border-radius: 4px;
        font-size: 11px; font-weight: 500;
        background: var(--iat-bg-soft); color: var(--iat-fg-soft);
      }

      /* PctBar */
      .iat-pct-bar {
        width: 100%; background: var(--iat-border);
        border-radius: 9999px; height: 5px; overflow: hidden;
      }
      .iat-pct-bar-fill {
        height: 100%; border-radius: 9999px;
        background: var(--iat-accent);
        transition: width .5s ease;
      }

      /* Action bar (bottom of JE preview card) */
      .iat-action-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px;
        background: var(--iat-bg-soft);
        border-top: 1px solid var(--iat-border);
      }
      .iat-balance-ok {
        font-size: 12px; font-weight: 600;
        color: var(--iat-success);
        display: flex; align-items: center; gap: 5px;
      }
      .iat-balance-off {
        font-size: 12px; font-weight: 600;
        color: var(--iat-danger);
        display: flex; align-items: center; gap: 5px;
      }
      .iat-action-buttons { display: flex; gap: 8px; }
      .iat-btn-ghost {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 8px 14px; border-radius: 5px;
        background: var(--iat-bg-soft); color: var(--iat-fg-soft);
        border: 1px solid var(--iat-border);
        font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit;
        transition: background .12s, color .12s, border-color .12s;
      }
      .iat-btn-ghost:hover:not(:disabled) {
        background: var(--iat-border-soft); color: var(--iat-fg);
        border-color: var(--iat-fg-muted);
      }
      .iat-btn-post {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 9px 20px; border-radius: 5px;
        background: var(--iat-accent); color: #fff; border: none;
        font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
        transition: filter .12s;
      }
      .iat-btn-post:hover:not(:disabled) { filter: brightness(1.1); }
      .iat-btn-post:disabled { opacity: .4; cursor: not-allowed; }

      /* Empty state inside a panel-card */
      .iat-panel-empty {
        text-align: center; padding: 36px 20px;
        color: var(--iat-fg-muted);
      }
      .iat-panel-empty-icon {
        font-size: 28px; opacity: .4; margin-bottom: 10px;
      }
      .iat-panel-empty-text {
        font-size: 13px; line-height: 1.6; color: var(--iat-fg-muted);
      }

      /* JE form row above the table */
      .iat-je-form-row {
        padding: 12px 16px 14px;
        display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 10px;
      }
      .iat-je-form-row .iat-label { margin-bottom: 4px; }

      /* Result banners (success/error) inside JE card */
      .iat-banner-success {
        margin: 12px 16px 0;
        background: var(--iat-success-soft);
        border: 1px solid var(--iat-success);
        border-radius: 6px; overflow: hidden;
      }
      .iat-banner-success-row {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px;
        font-size: 12px; font-weight: 600; color: var(--iat-success);
      }
      .iat-banner-error {
        margin: 12px 16px 0;
        background: var(--iat-danger-soft);
        border: 1px solid var(--iat-danger);
        border-radius: 6px; overflow: hidden;
      }
      .iat-banner-error-row {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 8px 12px;
        font-size: 12px; font-weight: 600; color: var(--iat-danger);
        word-break: break-word;
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

  // ── Mount ─────────────────────────────────────────────────────────────────
  // Inject a single full-frame container into document.body and render the
  // app inside it. Idempotent — if called twice, it just no-ops on the second
  // call rather than double-mounting.
  function mountApp() {
    if (document.getElementById(OVERLAY_ID)) return;
    const container = document.createElement('div');
    container.id = OVERLAY_ID;
    container.innerHTML = '<div id="' + ROOT_ID + '" style="flex:1;display:flex;flex-direction:column;overflow:hidden;"></div>';
    document.body.appendChild(container);
    bootstrapApp();
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

      // Collapse/expand for each sidebar step. Default: only the active step
      // is expanded; the other three start collapsed so the sidebar isn't a
      // tall scroll. Activating a step auto-expands it; the chevron lets the
      // user override either way.
      const [collapsedSteps, setCollapsedSteps] = useState(() => new Set([2, 3, 4]));
      const toggleStepCollapsed = (n) => {
        setCollapsedSteps(prev => {
          const next = new Set(prev);
          if (next.has(n)) next.delete(n); else next.add(n);
          return next;
        });
      };

      // Right-panel cards collapse independently. All three are open by
      // default so the user sees the running result as they fill the form.
      const [panelOpen, setPanelOpen] = useState({ pool: true, basis: true, je: true });
      const togglePanel = (k) => setPanelOpen(p => ({ ...p, [k]: !p[k] }));

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

      // When the active step changes, make sure it's expanded.
      useEffect(() => {
        setCollapsedSteps(prev => {
          if (!prev.has(activeStep)) return prev;
          const next = new Set(prev);
          next.delete(activeStep);
          return next;
        });
      }, [activeStep]);

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
        // right-panel collapse
        panelOpen, togglePanel,
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
                collapsed=${collapsedSteps.has(1)}
                onToggle=${() => toggleStepCollapsed(1)}
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
                collapsed=${collapsedSteps.has(2)} onToggle=${() => toggleStepCollapsed(2)}
              ><${SourceStepBody} ctx=${ctx} /><//>

              <${StepCard} num=${3} title="Allocation basis" status=${stepStatus(3)}
                onActivate=${() => stepDone[2] && setActiveStep(3)} disabled=${!stepDone[2]}
                collapsed=${collapsedSteps.has(3)} onToggle=${() => toggleStepCollapsed(3)}
              ><${BasisStepBody} ctx=${ctx} /><//>

              <${StepCard} num=${4} title="Target & post" status=${stepStatus(4)}
                onActivate=${() => stepDone[3] && setActiveStep(4)} disabled=${!stepDone[3]}
                collapsed=${collapsedSteps.has(4)} onToggle=${() => toggleStepCollapsed(4)}
              ><${TargetStepBody} ctx=${ctx} /><//>
            </aside>

            <main class="iat-content">
              <${RightPanel} ctx=${ctx} />
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

    function StepCard({ num, title, status, onActivate, disabled, collapsed, onToggle, children }) {
      const cls = 'iat-step'
        + (status === 'active' ? ' active' : status === 'done' ? ' done' : '')
        + (collapsed ? ' collapsed' : '');
      const handleClick = (e) => {
        if (disabled) return;
        const tag = e.target.tagName;
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON' || tag === 'LABEL' || tag === 'TEXTAREA') return;
        if (onActivate) onActivate();
      };
      const handleToggle = (e) => {
        e.stopPropagation();
        if (onToggle) onToggle();
      };
      return html`
        <section class=${cls} onClick=${handleClick} style=${{ cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
          <div class="iat-step-head">
            <div class="iat-step-num">${status === 'done' ? '✓' : num}</div>
            <div class="iat-step-title">${title}</div>
            <button
              type="button"
              class="iat-step-toggle"
              aria-label=${collapsed ? 'Expand step' : 'Collapse step'}
              aria-expanded=${collapsed ? 'false' : 'true'}
              title=${collapsed ? 'Expand' : 'Collapse'}
              onClick=${handleToggle}
            ><span class="iat-step-chev">▾</span></button>
          </div>
          ${collapsed ? null : html`<div class="iat-step-body">${children}</div>`}
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
          <span class="iat-label">Line description (optional)</span>
          <input id="iat-tgt-desc" class="iat-input" type="text" placeholder="(auto-generated)" value=${ctx.jeDescription}
            onChange=${(e) => ctx.setJeDescription(e.target.value)} />
          <div class="iat-step-status" style=${{ marginTop: '4px' }}>Posting date, journal type, and batch title live in the Journal Entry Preview panel.</div>
        </div>
      `;
    }

    // ── Right panel: three stacked panel-cards (mirrors original UI) ──
    function RightPanel({ ctx }) {
      return html`
        <${PoolPanel}  ctx=${ctx} />
        <${BasisPanel} ctx=${ctx} />
        <${JePanel}    ctx=${ctx} />
      `;
    }

    // SVG icons used in the panel-card headers (greyscale, currentColor).
    // Each branch returns a self-contained <svg> with explicit attributes —
    // we avoid spreading because htm's spread doesn't normalize `class` →
    // `className` for React.
    function PanelIcon({ name }) {
      if (name === 'db') {
        return html`<svg class="iat-panel-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`;
      }
      if (name === 'chart') {
        return html`<svg class="iat-panel-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
      }
      if (name === 'file') {
        return html`<svg class="iat-panel-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
      }
      return null;
    }

    // Reusable panel-card with a clickable header row, optional sub line,
    // optional filter chips strip, and a body that hides when collapsed.
    function PanelCard({ icon, title, sub, filterChips, open, onToggle, children }) {
      return html`
        <section class="iat-panel-card">
          <div class=${'iat-panel-card-header' + (open ? ' open' : '')} onClick=${onToggle}>
            <div class="iat-panel-card-header-row">
              <${PanelIcon} name=${icon} />
              <span class="iat-panel-card-title">${title}</span>
              <svg class="iat-panel-card-chev" width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
            ${sub ? html`<span class="iat-panel-card-sub">${sub}</span>` : null}
            ${filterChips ? html`<div class="iat-panel-card-filter-chips">${filterChips}</div>` : null}
          </div>
          ${open ? html`<div class="iat-panel-card-body">${children}</div>` : null}
        </section>
      `;
    }

    // Render a stylized empty state inside a panel-card body.
    function PanelEmpty({ icon, children }) {
      return html`
        <div class="iat-panel-empty">
          <div class="iat-panel-empty-icon">${icon}</div>
          <div class="iat-panel-empty-text">${children}</div>
        </div>
      `;
    }

    // Render a small filter-chip row for whichever dimensions are set.
    function dimFilterChips({ loc, dept, cls, proj, data }) {
      const items = [];
      if (loc) {
        const r = data.locations.find(x => x.id === loc);
        items.push(html`<span key="loc" class="iat-chip-dim">Loc: ${r ? r.name : loc}</span>`);
      }
      if (dept) {
        const r = data.departments.find(x => x.id === dept);
        items.push(html`<span key="dept" class="iat-chip-dim">Dept: ${r ? r.name : dept}</span>`);
      }
      if (cls) {
        const r = data.classes.find(x => x.id === cls);
        items.push(html`<span key="cls" class="iat-chip-dim">Class: ${r ? r.name : cls}</span>`);
      }
      if (proj) {
        const r = data.projects.find(x => x.id === proj);
        items.push(html`<span key="proj" class="iat-chip-dim">Proj: ${r ? r.name : proj}</span>`);
      }
      if (!items.length) return null;
      return html`
        <span class="iat-panel-card-filter-label">Filtered by:</span>
        ${items}
      `;
    }

    // ── Pool Account Balances panel ──────────────────────────────────────
    function PoolPanel({ ctx }) {
      const {
        sourceParams, sourceBalances, sourceLoading, sourceError, sourceFetched, sourceTotal,
        sourceLoc, sourceDept, sourceClass, sourceProj, data,
        panelOpen, togglePanel,
      } = ctx;

      const filterChips = dimFilterChips({
        loc: sourceLoc, dept: sourceDept, cls: sourceClass, proj: sourceProj, data,
      });

      // Group by GL account, summing period balance
      const groups = {};
      sourceBalances.forEach(r => {
        const k = r.glaccountno;
        if (!groups[k]) {
          groups[k] = { amt: 0, title: r.gltitle || ((data.glAccounts.find(g => g.id === k) || {}).name || k) };
        }
        groups[k].amt += (r.periodbalance || 0);
      });
      const rows = Object.entries(groups).sort(([a], [b]) => String(a).localeCompare(String(b)));

      let body;
      if (sourceLoading) {
        body = html`<${PanelEmpty} icon="⏳">Fetching balances from Sage Intacct…<//>`;
      } else if (sourceError) {
        body = html`<${PanelEmpty} icon="⚠">
          <span style=${{ color: 'var(--iat-danger)' }}>Error fetching balances:<br/>
            <span style=${{ fontSize: '11px', fontFamily: 'monospace' }}>${sourceError}</span>
          </span>
        <//>`;
      } else if (!sourceParams || !sourceFetched) {
        body = html`<${PanelEmpty} icon="📊">Select a GL account and location in Step 2<br/>to see the pool balances available to allocate.<//>`;
      } else if (sourceBalances.length === 0) {
        body = html`<${PanelEmpty} icon="∅">No balance found for this account<br/>in the selected period.<//>`;
      } else {
        body = html`
          <table class="iat-data-table" style=${{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style=${{ width: '18%' }}/>
              <col/>
              <col style=${{ width: '14%' }}/>
              <col style=${{ width: '20%' }}/>
            </colgroup>
            <thead>
              <tr>
                <th>GL Account</th>
                <th>Account Name</th>
                <th class="r">% of Pool</th>
                <th class="r">Balance</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(([glId, g]) => html`
                <tr key=${glId}>
                  <td style=${{ fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>${glId}</td>
                  <td style=${{ color: 'var(--iat-fg-soft)' }}>${g.title}</td>
                  <td class="r" style=${{ color: 'var(--iat-fg-soft)' }}>${sourceTotal !== 0 ? fmtPct.format(g.amt / sourceTotal) : '—'}</td>
                  <td class="r" style=${{ fontWeight: 600 }}>${fmtMoney.format(g.amt)}</td>
                </tr>
              `)}
              ${rows.length > 1 ? html`
                <tr class="iat-total-row">
                  <td colspan="2" style=${{ color: 'var(--iat-fg-soft)' }}>Total Pool</td>
                  <td class="r">100.0%</td>
                  <td class="r">${fmtMoney.format(sourceTotal)}</td>
                </tr>
              ` : null}
            </tbody>
          </table>
        `;
      }

      return html`
        <${PanelCard}
          icon="db"
          title="Pool Account Balances"
          filterChips=${filterChips}
          open=${panelOpen.pool}
          onToggle=${(e) => { e.stopPropagation(); togglePanel('pool'); }}
        >${body}<//>
      `;
    }

    // ── Basis Breakdown panel ────────────────────────────────────────────
    function BasisPanel({ ctx }) {
      const {
        sourceTotal, basisParams, basisLoading, basisError, basisFetched, basisRows, basisTotal,
        basisAcctType, basisMode, basisAccount, basisRangeFrom, basisRangeTo, basisMultiAccounts,
        splitDimension, basisLoc, basisDept, basisClass, basisProj, data,
        panelOpen, togglePanel,
      } = ctx;

      const accounts = basisAcctType === 'stat' ? data.statAccounts : data.glAccounts;
      const splitDimName = (SPLIT_DIMS.find(d => d.id === splitDimension) || {}).name || '—';
      const typeLabel = basisAcctType === 'stat' ? 'Stat' : 'GL';

      // Sub line: account selector summary + "Split by X"
      const sub = (() => {
        if (basisMode === 'single' && basisAccount) {
          const row = accounts.find(a => a.id === basisAccount);
          return `${typeLabel} ${basisAccount}${row ? ' — ' + row.name : ''}  ·  Split by ${splitDimName}`;
        }
        if (basisMode === 'range' && basisRangeFrom && basisRangeTo) {
          return `${typeLabel} accounts ${basisRangeFrom}–${basisRangeTo}  ·  Split by ${splitDimName}`;
        }
        if (basisMode === 'multi' && basisMultiAccounts.length) {
          return `${typeLabel} · ${basisMultiAccounts.length} accounts  ·  Split by ${splitDimName}`;
        }
        return 'No basis selected';
      })();

      const filterChips = dimFilterChips({
        loc: basisLoc, dept: basisDept, cls: basisClass, proj: basisProj, data,
      });

      let body;
      if (basisLoading) {
        body = html`<${PanelEmpty} icon="⏳">Fetching basis data from Sage Intacct…<//>`;
      } else if (basisError) {
        body = html`<${PanelEmpty} icon="⚠">
          <span style=${{ color: 'var(--iat-danger)' }}>Error fetching basis data:<br/>
            <span style=${{ fontSize: '11px', fontFamily: 'monospace' }}>${basisError}</span>
          </span>
        <//>`;
      } else if (!basisParams || !basisFetched) {
        body = html`<${PanelEmpty} icon="📈">Choose a basis account and split dimension in Step 3<br/>to preview the allocation weights.<//>`;
      } else if (basisRows.length === 0) {
        body = html`<${PanelEmpty} icon="∅">No basis data found for this account<br/>in the selected period.<//>`;
      } else {
        body = html`
          <table class="iat-data-table" style=${{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style=${{ width: '14%' }}/>
              <col/>
              <col style=${{ width: '14%' }}/>
              <col style=${{ width: '20%' }}/>
              <col style=${{ width: '10%' }}/>
              <col style=${{ width: '18%' }}/>
            </colgroup>
            <thead>
              <tr>
                <th>${splitDimName} ID</th>
                <th>${splitDimName} Name</th>
                <th class="r">Basis Value</th>
                <th>Weight</th>
                <th class="r">%</th>
                <th class="r">Allocated Amount</th>
              </tr>
            </thead>
            <tbody>
              ${basisRows.map((r, i) => html`
                <tr key=${r.id || ('__blank_' + i)}>
                  <td style=${{
                      fontWeight: r.id ? 600 : 400,
                      color: r.id ? 'var(--iat-fg)' : 'var(--iat-fg-muted)',
                      fontStyle: r.id ? 'normal' : 'italic',
                      fontFamily: r.id ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
                    }}>
                    ${r.id || 'Blank dimension'}
                  </td>
                  <td style=${{ color: 'var(--iat-fg-soft)' }}>${r.name && r.name !== r.id ? r.name : '—'}</td>
                  <td class="r">${fmtBasis.format(r.value)}</td>
                  <td style=${{ paddingTop: '9px', paddingBottom: '9px' }}>
                    <div class="iat-pct-bar"><div class="iat-pct-bar-fill" style=${{ width: (r.pct * 100).toFixed(2) + '%' }}></div></div>
                  </td>
                  <td class="r" style=${{ color: 'var(--iat-fg-soft)' }}>${fmtPct.format(r.pct)}</td>
                  <td class="r" style=${{ fontWeight: 600 }}>${sourceTotal !== 0 ? fmtMoney.format(r.alloc) : '—'}</td>
                </tr>
              `)}
              ${basisRows.length > 0 ? html`
                <tr class="iat-total-row">
                  <td>Total</td>
                  <td></td>
                  <td class="r">${fmtBasis.format(basisRows.reduce((s, r) => s + r.value, 0))}</td>
                  <td></td>
                  <td class="r">${fmtPct.format(1)}</td>
                  <td class="r">${sourceTotal !== 0 ? fmtMoney.format(sourceTotal) : '—'}</td>
                </tr>
              ` : null}
            </tbody>
          </table>
        `;
      }

      return html`
        <${PanelCard}
          icon="chart"
          title="Basis Breakdown"
          sub=${sub}
          filterChips=${filterChips}
          open=${panelOpen.basis}
          onToggle=${(e) => { e.stopPropagation(); togglePanel('basis'); }}
        >${body}<//>
      `;
    }

    // ── Journal Entry Preview panel (form row + combined table + action bar) ──
    function JePanel({ ctx }) {
      const {
        selectedPeriod, je, posting, postResult, canPost, postReason,
        handlePost, resetForNewAllocation,
        journalSymbol, setJournalSymbol,
        postingDate, setPostingDate,
        batchTitle, setBatchTitle,
        data,
        panelOpen, togglePanel,
      } = ctx;

      // Render a single line as a row in the combined JE table.
      function renderLine(line, idx, kind) {
        const isDr = line.trType === 1;
        const isRealloc = (kind === 'realloc');
        const glRow = data.glAccounts.find(g => g.id === line.gl);
        const glName = glRow ? glRow.name : null;

        const cellChip = (label, id, list) => {
          if (!id) return html`<span style=${{ color: 'var(--iat-fg-muted)' }}>—</span>`;
          const r = list.find(x => x.id === id);
          return html`<span class="iat-chip-dim" title=${r ? r.name : ''}>${id}</span>`;
        };

        return html`
          <tr key=${kind + '-' + idx} class=${isRealloc ? 'iat-row-realloc' : 'iat-row-reversal'}>
            <td>
              <span class=${isRealloc ? 'iat-chip-realloc' : 'iat-chip-reversal'}>
                ${isRealloc ? 'REALLOC' : 'REVERSAL'}
              </span>
            </td>
            <td style=${{ fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>${line.gl}</td>
            <td style=${{ color: 'var(--iat-fg-soft)' }}>${glName && glName !== line.gl ? glName : '—'}</td>
            <td style=${{ fontSize: '12px', color: 'var(--iat-fg-soft)' }}>${line.desc}</td>
            <td>${cellChip('D', line.dept, data.departments)}</td>
            <td>${cellChip('C', line.cls,  data.classes)}</td>
            <td>${cellChip('P', line.proj, data.projects)}</td>
            <td>${cellChip('L', line.loc,  data.locations)}</td>
            <td class="r" style=${{ fontWeight: isDr ? 600 : 'normal', color: isDr ? 'inherit' : 'var(--iat-fg-muted)' }}>${isDr ? fmtMoney.format(line.amount) : '—'}</td>
            <td class="r" style=${{ fontWeight: isDr ? 'normal' : 600, color: isDr ? 'var(--iat-fg-muted)' : 'inherit' }}>${isDr ? '—' : fmtMoney.format(line.amount)}</td>
          </tr>
        `;
      }

      // Form row above the table — Posting Date | Journal Type | Batch Title
      const formRow = html`
        <div class="iat-je-form-row">
          <div>
            <label class="iat-label" for="iat-je-date">Posting Date</label>
            <input id="iat-je-date" class="iat-input" type="date" value=${postingDate}
              onChange=${(e) => setPostingDate(e.target.value)} />
          </div>
          <div>
            <label class="iat-label" for="iat-je-jnl">Journal Type</label>
            <select id="iat-je-jnl" class="iat-select" value=${journalSymbol}
              onChange=${(e) => setJournalSymbol(e.target.value)}>
              <option value="">— select journal —</option>
              ${data.journals.map(j => html`<option key=${j.id} value=${j.id}>${j.id} — ${j.name}</option>`)}
            </select>
          </div>
          <div>
            <label class="iat-label" for="iat-je-title">Batch Title</label>
            <input id="iat-je-title" class="iat-input" type="text"
              placeholder="Allocation — period name" value=${batchTitle}
              onChange=${(e) => setBatchTitle(e.target.value)} />
          </div>
        </div>
      `;

      // Body for the JE card — depends on whether the JE is computable
      let body;
      if (!je) {
        body = html`
          ${formRow}
          <${PanelEmpty} icon="📄">
            ${postReason || html`Complete all three steps to preview<br/>the journal entry for Sage Intacct.`}
          <//>
        `;
      } else {
        const reallocCount = je.targetLines.length;
        const reversalCount = je.creditLines.length;
        body = html`
          ${formRow}

          <div style=${{ overflowX: 'auto', borderTop: '1px solid var(--iat-border)' }}>
            <table class="iat-je-table" style=${{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style=${{ width: '5%', minWidth: '78px' }}/>
                <col style=${{ width: '10%' }}/>
                <col style=${{ width: '18%' }}/>
                <col/>
                <col style=${{ width: '7%' }}/>
                <col style=${{ width: '7%' }}/>
                <col style=${{ width: '7%' }}/>
                <col style=${{ width: '7%' }}/>
                <col style=${{ width: '10%' }}/>
                <col style=${{ width: '10%' }}/>
              </colgroup>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>GL Account</th>
                  <th>Account Name</th>
                  <th>Description</th>
                  <th>Dept</th>
                  <th>Class</th>
                  <th>Project</th>
                  <th>Location</th>
                  <th class="r">Debit</th>
                  <th class="r">Credit</th>
                </tr>
              </thead>
              <tbody>
                ${je.targetLines.map((l, i) => renderLine(l, i, 'realloc'))}
                ${je.creditLines.map((l, i) => renderLine(l, i, 'reversal'))}
                <tr class="iat-total-row">
                  <td colspan="8" style=${{ fontSize: '12px' }}>
                    ${reallocCount} reallocation line${reallocCount !== 1 ? 's' : ''} + ${reversalCount} reversal line${reversalCount !== 1 ? 's' : ''}
                  </td>
                  <td class="r">${fmtMoney.format(je.totalDr)}</td>
                  <td class="r">${fmtMoney.format(je.totalCr)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          ${postResult && postResult.success ? html`
            <div class="iat-banner-success">
              <div class="iat-banner-success-row">
                <span style=${{ fontSize: '14px' }}>✓</span>
                <span>Posted to Sage Intacct — Journal Batch #${postResult.key}</span>
              </div>
            </div>
          ` : null}

          ${postResult && !postResult.success ? html`
            <div class="iat-banner-error">
              <div class="iat-banner-error-row">
                <span style=${{ fontSize: '14px' }}>⚠</span>
                <span>${postResult.error || 'Posting failed'}${postResult.sageDetail && postResult.sageDetail.correction ? ' — ' + postResult.sageDetail.correction : ''}</span>
              </div>
            </div>
          ` : null}

          <div class="iat-action-bar">
            ${je.balanced
              ? html`<span class="iat-balance-ok">✓ Balanced</span>`
              : html`<span class="iat-balance-off">⚠ Out of balance by ${fmtMoney.format(Math.abs(je.totalDr - je.totalCr))}</span>`}
            <div class="iat-action-buttons">
              <button class="iat-btn-ghost" type="button" onClick=${resetForNewAllocation}>Reset</button>
              <button class="iat-btn-post" type="button"
                disabled=${!canPost && !(postResult && postResult.success)}
                onClick=${(postResult && postResult.success) ? resetForNewAllocation : handlePost}>
                ${posting ? html`<span class="iat-spinner iat-spinner-sm" style=${{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.3)' }}></span> Posting…`
                  : (postResult && postResult.success) ? '✓ Posted — start new'
                  : '↑ Post to Sage Intacct'}
              </button>
            </div>
          </div>
        `;
      }

      const sub = selectedPeriod ? `Period: ${selectedPeriod.name}` : null;

      return html`
        <${PanelCard}
          icon="file"
          title="Journal Entry Preview"
          sub=${sub}
          open=${panelOpen.je}
          onToggle=${(e) => { e.stopPropagation(); togglePanel('je'); }}
        >${body}<//>
      `;
    }

    ReactDOM.createRoot(rootEl).render(html`<${App} />`);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  injectStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountApp);
  } else {
    mountApp();
  }
  console.log('[IntacctAllocationTool] mounting inline — Phase 4 panel-card display');
})();
