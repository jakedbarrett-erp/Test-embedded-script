// intacct-sage-client.js — browser-side replacement for the Sage Intacct
// Allocation Tool's Node proxy server. Calls Sage's XML API directly via the
// same-origin AJAX gateway at /ia/xml/ajaxgw.phtml when running inside an
// Intacct customization page.
//
// Recipe (verified 2026-05-02):
//   POST /ia/xml/ajaxgw.phtml?.sess=<session>
//   Content-Type: application/x-www-form-urlencoded
//   Body:    xmlrequest=<URL-encoded XML envelope>
//   Cookies: credentials: 'include' carries the qxSI session cookie
//   No CSRF header required (matches API_Session.sendRequest).
//
// Public API (mirrors server/routes/*.js shapes so React code can be ported
// with minimal changes — every helper returns the same shape its `/api/*`
// counterpart did):
//
//   await IntacctSageClient.getDepartments()  // [{id,name}]
//   await IntacctSageClient.getLocations()    // [{id,name}]
//   await IntacctSageClient.getProjects()     // [{id,name}]
//   await IntacctSageClient.getClasses()      // [{id,name}]
//   await IntacctSageClient.getGlAccounts()   // [{id,name}] — incomestatement
//   await IntacctSageClient.getStatAccounts() // [{id,name}]
//   await IntacctSageClient.getApAccounts()   // [{id,num,name}] — sorted
//   await IntacctSageClient.getPeriods()      // [{name,startDate,endDate}]
//   await IntacctSageClient.getJournals()     // [{id,name}]
//   await IntacctSageClient.getBalances({...}) // enriched balance rows
//   await IntacctSageClient.postJournal({...}) // {success,key}
//
//   IntacctSageClient.callSage(functionXml)   // low-level — any function
//   IntacctSageClient.cache.clear()           // wipe all cached lists
//   IntacctSageClient.cache.refreshAll()      // re-fetch every list now
//   IntacctSageClient.getSessionId()          // current session, for diagnostics

