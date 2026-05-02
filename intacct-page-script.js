// intacct-page-script.js — paste this INTO Intacct's customization editor.
// This is the script that gets the merge field substitution; the externally
// loaded scripts (intacct-probe.js, future allocation tool) read what this
// drops on window.IntacctContext.
//
// Why two scripts? Merge fields are only resolved here. GitHub-hosted scripts
// see literal `{!#CURR_SESSION!}` text, not the value. So this thin shim
// pulls the values out, sets them on window, then loads the external script.
//
// Confirmed merge tags so far:
//   {!#CURR_SESSION!}  → current Intacct API session ID
//   {!API_ENDPOINT!}   → Intacct API endpoint URL
//
// Other fields visible in the merge picker — fill in syntax as needed:
//   Intacct host
//   Intacct endpoint
//   Current user: Login / Name / Email / Record no.
//   Current record
//
// To use: replace LOADER_URL with whatever you want loaded (probe first,
// later the allocation tool's external script).

(function () {
  // ── Context from merge fields ────────────────────────────────────────────
  // Wrapped in String() so even an empty merge value lands as '' rather than
  // undefined — keeps the downstream context shape predictable.
  window.IntacctContext = {
    sessionId:       String('{!#CURR_SESSION!}' || ''),
    apiEndpoint:     String('{!API_ENDPOINT!}'  || ''),
    // Uncomment + supply syntax once confirmed:
    // intacctHost:     String('{!INTACCT_HOST!}'      || ''),
    // intacctEndpoint: String('{!INTACCT_ENDPOINT!}'  || ''),
    // user: {
    //   login:    String('{!CURR_USER_LOGIN!}'    || ''),
    //   name:     String('{!CURR_USER_NAME!}'     || ''),
    //   email:    String('{!CURR_USER_EMAIL!}'    || ''),
    //   recordNo: String('{!CURR_USER_RECORDNO!}' || ''),
    // },
  };

  // ── Loader (from project's standard pattern) ─────────────────────────────
  const loadedScripts = window.__loadedIntacctScripts || (window.__loadedIntacctScripts = new Set());

  function loadScript(url) {
    if (loadedScripts.has(url)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload  = () => { loadedScripts.add(url); resolve(); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── Trigger ──────────────────────────────────────────────────────────────
  // For the probe: load on page load. For the real app, switch this to a
  // button/tab/field-change trigger so it doesn't run until needed.
  const LOADER_URL = 'https://YOUR-GITHUB-USER.github.io/YOUR-REPO/intacct-probe.js';

  loadScript(LOADER_URL)
    .then(()  => console.log('[IntacctPageScript] external script loaded'))
    .catch(e  => console.error('[IntacctPageScript] load failed:', e));
})();
