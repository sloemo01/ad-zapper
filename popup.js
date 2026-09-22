/*
 * Popup: the tally, the popup-killer counter, the deep-block control, what this
 * site has done before, and the state of the engine that does the work.
 *
 * Counters come from chrome.storage.local (the worker is the only writer). The
 * rest asks the worker about the tab this popup is open on, because the popup
 * cannot read tab URLs without the tabs permission and the worker already knows
 * them from src/relay.js.
 */
'use strict';

const STORAGE_KEY = 'stats';
const RESET_MESSAGE = 'yt-ad-zapper:reset';
const TAB_INFO_MESSAGE = 'yt-ad-zapper:tab-info';
const PIN_MESSAGE = 'yt-ad-zapper:pin';
const SETTINGS_MESSAGE = 'yt-ad-zapper:settings';
const UPDATE_LISTS_MESSAGE = 'yt-ad-zapper:update-lists';
const POWER_MESSAGE = 'yt-ad-zapper:power';
const SELF_UPDATE_MESSAGE = 'yt-ad-zapper:self-update';

// The build the browser is actually running. An unpacked extension keeps running
// the code it was loaded with until someone reloads it, so "did the reload take"
// has to be answerable from the panel instead of by measuring the old bundle.
const stampVersion = () => {
  try {
    const el = document.getElementById('version');
    if (el) el.textContent = `build ${chrome.runtime.getManifest().version}`;
  } catch (_) {}
};
stampVersion();

// The probe, shown here because reading it from a page needs a debugger on the
// tab, and the extension needs that same single slot to do its work.
const showDiag = () => {
  try {
    chrome.runtime.sendMessage({ type: 'yt-ad-zapper:diag' }, (info) => {
      const el = document.getElementById('diag');
      if (!el) return;
      try {
        el.textContent = JSON.stringify(info || { error: 'no reply' }, null, 1).slice(0, 4000);
      } catch (_) {
        el.textContent = 'the probe could not be printed';
      }
    });
  } catch (_) {}
};
try {
  const box = document.querySelector('.diag-box');
  if (box) box.addEventListener('toggle', () => {
    if (box.open) showDiag();
  });
} catch (_) {}

// Mirrors the stored setting. The switch in the panel is the only thing that
// writes it, and the worker is the one that applies it.
let powered = true;

const emptyStats = () => ({
  ads: 0,
  videos: 0,
  since: Date.now(),
  lastAt: 0,
  popups: 0,
  lastPopupAt: 0,
  lastPopupHost: '',
  lastPopupKind: ''
});

let activeTabId = null;
let tabInfo = null;

const formatWhen = (timestamp) => {
  const when = new Date(timestamp);
  const date = when.toLocaleDateString();
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};