(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────────
  const STORAGE_PREFIX = 'intacct-sage-cache.';
  const GATEWAY_PATH   = '/ia/xml/ajaxgw.phtml';

  // ── Session retrieval ─────────────────────────────────────────────────────
  // Multiple fallbacks: window.getSession (Intacct's own helper), then
  // window.IntacctContext from page-script merge fields, then URL .sess= param.
  function getSessionId() {
    if (typeof window.getSession === 'function') {
      const s = window.getSession();
      if (s) return s;
    }
    if (window.IntacctContext && window.IntacctContext.sessionId) {
      return window.IntacctContext.sessionId;
    }
    const m = window.location.search.match(/[?&]\.sess=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    return null;
  }

  // ── XML helpers ───────────────────────────────────────────────────────────
  function escapeXml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Convert a Sage XML response element tree into a plain JS object that
  // matches the shape fast-xml-parser produced server-side. Multiple
  // same-name children become arrays. Attributes get @_ prefix. Text-only
  // elements collapse to their string value.
  function xmlNodeToJs(node) {
    const elementChildren = [];
    let textContent = '';
    for (const c of node.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE) elementChildren.push(c);
      else if (c.nodeType === Node.TEXT_NODE || c.nodeType === Node.CDATA_SECTION_NODE) {
        textContent += c.nodeValue;
      }
    }
    const hasAttrs = node.attributes && node.attributes.length > 0;
    if (elementChildren.length === 0 && !hasAttrs) {
      const t = textContent.trim();
      return t === '' ? '' : t;
    }
    const obj = {};
    if (hasAttrs) {
      for (const a of node.attributes) obj['@_' + a.name] = a.value;
    }
    if (elementChildren.length === 0) {
      const t = textContent.trim();
      if (t !== '') obj['#text'] = t;
      return obj;
    }
    for (const c of elementChildren) {
      const v = xmlNodeToJs(c);
      const name = c.nodeName;
      if (obj[name] === undefined) {
        obj[name] = v;
      } else if (Array.isArray(obj[name])) {
        obj[name].push(v);
      } else {
        obj[name] = [obj[name], v];
      }
    }
    return obj;
  }

  function parseSageXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Sage response was not valid XML: ' + text.slice(0, 200));
    }
    return xmlNodeToJs(doc.documentElement);
  }

  // Build the envelope identically to API_Session.getRecHeader/getRecFooter:
  // senderid="null", password="null" literal strings, sessionid auth,
  // dtdversion 3.0, controlid set per-call so we can correlate.
  function buildEnvelope(functionXml, controlid) {
    return '<?xml version="1.0" encoding="UTF-8"?>' +
      '<request>' +
        '<control>' +
          '<senderid>null</senderid>' +
          '<password>null</password>' +
          '<controlid>' + escapeXml(controlid) + '</controlid>' +
          '<uniqueid>false</uniqueid>' +
          '<dtdversion>3.0</dtdversion>' +
        '</control>' +
        '<operation>' +
          '<authentication><sessionid>' + escapeXml(getSessionId() || '') + '</sessionid></authentication>' +
          '<content>' +
            '<function controlid="' + escapeXml(controlid) + '">' +
              functionXml +
            '</function>' +
          '</content>' +
        '</operation>' +
      '</request>';
  }

  // ── Low-level call ────────────────────────────────────────────────────────
  // Posts an envelope, parses the response, validates the auth + result
  // statuses, and returns the function's data block (matches server's
  // sageClient.js return convention).
  async function callSage(functionXml) {
    const sessionId = getSessionId();
    if (!sessionId) {
      throw new Error('No Intacct session ID available — is this script running inside an authenticated Intacct page?');
    }
    const controlid = 'isc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const envelope  = buildEnvelope(functionXml, controlid);
    const url       = GATEWAY_PATH + '?.sess=' + encodeURIComponent(sessionId);

    const r = await fetch(url, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:        'xmlrequest=' + encodeURIComponent(envelope),
    });
    if (!r.ok) throw new Error('Gateway returned HTTP ' + r.status);

    const text = await r.text();
    const parsed = parseSageXml(text);
    const operation = parsed && parsed.operation;

    const authStatus = operation && operation.authentication && operation.authentication.status;
    if (authStatus !== 'success') {
      throw new Error('Sage authentication failed: ' + authStatus);
    }

    const result = operation && operation.result;
    const fnStatus = result && result.status;
    if (fnStatus !== 'success') {
      // Build a rich error matching the server's sageClient.js shape so
      // existing UI error handling code reads it the same way.
      const errObj = (result && result.errormessage && result.errormessage.error) || {};
      const errArr = Array.isArray(errObj) ? errObj : [errObj];
      const first  = errArr[0] || {};
      const errMsg  = first.description2 || first.description || 'Unknown Sage API error';
      const errNo   = first.errorno   || '';
      const errCorr = first.correction || '';
      const full = [errMsg, errCorr ? 'Correction: ' + errCorr : '', errNo ? '[' + errNo + ']' : '']
        .filter(Boolean).join('  ');
      const err = new Error('Sage API error: "' + full + '"');
      err.sageDetail = {
        errorno:      errNo,
        description:  first.description,
        description2: first.description2,
        correction:   errCorr,
        raw:          first,
      };
      throw err;
    }
    return result && result.data;
  }

  // ── List query builder (mirrors server/routes/lists.js activeQuery) ──────
  function activeQuery(object, fields, extraFilter) {
    const fieldXml = fields.map(f => '<field>' + f + '</field>').join('');
    const statusFilter = '<equalto><field>STATUS</field><value>active</value></equalto>';
    const filterXml = extraFilter
      ? '<and>' + statusFilter + extraFilter + '</and>'
      : statusFilter;
    return '<query>' +
      '<object>' + object + '</object>' +
      '<select>' + fieldXml + '</select>' +
      '<filter>' + filterXml + '</filter>' +
      '<pagesize>1000</pagesize>' +
    '</query>';
  }

  // ── localStorage cache (mirrors server/lib/cache.js pattern) ─────────────
  // Process-scoped Map for in-flight calls (dedupe concurrent cold reads),
  // backed by localStorage so list data survives page reloads. Cleared
  // explicitly via cache.clear() / cache.refreshAll().
  const inflight = new Map();

  function cacheGet(key) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) { return null; }
  }
  function cacheSet(key, value) {
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); }
    catch (e) { /* quota or private mode; cache becomes a no-op */ }
  }
  function cacheClear() {
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
    inflight.clear();
  }

  async function cachedCall(key, loader) {
    const hit = cacheGet(key);
    if (hit != null) return hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        cacheSet(key, value);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  // ── List loaders (mirror server/routes/lists.js loaders object) ──────────
  const LIST_LOADERS = {
    departments: async () => {
      const data = await callSage(activeQuery('DEPARTMENT', ['DEPARTMENTID', 'TITLE']));
      return [].concat(data && data.DEPARTMENT || []).map(r => ({ id: r.DEPARTMENTID, name: r.TITLE }));
    },
    locations: async () => {
      const data = await callSage(activeQuery('LOCATION', ['LOCATIONID', 'NAME']));
      return [].concat(data && data.LOCATION || []).map(r => ({ id: r.LOCATIONID, name: r.NAME }));
    },
    projects: async () => {
      const data = await callSage(activeQuery('PROJECT', ['PROJECTID', 'NAME']));
      return [].concat(data && data.PROJECT || []).map(r => ({ id: r.PROJECTID, name: r.NAME }));
    },
    classes: async () => {
      const data = await callSage(activeQuery('CLASS', ['CLASSID', 'NAME']));
      return [].concat(data && data.CLASS || []).map(r => ({ id: r.CLASSID, name: r.NAME }));
    },
    glaccount: async () => {
      const data = await callSage(activeQuery('GLACCOUNT', ['ACCOUNTNO', 'TITLE'],
        '<equalto><field>ACCOUNTTYPE</field><value>incomestatement</value></equalto>'));
      return [].concat(data && data.GLACCOUNT || []).map(r => ({ id: String(r.ACCOUNTNO), name: r.TITLE }));
    },
    stataccount: async () => {
      const data = await callSage(activeQuery('STATACCOUNT', ['ACCOUNTNO', 'TITLE']));
      return [].concat(data && data.STATACCOUNT || []).map(r => ({ id: String(r.ACCOUNTNO), name: r.TITLE }));
    },
    apaccounts: async () => {
      const data = await callSage(activeQuery('GLACCOUNT', ['ACCOUNTNO', 'TITLE', 'CATEGORY'],
        '<equalto><field>CATEGORY</field><value>Accounts Payable</value></equalto>'));
      return [].concat(data && data.GLACCOUNT || [])
        .map(r => ({ id: String(r.ACCOUNTNO), num: String(r.ACCOUNTNO), name: r.TITLE }))
        .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
    },
    periods: async () => {
      const data = await callSage(
        '<query>' +
          '<object>REPORTINGPERIOD</object>' +
          '<select><field>NAME</field><field>START_DATE</field><field>END_DATE</field></select>' +
          '<filter><equalto><field>BUDGETING</field><value>true</value></equalto></filter>' +
          '<pagesize>1000</pagesize>' +
        '</query>');
      const toISO = (d) => {
        if (!d) return d;
        if (String(d).indexOf('-') !== -1) return d;
        const parts = String(d).split('/');
        return parts[2] + '-' + String(parts[0]).padStart(2, '0') + '-' + String(parts[1]).padStart(2, '0');
      };
      return [].concat(data && data.REPORTINGPERIOD || [])
        .map(r => ({ name: r.NAME, startDate: toISO(r.START_DATE), endDate: toISO(r.END_DATE) }))
        .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    },
    journals: async () => {
      const data = await callSage(
        '<query>' +
          '<object>JOURNAL</object>' +
          '<select><field>SYMBOL</field><field>TITLE</field></select>' +
          '<pagesize>1000</pagesize>' +
        '</query>');
      return [].concat(data && data.JOURNAL || [])
        .map(r => ({ id: r.SYMBOL, name: r.TITLE }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  };

  function makeListGetter(key) {
    return () => cachedCall(key, LIST_LOADERS[key]);
  }

  async function refreshAll() {
    cacheClear();
    await Promise.all(Object.keys(LIST_LOADERS).map(k => cachedCall(k, LIST_LOADERS[k])));
  }

  // ── Balances (mirrors server/routes/balances.js) ─────────────────────────
  // Builds get_accountbalancesbydimensions XML for one account selection.
  function buildBalanceXml(p) {
    const sd = p.startDate.split('-'), ed = p.endDate.split('-');
    const accountXml = p.accountMode === 'single'
      ? '<glaccountno>' + escapeXml(p.accountNo) + '</glaccountno>'
      : '<startaccountno>' + escapeXml(p.startAccountNo) + '</startaccountno>' +
        '<endaccountno>'   + escapeXml(p.endAccountNo)   + '</endaccountno>';
    const filters = [
      p.departmentid ? '<departmentid>' + escapeXml(p.departmentid) + '</departmentid>' : '',
      p.locationid   ? '<locationid>'   + escapeXml(p.locationid)   + '</locationid>'   : '',
      p.projectid    ? '<projectid>'    + escapeXml(p.projectid)    + '</projectid>'    : '',
      p.classid      ? '<classid>'      + escapeXml(p.classid)      + '</classid>'      : '',
    ].join('');
    const groupbyXml = p.groupby ? '<groupby>' + escapeXml(p.groupby) + '</groupby>' : '';
    return '<get_accountbalancesbydimensions>' +
      '<startdate><year>' + sd[0] + '</year><month>' + sd[1] + '</month><day>' + sd[2] + '</day></startdate>' +
      '<enddate><year>'   + ed[0] + '</year><month>' + ed[1] + '</month><day>' + ed[2] + '</day></enddate>' +
      accountXml + filters + groupbyXml +
    '</get_accountbalancesbydimensions>';
  }

  // params: { startDate, endDate, accountMode: 'single'|'range'|'multi',
  //          accountNo|startAccountNo+endAccountNo|accounts,
  //          departmentid?, locationid?, projectid?, classid?, groupby? }
  async function getBalances(params) {
    const dimFilters = {
      departmentid: params.departmentid,
      locationid:   params.locationid,
      projectid:    params.projectid,
      classid:      params.classid,
    };
    const dates = { startDate: params.startDate, endDate: params.endDate };

    let rows = [];
    if (params.accountMode === 'multi') {
      const datasets = await Promise.all((params.accounts || []).map(acct =>
        callSage(buildBalanceXml(Object.assign({}, dates, dimFilters, {
          groupby: params.groupby,
          accountMode: 'single',
          accountNo: acct,
        })))
      ));
      rows = datasets.flatMap(data => [].concat(data && data.accountbalance || []));
    } else {
      const data = await callSage(buildBalanceXml(Object.assign({}, dates, dimFilters, {
        groupby:        params.groupby,
        accountMode:    params.accountMode,
        accountNo:      params.accountNo,
        startAccountNo: params.startAccountNo,
        endAccountNo:   params.endAccountNo,
      })));
      rows = [].concat(data && data.accountbalance || []);
    }

    // Normalize raw Sage response → consistent JS shape.
    const normalized = rows.map(r => ({
      glaccountno:    String(r.glaccountno),
      gltitle:        r.gltitle        || null,
      periodbalance:  parseFloat(r.periodbalance) || 0,
      endbalance:     parseFloat(r.endbalance)    || 0,
      currency:       r.currency      || 'USD',
      departmentid:   r.departmentid  || null,
      departmentname: r.departmentname|| null,
      locationid:     r.locationid    || null,
      locationname:   r.locationname  || null,
      projectid:      r.projectid     || null,
      projectname:    r.projectname   || null,
      classid:        r.classid       || null,
      classname:      r.classname     || null,
    }));

    // Enrich with dimension labels from the cached lists. The server did
    // this from in-memory cache; we read from the same cache layer here.
    // Cache may be empty (first call before lists fetched) — that's fine,
    // the enrichment fields just stay null.
    const glList   = cacheGet('glaccount')   || [];
    const locList  = cacheGet('locations')   || [];
    const deptList = cacheGet('departments') || [];
    const projList = cacheGet('projects')    || [];
    const clsList  = cacheGet('classes')     || [];
    const glMap   = Object.fromEntries(glList.map(g => [g.id, g.name]));
    const locMap  = Object.fromEntries(locList.map(l => [l.id, l.name]));
    const deptMap = Object.fromEntries(deptList.map(d => [d.id, d.name]));
    const projMap = Object.fromEntries(projList.map(p => [p.id, p.name]));
    const clsMap  = Object.fromEntries(clsList.map(c => [c.id, c.name]));

    return normalized.map(r => Object.assign({}, r, {
      gltitle:        r.gltitle        || glMap[r.glaccountno]                                  || null,
      locationid:     r.locationid     || params.locationid                                     || null,
      locationname:   r.locationname   || locMap[r.locationid] || (params.locationid ? locMap[params.locationid] : null) || null,
      departmentname: r.departmentname || deptMap[r.departmentid] || null,
      projectname:    r.projectname    || projMap[r.projectid]    || null,
      classname:      r.classname      || clsMap[r.classid]       || null,
    }));
  }

  // ── Journal posting (mirrors server/routes/journal.js) ───────────────────
  // params: { journal: 'GJ', batchDate: 'YYYY-MM-DD', batchTitle, lines: [...] }
  // Returns: { success, key, xmlSent }  on success
  // Throws on failure with .sageDetail attached
  async function postJournal(params) {
    const journal    = params.journal || 'GJ';
    const batchDate  = params.batchDate;
    const batchTitle = params.batchTitle;
    const lines      = params.lines;
    if (!batchDate) throw new Error('batchDate is required');
    if (!Array.isArray(lines) || lines.length === 0) throw new Error('lines array is required');

    const [y, m, d] = batchDate.split('-');
    const sageDate = m + '/' + d + '/' + y;

    const entriesXml = lines.map(line => {
      const dims = [
        line.dept ? '<DEPARTMENT>' + escapeXml(line.dept) + '</DEPARTMENT>' : '',
        line.loc  ? '<LOCATION>'   + escapeXml(line.loc)  + '</LOCATION>'   : '',
        line.proj ? '<PROJECTID>'  + escapeXml(line.proj) + '</PROJECTID>'  : '',
        line.cls  ? '<CLASSID>'    + escapeXml(line.cls)  + '</CLASSID>'    : '',
      ].join('');
      const billable = line.billable ? 'true' : 'false';
      return '<GLENTRY>' +
        '<ACCOUNTNO>' + escapeXml(line.gl) + '</ACCOUNTNO>' +
        dims +
        '<TR_TYPE>' + line.trType + '</TR_TYPE>' +
        '<AMOUNT>'  + Number(line.amount).toFixed(2) + '</AMOUNT>' +
        '<BILLABLE>' + billable + '</BILLABLE>' +
        '<DESCRIPTION>' + escapeXml(line.desc || '') + '</DESCRIPTION>' +
      '</GLENTRY>';
    }).join('');

    const xml = '<create>' +
      '<GLBATCH>' +
        '<JOURNAL>' + escapeXml(journal) + '</JOURNAL>' +
        '<BATCH_DATE>' + sageDate + '</BATCH_DATE>' +
        '<BATCH_TITLE>' + escapeXml(batchTitle || '') + '</BATCH_TITLE>' +
        '<ENTRIES>' + entriesXml + '</ENTRIES>' +
      '</GLBATCH>' +
    '</create>';

    let data;
    try {
      data = await callSage(xml);
    } catch (sageErr) {
      sageErr.xmlSent = xml;
      throw sageErr;
    }
    const key = (data && data.glbatch && data.glbatch.RECORDNO) || (data && data.key) || '(posted)';
    return { success: true, key: String(key), xmlSent: xml };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.IntacctSageClient = {
    // Low-level
    callSage:        callSage,
    getSessionId:    getSessionId,

    // List helpers (cached, mirror /api/* shapes)
    getDepartments:  makeListGetter('departments'),
    getLocations:    makeListGetter('locations'),
    getProjects:     makeListGetter('projects'),
    getClasses:      makeListGetter('classes'),
    getGlAccounts:   makeListGetter('glaccount'),
    getStatAccounts: makeListGetter('stataccount'),
    getApAccounts:   makeListGetter('apaccounts'),
    getPeriods:      makeListGetter('periods'),
    getJournals:     makeListGetter('journals'),

    // Data queries
    getBalances:     getBalances,

    // Writes
    postJournal:     postJournal,

    // Cache control
    cache: {
      clear:      cacheClear,
      refreshAll: refreshAll,
      get:        cacheGet, // exposed so balance enrichment in callers can peek
    },
  };

  console.log('[IntacctSageClient] loaded — session present:', !!getSessionId());
})();
