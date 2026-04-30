// ping.js — minimal test payload for verifying external script loading into Intacct
// Hosted via GitHub Pages and loaded from an Intacct page script.

(function () {
  const loadedAt = new Date().toISOString();

  window.IntacctPing = {
    loadedAt: loadedAt,
    ping: function () {
      console.log('[IntacctPing] ping() called. Script was loaded at', loadedAt);
      return 'pong';
    }
  };

  console.log('[IntacctPing] external script loaded successfully at', loadedAt);
})();