// Small enough to be worth repeating rather than loading a module into a popup.
const formatBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const sinceText = (at) => {
  const stamp = Number(at) || 0;
  if (!stamp) return '';
  const minutes = Math.round((Date.now() - stamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const renderCounters = async () => {
  const stored = await chrome.storage.local.get([STORAGE_KEY, 'settings']);
  const stats = Object.assign(emptyStats(), stored[STORAGE_KEY] || {});
  const settings = (stored && stored.settings) || {};
  powered = settings.enabled !== false;
  let learned = 0;
  try {
    const extra = await chrome.storage.local.get('escalated');
    learned = Array.isArray(extra && extra.escalated) ? extra.escalated.length : 0;
  } catch (_) {}

  document.getElementById('total').textContent = stats.ads.toLocaleString();

  const detail = document.getElementById('detail');
  if (stats.ads === 0) {
    detail.textContent = 'Nothing counted yet. Play a video that normally shows ads.';
  } else if (stats.lastAt) {
    const videos = stats.videos.toLocaleString();
    detail.textContent = `${videos} video${stats.videos === 1 ? '' : 's'} cleaned, last one ${formatWhen(stats.lastAt)}`;
  } else {
    detail.textContent = `${stats.videos.toLocaleString()} videos cleaned`;
  }

  const popups = document.getElementById('popups');
  if (popups) {
    if (!stats.popups) {
      popups.textContent = 'No popups killed yet.';
    } else {
      const count = stats.popups.toLocaleString();
      const host = stats.lastPopupHost ? `, last one ${stats.lastPopupHost}` : '';
      const net = learned ? `, ${learned} host${learned === 1 ? '' : 's'} blocked site-wide` : '';
      popups.textContent = `${count} popup ad${stats.popups === 1 ? '' : 's'} killed${host}${net}`;
    }
  }
};

const describeDeep = (info) => {
  if (!info) return 'Deep block is idle';
  if (info.mode === 'off') return 'Deep block is <b>off</b>';
  if (info.attached) {
    const count = info.blockedHere ? `, ${info.blockedHere.toLocaleString()} blocked here` : '';
    return `Deep block is <b>on</b> for this tab${count}`;
  }
  if (info.verdict && info.verdict.attach === false) {
    if (info.verdict.why === 'never attach') return 'Deep block never attaches here, a site you work in';
    if (info.verdict.why === 'page-world') return 'Deep block is skipped here, page-world';
    return `Deep block is skipped here, ${info.verdict.why}`;
  }
  if (info.pinned) return 'Deep block is <b>armed</b> for this site';
  if (!info.engineReady) return 'Deep block is warming up';
  if (info.site && info.site.hot) return 'Deep block will <b>kick in</b> here: this site has pulled ads before';
  return 'Deep block is on standby';
};

// What the extension remembers about the site in this tab. Honest about what it
// does not know: ads are counted globally (video ad breaks), popups per site.
const describeSite = (info) => {
  if (!info || !info.host) return '';
  const site = info.site || {};
  const visits = Number(site.visits) || 0;
  if (!visits) return 'First visit to this site.';
  const bits = [`${visits} visit${visits === 1 ? '' : 's'}`];
  if (site.popups) bits.push(`${site.popups} popup${site.popups === 1 ? '' : 's'} killed here`);
  if (site.hot) bits.push('attaches on sight');
  return `Seen before: ${bits.join(', ')}.`;
};

// Engine, memory and list state in one line. Every number here is read from the
// worker, not estimated.
const describeSystem = (info) => {
  if (!info) return '';
  const bits = [];
  const memory = info.memory;
  if (memory) {
    if (memory.heap) bits.push(`heap ${formatBytes(memory.heap)}`);
    bits.push(memory.engineLoaded ? 'engine loaded' : 'engine parked');
    if (memory.heavy) bits.push(`${memory.heavy} site${memory.heavy === 1 ? '' : 's'} cooling off`);
  }
  const lists = info.lists;
  if (lists) {
    if (lists.busy) bits.push('updating lists');
    else if (lists.at) bits.push(`lists ${sinceText(lists.at)}`);
    else bits.push('lists as shipped');
    if (lists.counts && lists.counts.network) bits.push(`${lists.counts.network.toLocaleString()} filters`);
  }
  const upd = info.update;
  if (upd) {
    if (upd.stuck) bits.push(`update ${upd.stuck} would not load`);
    else if (upd.staged) bits.push(`update ${upd.staged} installed`);
    else if (upd.newer) bits.push(`${upd.latest} available`);
    else if (upd.checkedAt) bits.push('up to date');
  }
  const learned = info.learned;
  if (learned && learned.hosts) {
    const found = learned.promoted || 0;
    const hidden = learned.published || 0;
    if (found || hidden) {
      bits.push(`${found} ad host${found === 1 ? '' : 's'} found, ${hidden} selector${hidden === 1 ? '' : 's'} hidden`);
    }
  }
  if (info.hidingTotal) bits.push(`hiding ${info.hidingTotal.hosts} host${info.hidingTotal.hosts === 1 ? '' : 's'}`);
  return bits.join(' · ');
};

const renderSite = () => {
  const node = document.getElementById('site');
  if (!node) return;
  const text = describeSite(tabInfo);
  node.textContent = text;
  node.style.display = text ? '' : 'none';
};

const renderPower = () => {
  const button = document.getElementById('power');
  if (button) button.setAttribute('aria-checked', powered ? 'true' : 'false');
  const body = document.body;
  if (body && body.classList) body.classList.toggle('off', !powered);
  const detail = document.getElementById('detail');
  // renderCounters runs first and writes what the blocker has done. While the
  // switch is off that text would be a lie, so it is replaced here.
  if (detail && !powered) {
    detail.textContent = 'Blocking is off: no network rules, no deep block, no popup killing. Flip the switch to start again.';
  }
};

const describeUpdate = (info) => {
  const upd = info && info.update;
  if (!upd) return 'Update state unknown.';
  if (upd.stuck) {
    return `The new version ${upd.stuck} is in the folder, but Chrome is still running ${upd.running}. Reload the extension from chrome://extensions.`;
  }
  if (upd.staged) return `${upd.staged} is installed; the extension reloads into it by itself.`;
  if (upd.newer) return `${upd.latest} is available, you are on ${upd.running}.`;
  if (upd.checkedAt) return `Up to date (${upd.running}), checked ${sinceText(upd.checkedAt)}.`;
  return `You are on ${upd.running}.`;
};

const renderUpdate = () => {
  const label = document.getElementById('updater');
  const button = document.getElementById('updateSelf');
  if (!label || !button) return;
  const upd = (tabInfo && tabInfo.update) || null;
  label.textContent = describeUpdate(tabInfo);
  const ready = upd && (upd.newer || upd.staged);
  button.textContent = ready ? (upd.latest ? `Update to ${upd.latest}` : 'Update') : 'Check for updates';
};

const renderSystem = () => {
  renderUpdate();
  const node = document.getElementById('system');
  if (!node) return;
  const text = describeSystem(tabInfo);
  node.textContent = text;
  node.style.display = text ? '' : 'none';
};

const renderDeep = async () => {
  const section = document.getElementById('deep');
  if (!section) return;
  const dot = document.getElementById('deepDot');
  const label = document.getElementById('deepLabel');
  const pin = document.getElementById('pin');
  const info = tabInfo;
  const skipped = !!(info && info.verdict && info.verdict.attach === false);
  if (dot) dot.className = info && (info.attached || (info.pinned && !skipped)) ? 'dot on' : 'dot';
  if (label) label.innerHTML = describeDeep(info);
  if (pin) {
    pin.textContent = info && info.pinned ? 'Stop deep blocking this site' : 'Deep block this site';
    pin.disabled = !info || !info.host;
  }
  const modes = document.getElementById('modes');
  if (modes) {
    const wanted = (info && info.mode) || 'smart';
    Array.prototype.forEach.call(modes.querySelectorAll('[data-mode]'), (button) => {
      const mode = button.getAttribute('data-mode');
      button.className = mode === wanted ? 'seg active' : 'seg';
    });
  }
  renderSite();
  renderSystem();
};

const loadTabInfo = async () => {
  const section = document.getElementById('deep');
  if (!section) return;
  try {
    if (!chrome.tabs || !chrome.tabs.query) return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab) return;
    activeTabId = tab.id;
    tabInfo = await chrome.runtime.sendMessage({ type: TAB_INFO_MESSAGE, tabId: tab.id });
    await renderDeep();
  } catch (_) {}
};

const render = async () => {
  await renderCounters();
  renderPower();
  await renderDeep();
};

const updateSelfButton = document.getElementById('updateSelf');
if (updateSelfButton) {
  updateSelfButton.addEventListener('click', async () => {
    const upd = (tabInfo && tabInfo.update) || null;
    const label = document.getElementById('updater');
    if (upd && (upd.newer || upd.staged)) {
      // One click, when the machine has the updater registered: the worker asks the
      // native host to run the installer, the folder is swapped, and the extension
      // reloads into it. Without the host, fall back to the command.
      if (label) label.textContent = 'Updating… a few seconds.';
      let done = null;
      try {
        done = await chrome.runtime.sendMessage({ type: SELF_UPDATE_MESSAGE, action: 'install' });
      } catch (_) {
        done = null;
      }
      if (done && done.installed) {
        if (label) label.textContent = `Updated to ${done.version || 'the newest version'}. Reloading…`;
        if (button) button.textContent = 'Updated';
        return;
      }
      const why = (done && done.why) || '';
      if (upd.command) {
        try {
          await navigator.clipboard.writeText(upd.command);
          if (label) {
            label.textContent = `${why ? why + '. ' : ''}Command copied instead: paste it in Terminal, then open this panel again.`;
          }
        } catch (_) {
          if (label) label.textContent = `Copy this and run it: ${upd.command}`;
        }
      }
      return;
    }
    if (label) label.textContent = 'Asking GitHub…';
    try {
      const reply = await chrome.runtime.sendMessage({ type: SELF_UPDATE_MESSAGE, action: 'check' });
      if (reply && reply.update) tabInfo = { ...(tabInfo || {}), update: reply.update };
      renderUpdate();
    } catch (_) {
      if (label) label.textContent = 'The check did not get an answer.';
    }
  });
}

const powerButton = document.getElementById('power');
if (powerButton) {
  powerButton.addEventListener('click', async () => {
    const wanted = !powered;
    powerButton.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: POWER_MESSAGE, enabled: wanted });
      powered = reply && typeof reply.enabled === 'boolean' ? reply.enabled : wanted;
    } catch (_) {
      powered = wanted;
    }
    powerButton.disabled = false;
    await render();
  });
}

