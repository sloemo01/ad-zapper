/*
 * Probe page: picks a target tab, drives the worker, renders live numbers.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let lastStats = null;
let ticking = null;

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : String(n));
const ms = (n) => (typeof n === 'number' ? `${n} ms` : 'n/a');
const secs = (n) => (n ? `${Math.round(n / 100) / 10}s` : '0s');

const pickDefaultTab = (tabs) => {
  const yt = tabs.find((t) => /youtube\.com/i.test(t.url));
  if (yt) return yt.id;
  const active = tabs.find((t) => t.active);
  return (active && active.id) || (tabs[0] && tabs[0].id) || null;
};

const renderTabs = async () => {
  const res = await send({ type: 'tabs' });
  const select = $('tab');
  const current = Number(select.value) || null;
  select.innerHTML = '';
  const tabs = (res && res.tabs) || [];
  for (const t of tabs) {
    const option = document.createElement('option');
    option.value = String(t.id);
    option.textContent = `${t.title ? t.title.slice(0, 70) : '(untitled)'}`;
    option.title = t.url;
    select.appendChild(option);
  }
  const wanted = tabs.some((t) => t.id === current) ? current : pickDefaultTab(tabs);
  if (wanted !== null) select.value = String(wanted);
};

const cells = (s) => {
  const rows = [
    ['paused', fmt(s.paused)],
    ['blocked', fmt(s.blocked)],
    ['rewritten', fmt(s.rewritten)],
    ['worker boots', fmt(s.boots)],
    ['handling p50', ms(s.latency.p50)],
    ['handling p95', ms(s.latency.p95)],
    ['handling max', ms(s.latency.max)],
    ['elapsed', secs(s.elapsedMs)]
  ];
  $('cells').innerHTML = rows
    .map(([label, value]) => `<div class="cell"><b>${value}</b><span>${label}</span></div>`)
    .join('');
};

const render = (s) => {
  lastStats = s;
  cells(s);
  const state = $('state');
  if (s.attached) {
    state.className = 'state on';
    state.textContent = `Attached to tab ${s.tabId}${s.mode.block ? ' + blocklist' : ''}${s.mode.rewrite ? ' + rewrite' : ''}. Reload the target tab, then scroll it.`;
  } else if (s.detachReason && s.detachReason !== 'target_closed') {
    state.className = 'state err';
    state.textContent = `Detached (${s.detachReason}). ${s.paused ? fmt(s.paused) + ' requests measured.' : ''}`;
  } else {
    state.className = 'state';
    state.textContent = s.paused ? `Not attached. Last run measured ${fmt(s.paused)} requests.` : 'Not attached.';
  }
  const types = Object.entries(s.byType || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  $('types').textContent = types.length
    ? 'resource types\n' + types.map(([k, v]) => `${String(v).padStart(7)}  ${k}`).join('\n')
    : 'resource types will land here';
  const loads = [
    s.baseline ? `baseline (before attach): ${s.baseline.ms} ms` : 'baseline: reload the target tab once before attaching',
    ...(s.loads || []).map((l, i) => `attached load ${(s.loads.length - i)}: ${l.ms} ms`)
  ];
  $('loads').textContent = 'load timing\n' + loads.join('\n');
  $('errors').textContent = s.errors && s.errors.length
    ? `errors (${s.errorCount})\n` + s.errors.join('\n')
    : 'no errors';
};

const tick = async () => {
  try {
    render(await send({ type: 'stats' }));
  } catch (err) {
    $('state').className = 'state err';
    $('state').textContent = 'worker unreachable: ' + String(err && err.message || err);
  }
};

$('refresh').addEventListener('click', renderTabs);
$('clear').addEventListener('click', async () => render(await send({ type: 'clear' })));
$('attach').addEventListener('click', async () => {
  const tabId = Number($('tab').value);
  if (!tabId) return;
  const res = await send({ type: 'attach', tabId, block: $('block').checked, rewrite: $('rewrite').checked });
  if (res && res.error) {
    $('state').className = 'state err';
    $('state').textContent = 'attach failed: ' + res.error;
    return;
  }
  render(await send({ type: 'stats' }));
});
$('detach').addEventListener('click', async () => {
  await send({ type: 'detach' });
  render(await send({ type: 'stats' }));
});
$('copy').addEventListener('click', async () => {
  if (!lastStats) return;
  await navigator.clipboard.writeText(JSON.stringify(lastStats, null, 2));
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy JSON'; }, 1200);
});

renderTabs();
tick();
ticking = setInterval(tick, 500);
window.addEventListener('unload', () => clearInterval(ticking));
