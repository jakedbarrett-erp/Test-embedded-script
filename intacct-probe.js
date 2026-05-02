// intacct-probe.js — read-only diagnostic to see what's accessible to a script
// running inside an Intacct page. Goal: figure out whether the Allocation Tool
// can be ported off its Node proxy by talking to Intacct directly from the
// browser. No data leaves the page — all output to console + a small card.
//
// What's tested:
//   1. window globals matching /sage|intacct|ia|session|company|user/i
//   2. Cookie names (NOT values)
//   3. DOM/meta scan for csrf or session hints
//   4a. XML endpoint sanity check (expected to 401 without sender creds)
//   4b. REST endpoint probe (/ia/api/v1/) with credentials: include
//   4c. Network sniffer — wraps fetch + XHR for 30s, logs URLs the page calls
//   5. Iframe context (window.parent / window.top relationship)
//   6. URL / location host
//
// Discreet output: card shows pass/fail/inconclusive only. Full detail in console.

(function () {
  const CARD_ID  = 'intacct-probe-card';
  const STYLE_ID = 'intacct-probe-style';
  const SNIFF_DURATION_MS = 30_000;
  const SAFE_KEY_REGEX = /sage|intacct|^ia[_A-Z]|session|company|userid|user_id|csrf|token/i;

  const findings = {
    globals:    { status: 'pending', summary: '' },
    cookies:    { status: 'pending', summary: '' },
    dom:        { status: 'pending', summary: '' },
    xmlProbe:   { status: 'pending', summary: '' },
    restProbe:  { status: 'pending', summary: '' },
    sniffer:    { status: 'pending', summary: '' },
    iframe:     { status: 'pending', summary: '' },
    location:   { status: 'pending', summary: '' },
  };

  const TESTS = [
    ['globals',   'Window globals'],
    ['cookies',   'Cookie names'],
    ['dom',       'DOM session hints'],
    ['xmlProbe',  'XML endpoint (sanity)'],
    ['restProbe', 'REST endpoint'],
    ['sniffer',   'Network sniffer (30s)'],
    ['iframe',    'Iframe context'],
    ['location',  'URL / host'],
  ];

  // ── Card ──────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${CARD_ID} {
        position: fixed; right: 20px; bottom: 20px; z-index: 999999;
        width: 340px;
        background: #fff; border: 1px solid #e4e4e7; border-radius: 8px;
        box-shadow: 0 8px 28px rgba(0,0,0,.12);
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
        color: #18181b; overflow: hidden;
      }
      #${CARD_ID} .ipc-header {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 16px; border-bottom: 1px solid #e4e4e7;
        background: #f9f9f9;
      }
      #${CARD_ID} .ipc-icon {
        width: 24px; height: 24px; border-radius: 6px;
        background: #C87055; color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 700; flex-shrink: 0;
      }
      #${CARD_ID} .ipc-title {
        font-size: 14px; font-weight: 600; letter-spacing: -0.2px; flex: 1;
      }
      #${CARD_ID} .ipc-close {
        width: 22px; height: 22px; border: none; background: transparent;
        color: #a1a1aa; cursor: pointer; border-radius: 4px;
        font-size: 16px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      #${CARD_ID} .ipc-close:hover { background: #f4f4f5; color: #18181b; }
      #${CARD_ID} .ipc-body { padding: 8px 0; }
      #${CARD_ID} .ipc-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 16px;
        font-size: 13px;
      }
      #${CARD_ID} .ipc-row + .ipc-row { border-top: 1px solid #f4f4f5; }
      #${CARD_ID} .ipc-name { flex: 1; color: #18181b; font-weight: 500; }
      #${CARD_ID} .ipc-status {
        font-size: 10px; font-weight: 700;
        padding: 2px 8px; border-radius: 100px;
        text-transform: uppercase; letter-spacing: .03em;
      }
      #${CARD_ID} .ipc-status.pending      { background: #f4f4f5; color: #71717a; }
      #${CARD_ID} .ipc-status.running      { background: #fef3c7; color: #92400e; }
      #${CARD_ID} .ipc-status.pass         { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
      #${CARD_ID} .ipc-status.fail         { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
      #${CARD_ID} .ipc-status.info         { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
      #${CARD_ID} .ipc-status.inconclusive { background: #f4f4f5; color: #52525b; border: 1px solid #e4e4e7; }
      #${CARD_ID} .ipc-footer {
        padding: 10px 16px; border-top: 1px solid #f4f4f5;
        font-size: 11px; color: #a1a1aa;
        display: flex; justify-content: space-between; align-items: center;
      }
      #${CARD_ID} .ipc-footer code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #f4f4f5; padding: 1px 6px; border-radius: 4px;
        color: #52525b; font-size: 10px;
      }
    `;
    document.head.appendChild(s);
  }

  function renderCard() {
    const existing = document.getElementById(CARD_ID);
    if (existing) existing.remove();
    injectStyles();

    const card = document.createElement('div');
    card.id = CARD_ID;
    card.innerHTML = `
      <div class="ipc-header">
        <div class="ipc-icon">P</div>
        <div class="ipc-title">Intacct Probe</div>
        <button class="ipc-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="ipc-body">
        ${TESTS.map(([k, label]) => `
          <div class="ipc-row" data-row="${k}">
            <span class="ipc-name">${label}</span>
            <span class="ipc-status pending">pending</span>
          </div>`).join('')}
      </div>
      <div class="ipc-footer">
        <span>Full output → <code>console</code></span>
        <span class="ipc-footer-time" data-elapsed>0s</span>
      </div>`;

    card.querySelector('.ipc-close').addEventListener('click', () => card.remove());
    document.body.appendChild(card);
    return card;
  }

  function setStatus(key, status, summary) {
    findings[key] = { status, summary };
    const row = document.querySelector(`#${CARD_ID} [data-row="${key}"] .ipc-status`);
    if (row) {
      row.className = `ipc-status ${status}`;
      row.textContent = status;
    }
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  function testGlobals() {
    setStatus('globals', 'running', '');
    const matches = [];
    try {
      for (const k of Object.keys(window)) {
        if (SAFE_KEY_REGEX.test(k)) {
          let kind = typeof window[k];
          if (kind === 'object' && window[k] !== null) {
            try {
              const sub = Object.keys(window[k]).slice(0, 8);
              kind = `object{${sub.join(',')}${Object.keys(window[k]).length > 8 ? ',...' : ''}}`;
            } catch (_) { /* cross-origin or restricted */ }
          }
          matches.push({ key: k, kind });
        }
      }
    } catch (e) {
      console.warn('[IntacctProbe] globals scan threw:', e.message);
    }
    console.groupCollapsed('[IntacctProbe] Test 1 — window globals (' + matches.length + ' match)');
    matches.forEach(m => console.log(' ', m.key, '→', m.kind));
    console.groupEnd();

    if (matches.length === 0) {
      setStatus('globals', 'inconclusive', 'no matches');
    } else {
      setStatus('globals', 'info', matches.length + ' found');
    }
  }

  function testCookies() {
    setStatus('cookies', 'running', '');
    const raw = document.cookie || '';
    const names = raw.split(';').map(s => s.trim().split('=')[0]).filter(Boolean);
    console.groupCollapsed('[IntacctProbe] Test 2 — cookie names (' + names.length + ')');
    names.forEach(n => console.log(' ', n));
    if (raw === '') console.log(' (none readable from JS — likely all httpOnly)');
    console.groupEnd();

    if (names.length === 0) {
      setStatus('cookies', 'info', 'all httpOnly');
    } else {
      setStatus('cookies', 'info', names.length + ' readable');
    }
  }

  function testDom() {
    setStatus('dom', 'running', '');
    const hits = [];
    try {
      document.querySelectorAll('meta[name]').forEach(m => {
        const name = m.getAttribute('name');
        if (name && SAFE_KEY_REGEX.test(name)) hits.push({ kind: 'meta', name });
      });
      document.querySelectorAll('input[type="hidden"][name]').forEach(i => {
        const name = i.getAttribute('name');
        if (name && SAFE_KEY_REGEX.test(name)) hits.push({ kind: 'hidden-input', name });
      });
    } catch (e) { /* ignore */ }
    console.groupCollapsed('[IntacctProbe] Test 3 — DOM session hints (' + hits.length + ')');
    hits.forEach(h => console.log(' ', h.kind, h.name));
    console.groupEnd();
    setStatus('dom', hits.length ? 'info' : 'inconclusive',
              hits.length ? hits.length + ' hits' : 'none');
  }

  async function testXmlProbe() {
    setStatus('xmlProbe', 'running', '');
    // Minimal envelope WITHOUT sender block — we expect this to be rejected,
    // confirming the XML API is closed to in-page scripts without server creds.
    const noSenderEnvelope =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<request><control>' +
        '<controlid>probe_no_sender</controlid>' +
        '<dtdversion>3.0</dtdversion>' +
      '</control>' +
      '<operation><content><function controlid="fn">' +
        '<getAPISession/>' +
      '</function></content></operation></request>';

    try {
      const r = await fetch('/ia/xml/xmlgw.phtml', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'text/xml' },
        body: noSenderEnvelope,
      });
      const text = await r.text();
      const head = text.slice(0, 200);
      console.groupCollapsed('[IntacctProbe] Test 4a — XML endpoint sanity');
      console.log(' status:', r.status, r.statusText);
      console.log(' content-type:', r.headers.get('content-type'));
      console.log(' first 200 chars:', head);
      console.groupEnd();
      // We're confirming the path is closed. 4xx = expected (good); 200 = surprising; network error = same-origin probably blocked.
      if (r.ok) {
        setStatus('xmlProbe', 'info', 'unexpected 200');
      } else {
        setStatus('xmlProbe', 'fail', 'closed (' + r.status + ')');
      }
    } catch (e) {
      console.groupCollapsed('[IntacctProbe] Test 4a — XML endpoint sanity');
      console.log(' fetch threw:', e.message);
      console.groupEnd();
      setStatus('xmlProbe', 'fail', 'network error');
    }
  }

  async function testRestProbe() {
    setStatus('restProbe', 'running', '');
    // Try a few REST shapes — list to see what we hit. We're not committing
    // to one path; we want to see what the host responds with.
    const candidates = [
      '/ia/api/v1/',
      '/ia/api/v1/objects',
      '/ia/api/v1/companies',
      '/api/v1/',
    ];
    const results = [];
    for (const path of candidates) {
      try {
        const r = await fetch(path, { credentials: 'include' });
        results.push({ path, status: r.status, ct: r.headers.get('content-type') });
      } catch (e) {
        results.push({ path, error: e.message });
      }
    }
    console.groupCollapsed('[IntacctProbe] Test 4b — REST endpoint probe');
    results.forEach(r => console.log(' ', r));
    console.groupEnd();

    const open = results.find(r => r.status && r.status >= 200 && r.status < 400);
    if (open) {
      setStatus('restProbe', 'pass', open.path + ' → ' + open.status);
    } else if (results.every(r => r.status === 404)) {
      setStatus('restProbe', 'fail', 'no REST surface');
    } else {
      setStatus('restProbe', 'inconclusive', 'mixed responses');
    }
  }

  function testSniffer() {
    setStatus('sniffer', 'running', '0/' + (SNIFF_DURATION_MS / 1000) + 's');
    const captured = [];
    const origFetch = window.fetch;
    const origOpen  = XMLHttpRequest.prototype.open;
    const origSend  = XMLHttpRequest.prototype.send;

    function record(method, url, status, kind) {
      // Strip query string — may contain session-y values
      let cleanUrl = url;
      try {
        const u = new URL(url, window.location.origin);
        cleanUrl = u.origin === window.location.origin
          ? u.pathname
          : (u.origin + u.pathname);
      } catch (_) { /* leave as-is */ }
      captured.push({ method, url: cleanUrl, status, kind });
    }

    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '(unknown)';
      const method = (init && init.method) || (input && input.method) || 'GET';
      return origFetch.apply(this, arguments).then(
        r => { record(method, url, r.status, 'fetch'); return r; },
        e => { record(method, url, 'error:' + e.message, 'fetch'); throw e; }
      );
    };

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__probe_method = method;
      this.__probe_url    = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('loadend', () => {
        record(this.__probe_method, this.__probe_url, this.status, 'xhr');
      });
      return origSend.apply(this, arguments);
    };

    const startedAt = Date.now();
    const tickEl = document.querySelector(`#${CARD_ID} [data-row="sniffer"] .ipc-status`);
    const tick = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (tickEl) tickEl.textContent = elapsed + '/' + (SNIFF_DURATION_MS / 1000) + 's';
    }, 1000);

    setTimeout(() => {
      clearInterval(tick);
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;

      // Group same-origin endpoints by path so we see what Intacct actually calls
      const sameOriginPaths = {};
      captured.forEach(c => {
        const isSame = !c.url.startsWith('http') || c.url.startsWith(window.location.origin);
        if (isSame) sameOriginPaths[c.url] = (sameOriginPaths[c.url] || 0) + 1;
      });

      console.groupCollapsed('[IntacctProbe] Test 4c — network sniffer (' + captured.length + ' requests)');
      console.log(' all requests:');
      captured.forEach(c => console.log(' ', c.method, c.kind, c.status, c.url));
      console.log(' same-origin path counts:');
      Object.entries(sameOriginPaths)
        .sort((a, b) => b[1] - a[1])
        .forEach(([p, n]) => console.log(' ', n + 'x', p));
      console.groupEnd();

      const distinctPaths = Object.keys(sameOriginPaths).length;
      if (captured.length === 0) {
        setStatus('sniffer', 'inconclusive', 'no traffic — interact with page');
      } else {
        setStatus('sniffer', 'pass', captured.length + ' reqs / ' + distinctPaths + ' paths');
      }
    }, SNIFF_DURATION_MS);
  }

  function testIframe() {
    setStatus('iframe', 'running', '');
    const inIframe = window.parent !== window;
    let topAccessible = 'unknown';
    if (inIframe) {
      try {
        const _ = window.top.location.href;
        topAccessible = 'yes';
      } catch (_) {
        topAccessible = 'cross-origin (blocked)';
      }
    }
    console.groupCollapsed('[IntacctProbe] Test 5 — iframe context');
    console.log(' inIframe:', inIframe);
    console.log(' window.top accessible:', topAccessible);
    console.groupEnd();
    setStatus('iframe', 'info',
      inIframe ? 'iframed (' + topAccessible + ')' : 'top-level');
  }

  function testLocation() {
    setStatus('location', 'running', '');
    const host = window.location.host;
    const path = window.location.pathname;
    console.groupCollapsed('[IntacctProbe] Test 6 — location');
    console.log(' host:', host);
    console.log(' pathname:', path);
    console.groupEnd();
    setStatus('location', 'info', host);
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async function runAll() {
    console.log('%c[IntacctProbe] starting at ' + new Date().toISOString(),
                'color:#C87055;font-weight:bold');
    renderCard();
    const startedAt = Date.now();
    const elapsedEl = document.querySelector(`#${CARD_ID} [data-elapsed]`);
    const elapsedTimer = setInterval(() => {
      if (elapsedEl) elapsedEl.textContent = Math.floor((Date.now() - startedAt) / 1000) + 's';
    }, 1000);

    testGlobals();
    testCookies();
    testDom();
    testIframe();
    testLocation();
    testSniffer(); // runs in background for 30s
    await testXmlProbe();
    await testRestProbe();

    setTimeout(() => {
      clearInterval(elapsedTimer);
      console.log('%c[IntacctProbe] complete — full findings:', 'color:#16a34a;font-weight:bold');
      console.table(Object.entries(findings).map(([k, v]) => ({ test: k, status: v.status, summary: v.summary })));
    }, SNIFF_DURATION_MS + 500);
  }

  // Expose for re-runs / loader chaining
  window.IntacctProbe = {
    findings: () => findings,
    run:      runAll,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAll);
  } else {
    runAll();
  }

  console.log('[IntacctProbe] module loaded');
})();
