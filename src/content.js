/*
 * Ad Zapper: isolated-world watchdog.
 *
 * The cosmetic CSS hides ad containers on its own. This script handles
 * behaviour: it deletes the anti-adblock wall if YouTube shows it, clicks
 * skip buttons, and fast-forwards any ad frame that still slips through.
 *
 * It also relays blocked-ad counts from the page-world interceptor to the
 * service worker, which keeps the tally and paints the toolbar badge.
 */
(() => {
  'use strict';

  // The master switch. This script reads it from storage because it sits in the
  // isolated world: with blocking off there is nothing to skip and nothing to
  // un-wall, and a page that still shows those steps is a page that would tell
  // a detector a blocker is installed.
  let live = true;
  const readPower = async () => {
    try {
      const stored = await chrome.storage.local.get('settings');
      const settings = (stored && stored.settings) || {};
      live = settings.enabled !== false;
    } catch (_) {}
  };
  readPower();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes && changes.settings) readPower();
    });
  } catch (_) {}

  const DEBUG = true;
  const TAG = '[yt-ad-zapper]';
  const CHANNEL = 'yt-ad-zapper';
  const TO_WORKER = 'yt-ad-zapper:ads-blocked';
  const TICK_MS = 250;
  const AD_RATE = 16;
  const SKIP_BUTTONS = ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern'];
  const WALL = 'ytd-enforcement-message-view-model';

  const log = (...args) => {
    if (DEBUG) console.log(TAG, ...args);
  };

  let savedRate = null;
  let lastNote = '';

  const note = (message) => {
    if (!DEBUG || message === lastNote) return;
    lastNote = message;
    log(message);
  };

  // The "ad blockers violate YouTube's Terms of Service" wall.
  const removeWall = () => {
    const marker = document.querySelector(WALL);
    if (!marker) return;
    const dialog = marker.closest('tp-yt-paper-dialog') || marker;
    dialog.remove();
    const video = document.querySelector('video');
    if (video && video.paused && !document.hidden) video.play().catch(() => {});
    note('removed the anti-adblock wall');
  };

  const tick = () => {
    // With the switch off there is nothing to skip, nothing to un-wall, and no
    // reason for this script to be visible on the page at all.
    if (!live) return;
    removeWall();

    const player = document.querySelector('.html5-video-player');
    const video = document.querySelector('video');
    if (!player || !video) return;

    if (!player.classList.contains('ad-showing')) {
      if (savedRate !== null) {
        try {
          video.playbackRate = savedRate;
        } catch (_) {}
        savedRate = null;
      }
      return;
    }

    note('ad frame detected, fast-forwarding');
    for (const selector of SKIP_BUTTONS) {
      const button = player.querySelector(selector);
      if (button) {
        button.click();
        break;
      }
    }
    if (savedRate === null) savedRate = video.playbackRate;
    if (video.playbackRate !== AD_RATE) {
      try {
        video.playbackRate = AD_RATE;
      } catch (_) {}
    }
    if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
      try {
        video.currentTime = video.duration;
      } catch (_) {}
    }
  };

  // Counter bridge: the page world cannot touch chrome.* APIs, so blocked-ad
  // reports arrive over window.postMessage and get forwarded from here.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.type !== 'ads-blocked') return;
    const count = Number(data.count) || 0;
    if (count <= 0) return;
    try {
      const sent = chrome.runtime.sendMessage({ type: TO_WORKER, count });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch (_) {}
  });

  setInterval(tick, TICK_MS);
  log('watchdog active');
})();
