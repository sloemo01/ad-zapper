/*
 * Sites Ad Zapper does not touch.
 *
 * There is no advertising on code hosts, and every layer this extension has is
 * capable of changing a page it runs on. The honest shape for a host like that is
 * not "block less", it is "stand down": no rule matching, no hiding sheet, no
 * scriptlets, no popup veto, no page-world script, no detection, no deep block.
 *
 * Loaded by the worker and by the content scripts, so the list exists once.
 *
 * User pages are deliberately not here. Somebody's site on *.github.io is somebody's
 * site: it still gets filtered. The deep block refuses those hosts separately
 * (neverAttach in deepblock.js), which is about rewriting, not about filtering.
 */
(function () {
  const HOSTS = [
    'github.com',
    'githubusercontent.com',
    'githubassets.com',
    'gitlab.com',
    'stackoverflow.com',
    'npmjs.com',
    'localhost',
    '127.0.0.1'
  ];

  const isSkippedHost = (host) => {
    const clean = String(host || '').trim().toLowerCase().replace(/^www\./, '');
    if (!clean) return false;
    return HOSTS.some((base) => clean === base || clean.endsWith('.' + base));
  };

  const isSkippedUrl = (url) => {
    try {
      return isSkippedHost(new URL(String(url || '')).hostname);
    } catch (_) {
      return false;
    }
  };

  self.adZapperSkipHosts = HOSTS;
  self.adZapperIsSkippedHost = isSkippedHost;
  self.adZapperIsSkippedUrl = isSkippedUrl;
})();
