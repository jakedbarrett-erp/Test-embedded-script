// intacct-allocation-tool.js — ported entry for the Sage Intacct Allocation
// Tool, running inside an Intacct customization page.
//
// Architecture:
//   1. Page script (in Intacct's customization editor) loads
//      intacct-sage-client.js, then this file.
//   2. This file injects a launcher button into Intacct's page.
//   3. Click → fullscreen overlay opens (95vw × 95vh modal).
//   4. Overlay opens with a loading state, preloads all reference lists via
//      IntacctSageClient (Promise.all over 8 lists), then renders the app.
//   5. Esc or X closes the overlay; state persists for re-open within session.
//
// CURRENT STATUS: scaffold + data-flow smoke test. The launcher, overlay,
// preload, and a "verify" panel that displays counts of each loaded list are
// in place. The full React UI (port of allocation-tool.html) is the next
// build step.
//
// Dependencies (auto-loaded if missing):
//   React 18.2 from CDN
//   ReactDOM 18.2 from CDN
//   IntacctSageClient (loaded by page script before this file)

(function () {
  'use strict';

  // ── IDs & constants ───────────────────────────────────────────────────────
  const STYLE_ID    = 'iat-style';
  const LAUNCHER_ID = 'iat-launcher';
  const OVERLAY_ID  = 'iat-overlay';
  const ROOT_ID     = 'iat-root';
  const REACT_URL     = 'https://unpkg.com/react@18.2.0/umd/react.production.min.js';
  const REACT_DOM_URL = 'https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js';

  // ── Defensive: check Sage client is present ──────────────────────────────
  if (!window.IntacctSageClient) {
    console.error('[IntacctAllocationTool] IntacctSageClient missing — load intacct-sage-client.js first');
    return;
  }

  // ── Styles (scoped to our IDs so we cannot affect Intacct's UI) ──────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
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

      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 999999;
        background: rgba(15, 15, 20, 0.55);
        backdrop-filter: blur(2px);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
      }
      #${OVERLAY_ID} .iat-modal {
        width: 95vw; height: 95vh;
        background: #ffffff;
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
      #${OVERLAY_ID} .iat-modal-header {
        display: flex; align-items: center; gap: 12px;
        padding: 14px 20px;
        border-bottom: 1px solid #e4e4e7;
        background: #fafafa;
        flex-shrink: 0;
      }
      #${OVERLAY_ID} .iat-modal-icon {
        width: 28px; height: 28px; border-radius: 6px;
        background: #C87055; color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 13px; flex-shrink: 0;
      }
      #${OVERLAY_ID} .iat-modal-title {
        flex: 1; font-size: 15px; font-weight: 600; letter-spacing: -0.2px; color: #18181b;
      }
      #${OVERLAY_ID} .iat-modal-subtitle {
        font-size: 12px; color: #71717a; font-weight: 400; margin-left: 8px;
      }
      #${OVERLAY_ID} .iat-close {
        width: 32px; height: 32px; border: 1px solid #e4e4e7; background: #fff;
        color: #71717a; cursor: pointer; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; line-height: 1;
        transition: background .12s, border-color .12s, color .12s;
      }
      #${OVERLAY_ID} .iat-close:hover { background: #f4f4f5; border-color: #d4d4d8; color: #18181b; }

      #${ROOT_ID} { flex: 1; overflow: auto; }

      .iat-loading {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        height: 100%; gap: 14px; color: #52525b;
      }
      .iat-spinner {
        width: 36px; height: 36px; border-radius: 50%;
        border: 3px solid #e4e4e7; border-top-color: #C87055;
        animation: iat-spin 0.8s linear infinite;
      }
      @keyframes iat-spin { to { transform: rotate(360deg); } }
      .iat-loading-msg { font-size: 13px; }
      .iat-loading-detail { font-size: 11px; color: #a1a1aa; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      .iat-error {
        margin: 32px; padding: 20px;
        background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;
        color: #991b1b;
      }
      .iat-error-title { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
      .iat-error-detail { font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }

      .iat-verify {
        max-width: 720px; margin: 32px auto; padding: 0 24px;
      }
      .iat-verify h2 { font-size: 16px; font-weight: 600; color: #18181b; margin: 0 0 6px; letter-spacing: -0.2px; }
      .iat-verify-lead { font-size: 13px; color: #52525b; margin: 0 0 20px; }
      .iat-verify-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px;
      }
      .iat-verify-card {
        padding: 12px 14px;
        border: 1px solid #e4e4e7; border-radius: 8px; background: #fff;
      }
      .iat-verify-card-label { font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: .03em; }
      .iat-verify-card-value { font-size: 22px; font-weight: 600; color: #18181b; margin-top: 2px; letter-spacing: -0.5px; }
      .iat-verify-card-detail { font-size: 11px; color: #a1a1aa; margin-top: 4px; }
      .iat-verify-foot { margin-top: 24px; padding: 14px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; color: #166534; font-size: 12px; line-height: 1.55; }
      .iat-verify-foot strong { color: #15803d; }
    `;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Dependency loader (React + ReactDOM if missing) ──────────────────────
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
      s.crossOrigin = 'anonymous';
      s.dataset.iatSrc = url;
      s.onload  = () => { s.dataset.iatLoaded = '1'; resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  async function ensureReact() {
    if (!window.React)    await loadOnce(REACT_URL);
    if (!window.ReactDOM) await loadOnce(REACT_DOM_URL);
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
    overlay.innerHTML = `
      <div class="iat-modal" role="dialog" aria-modal="true" aria-label="Allocation Tool">
        <div class="iat-modal-header">
          <div class="iat-modal-icon">A</div>
          <div class="iat-modal-title">Allocation Tool<span class="iat-modal-subtitle">running inside Intacct · session-authenticated</span></div>
          <button class="iat-close" type="button" aria-label="Close">×</button>
        </div>
        <div id="${ROOT_ID}"></div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    overlay.querySelector('.iat-close').addEventListener('click', closeOverlay);
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

  // ── Bootstrap: load deps, preload reference lists, render app ────────────
  async function bootstrapApp() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    // Loading state
    root.innerHTML = `
      <div class="iat-loading">
        <div class="iat-spinner"></div>
        <div class="iat-loading-msg" data-loading-msg>Loading dependencies…</div>
        <div class="iat-loading-detail" data-loading-detail></div>
      </div>
    `;
    const setMsg    = (m) => { const el = root.querySelector('[data-loading-msg]');    if (el) el.textContent = m; };
    const setDetail = (m) => { const el = root.querySelector('[data-loading-detail]'); if (el) el.textContent = m; };

    try {
      await ensureReact();
      setMsg('Loading Intacct reference data…');

      const C = window.IntacctSageClient;
      const lists = ['departments', 'locations', 'projects', 'classes', 'glAccounts', 'statAccounts', 'periods', 'journals'];
      let done = 0;
      const tick = (name) => () => {
        done += 1;
        setDetail(done + ' / ' + lists.length + ' · ' + name);
      };
      const [departments, locations, projects, classes, glAccounts, statAccounts, periods, journals] =
        await Promise.all([
          C.getDepartments().then(r => (tick('departments')(),  r)),
          C.getLocations().then(r =>   (tick('locations')(),    r)),
          C.getProjects().then(r =>    (tick('projects')(),     r)),
          C.getClasses().then(r =>     (tick('classes')(),      r)),
          C.getGlAccounts().then(r =>  (tick('GL accounts')(),  r)),
          C.getStatAccounts().then(r =>(tick('stat accounts')(),r)),
          C.getPeriods().then(r =>     (tick('periods')(),      r)),
          C.getJournals().then(r =>    (tick('journals')(),     r)),
        ]);

      const data = { departments, locations, projects, classes, glAccounts, statAccounts, periods, journals };
      window.__intacctAllocationData = data; // for debugging in console
      renderApp(root, data);
    } catch (err) {
      console.error('[IntacctAllocationTool] bootstrap failed:', err);
      root.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'iat-error';
      box.innerHTML =
        '<div class="iat-error-title">Failed to load reference data</div>' +
        '<div class="iat-error-detail">' + (err && err.message ? String(err.message).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) : 'Unknown error') + '</div>';
      root.appendChild(box);
    }
  }

  // ── App render (skeleton — full UI port is next step) ────────────────────
  // For now: a verification panel showing counts of each loaded list. Once
  // this works in your tenant, we know the architecture is sound and we can
  // start porting the full allocation-tool.html React UI on top of this.
  function renderApp(rootEl, data) {
    const cards = [
      ['Departments',     data.departments.length,  data.departments[0]?.name     || ''],
      ['Locations',       data.locations.length,    data.locations[0]?.name       || ''],
      ['Projects',        data.projects.length,     data.projects[0]?.name        || ''],
      ['Classes',         data.classes.length,      data.classes[0]?.name         || ''],
      ['GL Accounts',     data.glAccounts.length,   data.glAccounts[0]?.name      || ''],
      ['Stat Accounts',   data.statAccounts.length, data.statAccounts[0]?.name    || ''],
      ['Periods',         data.periods.length,      data.periods[0]?.name         || ''],
      ['Journals',        data.journals.length,     data.journals[0]?.name        || ''],
    ];

    const cardHtml = cards.map(([label, count, sample]) => `
      <div class="iat-verify-card">
        <div class="iat-verify-card-label">${label}</div>
        <div class="iat-verify-card-value">${count.toLocaleString()}</div>
        ${sample ? '<div class="iat-verify-card-detail">e.g. ' + escapeHtml(sample) + '</div>' : ''}
      </div>
    `).join('');

    rootEl.innerHTML = `
      <div class="iat-verify">
        <h2>Architecture verified</h2>
        <p class="iat-verify-lead">All eight reference lists loaded directly from Sage Intacct via the same-origin AJAX gateway. No proxy server, no embedded credentials. The full allocation tool UI ports on top of this.</p>
        <div class="iat-verify-grid">${cardHtml}</div>
        <div class="iat-verify-foot">
          <strong>What this confirms:</strong> the page-script merge fields are flowing,
          <code>window.IntacctSageClient.getDepartments()</code> &amp; friends work end-to-end,
          localStorage caching is active (refresh this overlay — it'll be instant the second time),
          and the launcher + overlay shell is sized correctly inside Intacct's frame.
          Sample data on <code>window.__intacctAllocationData</code>.
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  injectStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderLauncher);
  } else {
    renderLauncher();
  }
  console.log('[IntacctAllocationTool] launcher attached — click bottom-right button to open');
})();
