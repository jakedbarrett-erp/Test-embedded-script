// ui-test.js — Stage 1 UI rendering test for Intacct external script loading.
// Injects a styled card into the bottom-right corner of the Intacct page.
// All styles are scoped under #intacct-ui-test so we cannot affect Intacct's own UI.

(function () {
  const WIDGET_ID = 'intacct-ui-test';
  const STYLE_ID  = 'intacct-ui-test-style';
  const loadedAt  = new Date();

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${WIDGET_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 999999;
        width: 320px;
        background: #ffffff;
        border: 1px solid #e4e4e7;
        border-radius: 8px;
        box-shadow: 0 8px 28px rgba(0,0,0,.12);
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
        color: #18181b;
        overflow: hidden;
        animation: ${WIDGET_ID}-in .2s ease-out;
      }
      @keyframes ${WIDGET_ID}-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #${WIDGET_ID} .iut-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        border-bottom: 1px solid #e4e4e7;
        background: #f9f9f9;
      }
      #${WIDGET_ID} .iut-icon {
        width: 24px; height: 24px;
        background: #C87055;
        border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        flex-shrink: 0;
      }
      #${WIDGET_ID} .iut-title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.2px;
        flex: 1;
      }
      #${WIDGET_ID} .iut-close {
        width: 22px; height: 22px;
        border: none; background: transparent;
        color: #a1a1aa;
        cursor: pointer;
        border-radius: 4px;
        font-size: 16px;
        line-height: 1;
        display: flex; align-items: center; justify-content: center;
        transition: background .12s, color .12s;
      }
      #${WIDGET_ID} .iut-close:hover {
        background: #f4f4f5;
        color: #18181b;
      }
      #${WIDGET_ID} .iut-body {
        padding: 14px 16px 16px;
      }
      #${WIDGET_ID} .iut-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        border-radius: 100px;
        background: #f0fdf4;
        color: #16a34a;
        border: 1px solid #bbf7d0;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: .03em;
        margin-bottom: 10px;
      }
      #${WIDGET_ID} .iut-badge::before {
        content: '';
        width: 5px; height: 5px;
        border-radius: 50%;
        background: currentColor;
        animation: ${WIDGET_ID}-pulse 2s infinite;
      }
      @keyframes ${WIDGET_ID}-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.4; }
      }
      #${WIDGET_ID} .iut-msg {
        font-size: 13px;
        line-height: 1.55;
        color: #52525b;
        margin-bottom: 12px;
      }
      #${WIDGET_ID} .iut-meta {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-top: 10px;
        border-top: 1px solid #f4f4f5;
        font-size: 11px;
        color: #a1a1aa;
      }
      #${WIDGET_ID} .iut-meta-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      #${WIDGET_ID} .iut-meta-label {
        text-transform: uppercase;
        letter-spacing: .04em;
        font-weight: 500;
      }
      #${WIDGET_ID} .iut-meta-value {
        color: #52525b;
        font-weight: 500;
        text-align: right;
        word-break: break-all;
      }
    `;
    document.head.appendChild(style);
  }

  function render() {
    // Remove any existing instance so re-renders are clean
    const existing = document.getElementById(WIDGET_ID);
    if (existing) existing.remove();

    injectStyles();

    const widget = document.createElement('div');
    widget.id = WIDGET_ID;
    widget.innerHTML = `
      <div class="iut-header">
        <div class="iut-icon">UI</div>
        <div class="iut-title">External UI Test</div>
        <button class="iut-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="iut-body">
        <span class="iut-badge">Loaded</span>
        <div class="iut-msg">
          This card was rendered by an external script loaded from GitHub Pages
          and injected into the Intacct page.
        </div>
        <div class="iut-meta">
          <div class="iut-meta-row">
            <span class="iut-meta-label">Source</span>
            <span class="iut-meta-value">github.io</span>
          </div>
          <div class="iut-meta-row">
            <span class="iut-meta-label">Loaded at</span>
            <span class="iut-meta-value">${loadedAt.toLocaleTimeString()}</span>
          </div>
          <div class="iut-meta-row">
            <span class="iut-meta-label">Page</span>
            <span class="iut-meta-value">${document.title || location.pathname}</span>
          </div>
        </div>
      </div>
    `;

    widget.querySelector('.iut-close').addEventListener('click', remove);
    document.body.appendChild(widget);
    console.log('[IntacctUITest] rendered widget at', loadedAt.toISOString());
  }

  function remove() {
    const el = document.getElementById(WIDGET_ID);
    if (el) el.remove();
    console.log('[IntacctUITest] widget removed');
  }

  window.IntacctUITest = {
    loadedAt: loadedAt.toISOString(),
    render: render,
    remove: remove
  };

  // Auto-render on load. If you'd rather trigger manually, comment this out
  // and call window.IntacctUITest.render() from devtools or a button handler.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }

  console.log('[IntacctUITest] module loaded — call window.IntacctUITest.render() / .remove() any time');
})();
