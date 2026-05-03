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
// CURRENT STATUS: Phase 1 — Frame + Step 1 (Period selection).
//   • Header with theme toggle (light/dark, persisted)
//   • 4-step navigation indicator
//   • Sidebar layout (336px) with step cards
//   • Step 1: Period selector wired to live Sage data via getPeriods()
//   • Right panel: placeholder for journal entry display
//   Steps 2–4 (Source, Basis, Target/Post) and saved-allocations panel are
//   the next build phases.
//
// Dependencies (all expected to live on the same GitHub Pages origin as this
// file — derived automatically from this script's own src):
//   react.production.min.js          — React 18.2 UMD build
//   react-dom.production.min.js      — ReactDOM 18.2 UMD build
//   htm.umd.js                       — htm@3.1.1 (~1KB tagged-template helper)
//   intacct-sage-client.js           — preloaded by the page script
//
// Self-hosting these on GitHub Pages avoids needing to add unpkg.com or
// jsdelivr.net to Intacct's allowed-content list, and keeps the entire
// dependency chain on one origin you control.
//
// One-time setup: download these three files into the same folder as the
// rest of your scripts and push to GitHub Pages:
//   curl -o react.production.min.js     https://unpkg.com/react@18.2.0/umd/react.production.min.js
//   curl -o react-dom.production.min.js https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js
//   curl -o htm.umd.js                  https://unpkg.com/htm@3.1.1/dist/htm.umd.js

