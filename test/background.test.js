/*
 * Test for src/background.js (the tallies, the badge, host escalation, and the
 * dynamic-rule budget).
 *
 * The service worker is plain JS around the chrome.* APIs, so a fake chrome
 * object in node:vm is enough to exercise the real logic: message handling,
 * storage writes, badge text, the dynamic block rules, eviction at the cap, and
 * the reset.
 *
 * Run: node test/background.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'background.js'), 'utf8');
const popupHosts = fs.readFileSync(path.join(root, 'src', 'popup-hosts.js'), 'utf8');
const wallHosts = fs.readFileSync(path.join(root, 'src', 'wall-hosts.js'), 'utf8');

// --- fake extension environment --------------------------------------------

// Chrome reports 5,000 here (30,000 on 121+); the fake reports a small number so
// the cap and the eviction path can be exercised without looping thousands of
// times. The worker must read this value instead of hardcoding a limit.
const DYNAMIC_LIMIT = 15;

const store = {};
const badgeCalls = [];
const enabledRulesets = [];
const disabledRulesets = [];
const addedRules = [];
let powerOnResets = 0;
const removedRuleIds = [];
let messageListener = null;

const chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => {
        messageListener = fn;
      },
    },
    // The probe reports the build the browser is running, so the fake has to be
    // able to answer for one.
    getManifest: () => ({ version: '0.0.0-test' }),
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    // The worker reads the ruleset ids out of its own manifest rather than
    // hardcoding them, which is the point: a ruleset added by the build script
    // is covered by the switch with no code change.
    getManifest: () => ({
      declarative_net_request: {
        rule_resources: [
          { id: 'youtube_ads' },
          { id: 'dnr_1' },
          { id: 'dnr_2' },
          { id: 'dnr_3' },
          { id: 'dnr_4' },
        ],
      },
    }),
  },
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => {
        Object.assign(store, obj);
      },
    },
  },
  action: {
    setBadgeBackgroundColor: () => {},
    setBadgeText: ({ text }) => {
      badgeCalls.push(text);
    },
  },
  declarativeNetRequest: {
    MAX_NUMBER_OF_DYNAMIC_RULES: DYNAMIC_LIMIT,
    updateDynamicRules: async ({ addRules, removeRuleIds } = {}) => {
      if (Array.isArray(addRules)) addedRules.push(...addRules);
      if (Array.isArray(removeRuleIds)) removedRuleIds.push(...removeRuleIds);
    },
    getDynamicRules: async () =>
      addedRules.filter((rule) => !removedRuleIds.includes(rule.id)),
    updateEnabledRulesets: async ({ enableRulesetIds, disableRulesetIds } = {}) => {
      if (Array.isArray(enableRulesetIds)) enabledRulesets.push(...enableRulesetIds);
      if (Array.isArray(disableRulesetIds)) disabledRulesets.push(...disableRulesetIds);
    },
  },
  tabs: {
    query: async () => [{ id: 1 }, { id: 2 }],
  },
  // Element hiding moved out of the manifest and into the worker precisely
  // because a manifest entry cannot be switched off, so these two calls are the
  // off switch for everything the stylesheets do.
  scripting: {
    insertCSS: async (options) => {
      cssInserts.push(options);
    },
    removeCSS: async (options) => {
      cssRemoves.push(options);
    },
  },
  webNavigation: {
    onCommitted: { addListener: (fn) => (committedListener = fn) },
  },
};

const cssInserts = [];
const cssRemoves = [];
let committedListener = null;

const sandbox = { chrome, console, Date, Math, Number, Object, Promise, JSON, String, URL, self: {} };
vm.createContext(sandbox);
// Mimics the worker's importScripts of the generated host list.
// The worker's element hiding asks the deep block whether a host walls readers,
// so the sandbox needs one that can answer.
// Only the walled-host test matters here, but the worker calls the rest of the
// surface too, so the stand-in carries the whole shape as no-ops.
sandbox.self.AdblockerDeep = {
  isWalledHost: (host) => /(^|\.)bild\.de$/i.test(String(host || '')),
  ensureEngine: async () => true,
  setSettings: () => {},
  setPinned: () => {},
  setKnownHosts: () => {},
  detachAll: async () => 0,
  publish: () => {},
  ensureEngine: async () => false,
  sweep: () => {},
  idleCheck: () => {},
  state: () => ({}),
  isAttached: () => false,
  touch: () => {},
  maybeAttach: async () => false,
  signalAttach: async () => false,
  attach: async () => true,
  detach: async () => true,
  // The switch coming back on has to clear the cooldown a failed attach left
  // behind, or the tab that failed while the extension was off stays refused.
  resetAttempts: () => {
    powerOnResets += 1;
    return true;
  },
  // The probe gathers this layer's own decisions, so the fake has to carry one
  // or the wiring can be broken and the check still pass.
  diag: () => ({ events: [{ k: 'stub-answer', type: 'script' }], counts: ['example.com stub-answer script x1'] }),
  state: () => ({ attached: 0 })
};
vm.runInContext(popupHosts, sandbox, { filename: 'popup-hosts.js' });
// The generated wall-host list rides src/deepblock.js in the real worker. Here
// the deep block is a fake, so the list is loaded on its own, or the carve-out
// has nothing to carve and the check that guards it passes on an empty list.
vm.runInContext(wallHosts, sandbox, { filename: 'wall-hosts.js' });
vm.runInContext(source, sandbox, { filename: 'background.js' });

const internals = vm.runInContext('globalThis.__yazTestHooks', sandbox);
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const hostOf = (entry) => (typeof entry === 'string' ? entry : entry.host);
const registered = async () => (await internals.registeredHosts()).map(hostOf);

// --- checks ----------------------------------------------------------------

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${(err && err.message) || err}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'assertion failed');
};

(async () => {
  await check('exports usable internals', async () => {
    assert(internals && typeof internals.formatBadge === 'function', 'formatBadge missing');
    assert(typeof internals.addBlocked === 'function', 'addBlocked missing');
    assert(typeof internals.escalateHost === 'function', 'escalateHost missing');
    assert(typeof internals.escalationCap === 'function', 'escalationCap missing');
    assert(typeof internals.registeredHosts === 'function', 'registeredHosts missing');
  });

  await check('formats badge text for small and large totals', async () => {
    assert(internals.formatBadge(0) === '0', `0 -> ${internals.formatBadge(0)}`);
    assert(internals.formatBadge(7) === '7', `7 -> ${internals.formatBadge(7)}`);
    assert(internals.formatBadge(999) === '999', `999 -> ${internals.formatBadge(999)}`);
    assert(internals.formatBadge(1200) === '1.2k', `1200 -> ${internals.formatBadge(1200)}`);
    assert(internals.formatBadge(25000) === '25k', `25000 -> ${internals.formatBadge(25000)}`);
  });

  await check('counts blocked ads and paints the badge', async () => {
    assert(typeof messageListener === 'function', 'no onMessage listener registered');
    messageListener({ type: 'yt-ad-zapper:ads-blocked', count: 3 }, {}, () => {});
    await settle();
    assert(store.stats && store.stats.ads === 3, `expected 3 ads, got ${store.stats && store.stats.ads}`);
    assert(store.stats.videos === 1, `expected 1 video, got ${store.stats.videos}`);
    assert(store.stats.lastAt > 0, 'lastAt was not stamped');
    assert(badgeCalls[badgeCalls.length - 1] === '3', `badge shows ${badgeCalls[badgeCalls.length - 1]}`);
  });

  await check('stacks sequential reports', async () => {
    messageListener({ type: 'yt-ad-zapper:ads-blocked', count: 2 }, {}, () => {});
    messageListener({ type: 'yt-ad-zapper:ads-blocked', count: 4 }, {}, () => {});
    await settle();
    assert(store.stats.ads === 9, `expected 9 ads, got ${store.stats.ads}`);
    assert(store.stats.videos === 3, `expected 3 videos, got ${store.stats.videos}`);
    assert(badgeCalls[badgeCalls.length - 1] === '9', `badge shows ${badgeCalls[badgeCalls.length - 1]}`);
  });

  await check('counts killed popups with their host', async () => {
    messageListener({ type: 'yt-ad-zapper:popup-blocked', kind: 'popup', host: 'www.oqhbgxvk.com' }, {}, () => {});
    await settle();
    assert(store.stats.popups === 1, `expected 1 popup, got ${store.stats.popups}`);
    assert(store.stats.lastPopupHost === 'www.oqhbgxvk.com', `host is ${store.stats.lastPopupHost}`);
    assert(store.stats.lastPopupKind === 'popup', `kind is ${store.stats.lastPopupKind}`);
  });

  await check('ignores other messages and zero counts', async () => {
    messageListener({ type: 'something-else', count: 99 }, {}, () => {});
    messageListener({ type: 'yt-ad-zapper:ads-blocked', count: 0 }, {}, () => {});
    await settle();
    assert(store.stats.ads === 9, `expected 9 ads, got ${store.stats.ads}`);
  });

  await check('escalates a caught loader host into a block rule', async () => {
    messageListener({ type: 'yt-ad-zapper:escalate', host: 'fdgkhjxzqwrt.com' }, {}, () => {});
    await settle();
    assert(await registered().then((list) => list.includes('fdgkhjxzqwrt.com')), 'host was not recorded');
    const rule = addedRules.find((candidate) => candidate.condition.urlFilter === '||fdgkhjxzqwrt.com^');
    assert(rule, 'no dynamic rule was added');
    assert(rule.action.type === 'block', `action is ${rule.action.type}`);
    assert(rule.condition.resourceTypes.includes('script'), 'scripts are not covered');
    assert(rule.condition.resourceTypes.includes('sub_frame'), 'frames are not covered');
  });

  await check('escalates a host that is on the generated list', async () => {
    messageListener({ type: 'yt-ad-zapper:escalate', host: 'hkryzvagqpjuj.com' }, {}, () => {});
    await settle();
    assert(
      addedRules.some((rule) => rule.condition.urlFilter === '||hkryzvagqpjuj.com^'),
      'listed host was not escalated'
    );
  });

  await check('refuses protected infrastructure', async () => {
    const before = addedRules.length;
    for (const host of ['google.com', 'youtube.com', 'cloudflare.com', 'apple.com', 'github.com']) {
      messageListener({ type: 'yt-ad-zapper:escalate', host }, {}, () => {});
    }
    await settle();
    assert(addedRules.length === before, `added ${addedRules.length - before} rule(s) for protected hosts`);
  });

  await check('refuses hosts that are not ad infrastructure', async () => {
    const before = addedRules.length;
    for (const host of ['example.com', 'stackoverflow.com', 'my-blog.net']) {
      messageListener({ type: 'yt-ad-zapper:escalate', host }, {}, () => {});
    }
    await settle();
    assert(addedRules.length === before, `added ${addedRules.length - before} rule(s) for ordinary hosts`);
  });

  await check('rejects malformed hostnames', async () => {
    const before = addedRules.length;
    for (const host of ['', 'no-dots', '..', 'http://example.com/', 'a b c.com', '-leading.com']) {
      await internals.escalateHost(host);
    }
    assert(addedRules.length === before, `added ${addedRules.length - before} rule(s) for malformed hosts`);
  });

  await check('counts a repeated catch instead of adding a second rule', async () => {
    const before = addedRules.length;
    const result = await internals.escalateHost('fdgkhjxzqwrt.com');
    assert(result === null, 'a repeat reported a new escalation');
    assert(addedRules.length === before, 'duplicate rule added');
    const record = (await internals.registeredHosts()).find((entry) => hostOf(entry) === 'fdgkhjxzqwrt.com');
    assert(record && record.hits === 2, `hits is ${record && record.hits}`);
  });

  await check('takes its cap from the platform instead of hardcoding one', async () => {
    const cap = internals.escalationCap();
    assert(cap <= DYNAMIC_LIMIT, `cap ${cap} exceeds the dynamic rule limit ${DYNAMIC_LIMIT}`);
    assert(cap === DYNAMIC_LIMIT - 100 || cap === 10, `cap ${cap} ignores the platform limit`);
  });

  await check('evicts the least useful host when the cap is full', async () => {
    const cap = internals.escalationCap();
    for (let index = 0; index < cap + 5; index += 1) {
      await internals.escalateHost(`fdgkhjxzqwrt${index}.com`);
    }
    const list = await registered();
    assert(list.length === cap, `registry holds ${list.length}, cap is ${cap}`);
    assert(!list.includes('fdgkhjxzqwrt0.com'), 'the oldest one-hit host should have fallen off');
    assert(!list.includes('hkryzvagqpjuj.com'), 'the older one-hit host should have fallen off first');
    assert(list.includes(`fdgkhjxzqwrt${cap + 4}.com`), 'the newest host should be kept');
    assert(list.includes('fdgkhjxzqwrt.com'), 'a host with two catches should outrank one-hit hosts');
    assert(removedRuleIds.length >= 5, `evicted rules were not removed (${removedRuleIds.length})`);
  });

  await check('the master switch turns Chrome matching off, everywhere at once', async () => {
    // The registry is full from the eviction test, so the dynamic side has
    // something to remove and later put back.
    const learned = await internals.registeredHosts();
    assert(learned.length > 0, 'the eviction test left no learned hosts');
    const before = removedRuleIds.length;

    const reply = await new Promise((resolve) => {
      messageListener({ type: 'yt-ad-zapper:power', enabled: false }, {}, resolve);
    });
    assert(reply && reply.enabled === false, `the worker replied ${JSON.stringify(reply)}`);
    assert(store.settings && store.settings.enabled === false, 'the switch was not stored');

    assert(disabledRulesets.length === 5, `disabled ${disabledRulesets.length} rulesets, expected 5`);
    assert(disabledRulesets.includes('dnr_4'), 'a generated ruleset was left enabled');
    assert(disabledRulesets.includes('youtube_ads'), 'the hand-written ruleset was left enabled');
    assert(
      removedRuleIds.length - before >= learned.length,
      `removed ${removedRuleIds.length - before} of ${learned.length} learned rules`
    );
    assert(badgeCalls[badgeCalls.length - 1] === 'off', `badge shows ${badgeCalls[badgeCalls.length - 1]}`);
  });

  await check('the switch back on restores the rulesets and the learned hosts', async () => {
    const added = addedRules.length;
    const reply = await new Promise((resolve) => {
      messageListener({ type: 'yt-ad-zapper:power', enabled: true }, {}, resolve);
    });
    assert(reply && reply.enabled === true, `the worker replied ${JSON.stringify(reply)}`);
    assert(store.settings.enabled === true, 'the switch was not stored as on');
    assert(enabledRulesets.length === 5, `enabled ${enabledRulesets.length} rulesets, expected 5`);
    assert(addedRules.length > added, 'the learned hosts were not put back');
    assert(badgeCalls[badgeCalls.length - 1] !== 'off', 'the badge still says off');
  });

  await check('a host caught repeatedly survives eviction pressure', async () => {
    const cap = internals.escalationCap();
    for (let index = 0; index < 6; index += 1) {
      await internals.escalateHost('fdgkhjxzqwrt.com');
    }
    await internals.escalateHost('zxcvbnmkjhgf.com');
    const list = await registered();
    assert(list.length === cap, `registry holds ${list.length}, cap is ${cap}`);
    assert(list.includes('fdgkhjxzqwrt.com'), 'the well-caught host was evicted');
    assert(list.includes('zxcvbnmkjhgf.com'), 'the new host was refused instead of evicting');
  });

  await check('reset clears the tally, the badge and the dynamic rules', async () => {
    let response = null;
    const kept = messageListener({ type: 'yt-ad-zapper:reset' }, {}, (value) => {
      response = value;
    });
    assert(kept === true, 'the reset handler must return true for the async response');
    await settle();
    assert(response && response.ok === true, 'reset did not answer');
    assert(store.stats.ads === 0, `expected 0 ads, got ${store.stats.ads}`);
    assert(store.stats.videos === 0, `expected 0 videos, got ${store.stats.videos}`);
    assert(store.stats.popups === 0, `expected 0 popups, got ${store.stats.popups}`);
    assert(badgeCalls[badgeCalls.length - 1] === '', `badge shows "${badgeCalls[badgeCalls.length - 1]}"`);
    assert(Array.isArray(store.escalated) && store.escalated.length === 0, 'escalated hosts were kept');
    assert(removedRuleIds.length >= 10, `expected the dynamic rules to be removed, got ${removedRuleIds.length}`);
  });

  await check('reports after a reset start from zero', async () => {
    messageListener({ type: 'yt-ad-zapper:ads-blocked', count: 5 }, {}, () => {});
    await settle();
    assert(store.stats.ads === 5, `expected 5 ads, got ${store.stats.ads}`);
    assert(badgeCalls[badgeCalls.length - 1] === '5', `badge shows ${badgeCalls[badgeCalls.length - 1]}`);
  });

  await check('describes the tab the popup is open on', async () => {
    messageListener({ type: 'yt-ad-zapper:page', url: 'https://www.vfxmed.com/post/' }, { tab: { id: 5 } }, () => {});
    let info = null;
    messageListener({ type: 'yt-ad-zapper:tab-info', tabId: 5 }, {}, (value) => {
      info = value;
    });
    await settle();
    assert(info && info.host === 'www.vfxmed.com', `host is ${info && info.host}`);
    assert(info.attached === false, 'a tab with no deep session reported as attached');
    assert(info.pinned === false, 'a fresh host reported as pinned');
  });

  await check('pins and unpins a site through storage', async () => {
    let answer = null;
    messageListener({ type: 'yt-ad-zapper:pin', host: 'www.vfxmed.com', pin: true, tabId: 5 }, {}, (value) => {
      answer = value;
    });
    await settle();
    assert(answer && answer.ok === true, 'the pin did not answer');
    assert(
      Array.isArray(store.pinned) && store.pinned.includes('www.vfxmed.com'),
      `storage holds ${JSON.stringify(store.pinned)}`
    );
    let info = null;
    messageListener({ type: 'yt-ad-zapper:tab-info', tabId: 5 }, {}, (value) => {
      info = value;
    });
    await settle();
    assert(info && info.pinned === true, 'the tab does not report as pinned');

    messageListener({ type: 'yt-ad-zapper:pin', host: 'www.vfxmed.com', pin: false, tabId: 5 }, {}, () => {});
    await settle();
    assert(Array.isArray(store.pinned) && store.pinned.length === 0, 'the pin was not removed');
  });

  await check('stores a deep-block mode set from the popup', async () => {
    let answer = null;
    messageListener({ type: 'yt-ad-zapper:settings', deepBlock: 'always' }, {}, (value) => {
      answer = value;
    });
    await settle();
    assert(answer && answer.ok === true, 'the mode switch did not answer');
    assert(answer.mode === 'always', `mode is ${answer.mode}`);
    assert(store.settings && store.settings.deepBlock === 'always', 'the mode was not stored');

    messageListener({ type: 'yt-ad-zapper:settings', deepBlock: 'nonsense' }, {}, (value) => {
      answer = value;
    });
    await settle();
    assert(answer && answer.mode === 'smart', `an invalid mode fell back to ${answer && answer.mode}`);
    assert(store.settings.deepBlock === 'smart', 'the fallback was not stored');
  });

  await check('the hiding stylesheets follow the switch, which a manifest entry cannot do', async () => {
    const off = await new Promise((resolve) =>
      messageListener({ type: 'yt-ad-zapper:power', enabled: false }, {}, resolve)
    );
    await settle();
    assert(off && off.enabled === false, 'the switch did not go off');
    assert(
      cssRemoves.some(
        (call) =>
          call.target &&
          call.target.allFrames &&
          (call.files || []).includes('src/generic-cosmetic.css')
      ),
      'the hiding stylesheet could not be removed, so off would still hide ads'
    );

    const on = await new Promise((resolve) =>
      messageListener({ type: 'yt-ad-zapper:power', enabled: true }, {}, resolve)
    );
    await settle();
    assert(on && on.enabled === true, 'the switch did not come back on');
    assert(
      cssInserts.filter((call) => (call.files || []).includes('src/generic-cosmetic.css')).length >= 1,
      'the hiding stylesheet was not injected for the open tabs'
    );
  });

  await check('a committed frame gets the stylesheet only while the switch is on', async () => {
    assert(typeof committedListener === 'function', 'no onCommitted listener was registered');
    const before = cssInserts.length;
    committedListener({ tabId: 5, frameId: 3 });
    await settle();
    assert(cssInserts.length === before + 1, 'a committed frame was given no stylesheet with the switch on');
    const last = cssInserts[cssInserts.length - 1];
    assert(last.target && last.target.frameIds && last.target.frameIds[0] === 3, 'the stylesheet went to the wrong frame');

    await new Promise((resolve) =>
      messageListener({ type: 'yt-ad-zapper:power', enabled: false }, {}, resolve)
    );
    await settle();
    const quiet = cssInserts.length;
    committedListener({ tabId: 5, frameId: 3 });
    await settle();
    assert(cssInserts.length === quiet, 'a committed frame was given stylesheets with the switch off');

    await new Promise((resolve) =>
      messageListener({ type: 'yt-ad-zapper:power', enabled: true }, {}, resolve)
    );
    await settle();
  });

  await check('switching back on clears the attach cooldown', async () => {
    powerOnResets = 0;
    messageListener({ type: 'yt-ad-zapper:power', enabled: true }, {}, () => {});
    await settle();
    assert(
      powerOnResets >= 1,
      'the switch came back on without clearing the cooldown a failed attach left behind'
    );
  });

  await check('the probe answers with the build, the carve-out and the decisions', async () => {
    const answer = await internals.diagInfo();
    assert(
      answer && typeof answer.version === 'string' && answer.version.length > 0,
      `the probe answered without a build: ${JSON.stringify(answer).slice(0, 240)}`
    );
    assert(answer.enabled === true || answer.enabled === false, 'the probe answered without a switch state');
    assert(answer.walledHosts >= 1, 'the probe answered without the walled hosts');
    assert(
      typeof answer.allowRules === 'number' && answer.allowRules >= 11,
      `the probe reported ${answer.allowRules} allow rule(s)`
    );
    assert(answer.deep && Array.isArray(answer.deep.events), 'the probe carried no decision ring');
  });

  await check('the carve-out leaves the page-world hosts to the rule sets', async () => {
    const allows = addedRules.filter((rule) => rule.action && rule.action.type === 'allow');
    const carved = allows.reduce(
      (all, rule) => all.concat((rule.condition && rule.condition.initiatorDomains) || []),
      []
    );
    assert(
      !carved.includes('youtube.com') && !carved.includes('www.youtube.com'),
      'youtube is carved out, so the rule sets stand down on the busiest site there is'
    );
    assert(carved.includes('bild.de'), 'bild.de should still be carved out');
  });

  await check('the filter lists stand down on the walled hosts', async () => {
    const allows = addedRules.filter((rule) => rule.action && rule.action.type === 'allow');
    assert(allows.length >= 11, `only ${allows.length} allow rule(s) were installed`);
    const bild = allows.find((rule) =>
      ((rule.condition && rule.condition.initiatorDomains) || []).includes('bild.de')
    );
    assert(bild, 'bild.de was not carved out of the filter lists');
    assert(
      bild.priority > 1,
      'the carve-out does not outrank the static lists, which sit at priority 1'
    );
    assert(
      (bild.condition.excludedResourceTypes || []).includes('main_frame'),
      'documents were carved out too, so the wall refusal and the copy never see one'
    );
    assert(
      bild.action.type === 'allow',
      'the carve-out is not an allow rule, so it cannot lift a block from another ruleset'
    );
    // The other direction: anything asking for the site's own hosts. Without it
    // the site's own scripts and consent layer fail, which is the cleanest
    // signal a detector can read.
    const firstParty = allows.find((rule) =>
      ((rule.condition && rule.condition.requestDomains) || []).includes('bild.de')
    );
    assert(firstParty, 'requests to the site\'s own hosts were not carved out');
    assert(
      (firstParty.condition.excludedResourceTypes || []).includes('main_frame'),
      'navigations were carved out too, so the wall refusal never sees one'
    );
  });

  await check('a walled host is not given the all-sites hiding stylesheet', async () => {
    const before = cssInserts.length;
    committedListener({ tabId: 9, frameId: 0, url: 'https://www.bild.de/politik/' });
    await settle();
    const walledInsert = cssInserts[cssInserts.length - 1];
    assert(cssInserts.length === before + 1, 'a walled frame got no stylesheet at all');
    assert(
      (walledInsert.files || []).includes('src/cosmetic.css'),
      'the site-specific stylesheet was dropped for a walled host'
    );
    assert(
      !(walledInsert.files || []).includes('src/generic-cosmetic.css'),
      'the all-sites stylesheet was injected on a walled host, which is the cosmetic tell'
    );

    const ordinary = cssInserts.length;
    committedListener({ tabId: 9, frameId: 0, url: 'https://example.com/' });
    await settle();
    assert(
      (cssInserts[cssInserts.length - 1].files || []).includes('src/generic-cosmetic.css'),
      'an ordinary host lost the all-sites stylesheet'
    );
    assert(cssInserts.length === ordinary + 1, 'the ordinary frame was skipped');
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL'));
  if (failed.length) {
    console.log(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
})();