const pinButton = document.getElementById('pin');
if (pinButton) {
  pinButton.addEventListener('click', async () => {
    if (!tabInfo || !tabInfo.host) return;
    const want = !tabInfo.pinned;
    pinButton.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: PIN_MESSAGE,
        host: tabInfo.host,
        pin: want,
        tabId: activeTabId
      });
      tabInfo = await chrome.runtime.sendMessage({ type: TAB_INFO_MESSAGE, tabId: activeTabId });
    } catch (_) {}
    await renderDeep();
  });
}

const updateButton = document.getElementById('update');
if (updateButton) {
  updateButton.addEventListener('click', async () => {
    const original = updateButton.textContent;
    updateButton.disabled = true;
    updateButton.textContent = 'Updating in the background';
    try {
      await chrome.runtime.sendMessage({ type: UPDATE_LISTS_MESSAGE });
    } catch (_) {}
    // The download and the compile happen in the worker, well past the lifetime
    // of this panel. Reopening it is where the result shows up.
    setTimeout(() => {
      updateButton.disabled = false;
      updateButton.textContent = original;
    }, 4000);
  });
}

document.getElementById('reset').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: RESET_MESSAGE });
  } catch (_) {}
  await render();
});

const modeRow = document.getElementById('modes');
if (modeRow) {
  modeRow.addEventListener('click', async (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest('[data-mode]') : null;
    if (!button) return;
    const wanted = button.getAttribute('data-mode');
    try {
      await chrome.runtime.sendMessage({ type: SETTINGS_MESSAGE, deepBlock: wanted });
      if (tabInfo) tabInfo.mode = wanted;
    } catch (_) {}
    await renderDeep();
  });
}

render();
loadTabInfo();