(function () {
  'use strict';

  // ── IDs & constants ───────────────────────────────────────────────────────
  const STYLE_ID    = 'iat-style';
  const LAUNCHER_ID = 'iat-launcher';
  const OVERLAY_ID  = 'iat-overlay';
  const ROOT_ID     = 'iat-root';
  const THEME_KEY   = 'iat-theme';

  // Derive the base URL from this script's own src so dependencies load from
  // the same origin (GitHub Pages) without hard-coding the user/repo path.
  const SELF_SRC = (() => {
    if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    const all = document.querySelectorAll('script[src*="intacct-allocation-tool"]');
    return (all[all.length - 1] && all[all.length - 1].src) || '';
  })();
  const BASE_URL      = SELF_SRC.replace(/[^/]+$/, '');
  const REACT_URL     = BASE_URL + 'react.production.min.js';
  const REACT_DOM_URL = BASE_URL + 'react-dom.production.min.js';
  const HTM_URL       = BASE_URL + 'htm.umd.js';

  // ── Defensive: Sage client must be present ───────────────────────────────
  if (!window.IntacctSageClient) {
    console.error('[IntacctAllocationTool] IntacctSageClient missing — load intacct-sage-client.js first');
    return;
  }

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
      .iat-step-status {
        font-size: 11px; color: var(--iat-fg-muted);
      }
      .iat-step-body { display: flex; flex-direction: column; gap: 8px; }

      /* ── Form controls ────────────────────────────────────────────────── */
      .iat-label {
        font-size: 11px; font-weight: 600; color: var(--iat-fg-soft);
        text-transform: uppercase; letter-spacing: .04em;
      }
      .iat-select {
        width: 100%;
        padding: 8px 10px;
        background: var(--iat-bg);
        border: 1px solid var(--iat-border);
        border-radius: 6px;
        color: var(--iat-fg);
        font-size: 13px; font-family: inherit;
        cursor: pointer;
        transition: border-color .12s, box-shadow .12s;
      }
      .iat-select:hover  { border-color: var(--iat-fg-muted); }
      .iat-select:focus  { outline: none; border-color: var(--iat-accent); box-shadow: 0 0 0 3px var(--iat-accent-soft); }
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
      @keyframes iat-spin { to { transform: rotate(360deg); } }
      .iat-loading-msg { font-size: 13px; }
      .iat-loading-detail { font-size: 11px; color: var(--iat-fg-muted, #a1a1aa); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      .iat-error {
        margin: 32px; padding: 20px;
        background: var(--iat-danger-soft, #fef2f2); border: 1px solid #fecaca; border-radius: 8px;
        color: var(--iat-danger, #991b1b);
      }
      .iat-error-title { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
      .iat-error-detail { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
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

  // ── Bootstrap: load deps, preload reference lists, render React app ─────
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

  // ── React app: frame + Step 1 ────────────────────────────────────────────
  function mountReactApp(rootEl, data) {
    const React    = window.React;
    const ReactDOM = window.ReactDOM;
    const htm      = window.htm;
    const html     = htm.bind(React.createElement);
    const { useState, useMemo, useEffect } = React;

    function App() {
      const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
      const [activeStep, setActiveStep] = useState(1);
      const [periodName, setPeriodName] = useState('');

      useEffect(() => { localStorage.setItem(THEME_KEY, theme); }, [theme]);

      const selectedPeriod = useMemo(
        () => data.periods.find(p => p.name === periodName) || null,
        [periodName]
      );

      // Step completion state — Step 1 is "done" once a period is picked.
      const stepStatus = (n) => {
        if (n === 1) return periodName ? 'done' : (activeStep === 1 ? 'active' : '');
        if (n === activeStep) return 'active';
        return '';
      };

      const onPickPeriod = (e) => {
        const v = e.target.value;
        setPeriodName(v);
        if (v && activeStep === 1) setActiveStep(2);
      };

      return html`
        <div class="iat-app" data-theme=${theme}>
          <header class="iat-app-header">
            <div class="iat-app-icon">A</div>
            <div class="iat-app-title">
              Allocation Tool
              <span class="iat-app-title-sub">Phase 1 · in-Intacct deployment</span>
            </div>
            <div class="iat-app-actions">
              <button
                class="iat-icon-btn"
                type="button"
                title=${theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >${theme === 'dark' ? '☀' : '☾'}</button>
              <button
                class="iat-close-btn"
                type="button"
                aria-label="Close"
                onClick=${closeOverlay}
              >×</button>
            </div>
          </header>

          <div class="iat-app-body">
            <aside class="iat-sidebar">
              <${StepNav} activeStep=${activeStep} done=${{ 1: !!periodName }} />

              <${StepCard}
                num=${1}
                title="Period"
                status=${stepStatus(1)}
                onActivate=${() => setActiveStep(1)}
              >
                <label class="iat-label" for="iat-period-select">Reporting period</label>
                <select
                  id="iat-period-select"
                  class="iat-select"
                  value=${periodName}
                  onChange=${onPickPeriod}
                >
                  <option value="">— select a period —</option>
                  ${data.periods.map(p => html`
                    <option key=${p.name} value=${p.name}>${p.name}</option>
                  `)}
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
                <div class="iat-step-status">
                  ${periodName ? 'Coming in Phase 2' : 'Pick a period first'}
                </div>
              <//>

              <${StepCard}
                num=${3}
                title="Allocation basis"
                status=${stepStatus(3)}
                onActivate=${() => periodName && setActiveStep(3)}
                disabled=${!periodName}
              >
                <div class="iat-step-status">Coming in Phase 3</div>
              <//>

              <${StepCard}
                num=${4}
                title="Target & post"
                status=${stepStatus(4)}
                onActivate=${() => periodName && setActiveStep(4)}
                disabled=${!periodName}
              >
                <div class="iat-step-status">Coming in Phase 4</div>
              <//>
            </aside>

            <main class="iat-content">
              <${ContentPanel}
                activeStep=${activeStep}
                selectedPeriod=${selectedPeriod}
                data=${data}
              />
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
        return html`<span key=${'d' + n} class=${cls.join(' ')}>${n}</span>`;
      });
      // Interleave dots with separator lines
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

    // Collapsible step card (passive in Phase 1 — full collapse toggle in later phases).
    function StepCard({ num, title, status, onActivate, disabled, children }) {
      const cls = 'iat-step' + (status === 'active' ? ' active' : status === 'done' ? ' done' : '');
      const handleClick = (e) => {
        if (disabled) return;
        // Don't re-activate if clicking inside form controls
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
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

    // Right panel — empty for Phase 1 since the journal entry is a Phase 4 deliverable.
    function ContentPanel({ activeStep, selectedPeriod, data }) {
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
      // Phase 1 placeholder — once a period is picked, show a confirmation summary
      // until later phases fill in the source pool, basis, and journal entry views.
      return html`
        <div style=${{ maxWidth: '720px' }}>
          <h2 style=${{ fontSize: '18px', fontWeight: 600, margin: '0 0 6px', letterSpacing: '-0.3px' }}>
            ${selectedPeriod.name}
          </h2>
          <p style=${{ fontSize: '13px', color: 'var(--iat-fg-soft)', margin: '0 0 24px' }}>
            ${selectedPeriod.startDate} through ${selectedPeriod.endDate}
          </p>
          <div style=${{
            padding: '16px', border: '1px solid var(--iat-border)',
            borderRadius: '8px', background: 'var(--iat-bg-soft)',
            fontSize: '13px', color: 'var(--iat-fg-soft)', lineHeight: 1.55,
          }}>
            Period selected. The next phase wires up the <strong>source pool</strong>
            selector — source GL account(s), dimension filters, and a live balance fetch
            against this period.
            <div style=${{ marginTop: '12px', fontSize: '11px', color: 'var(--iat-fg-muted)' }}>
              Reference data loaded:&nbsp;
              ${data.glAccounts.length} GL · ${data.statAccounts.length} stat · ${data.departments.length} depts ·
              ${data.locations.length} locs · ${data.projects.length} projects · ${data.classes.length} classes ·
              ${data.periods.length} periods · ${data.journals.length} journals
            </div>
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
  console.log('[IntacctAllocationTool] launcher attached — Phase 1 (Frame + Step 1)');
})();
