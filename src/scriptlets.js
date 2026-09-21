/*
 * Ad Zapper: scriptlets.
 *
 * Scriptlet filters ask for a piece of page-world code to run before the site's
 * own scripts, to defuse the machinery an adblock wall or an ad script checks
 * for. The vendored engine carries no scriptlet code, so these are hand-written
 * and deliberately few: each one is small enough to read in one sitting, and a
 * name with no implementation here is skipped by tools/build-scriptlets.mjs
 * rather than approximated.
 *
 * `AD_ZAPPER_RUN_SCRIPTLET` is passed through chrome.scripting.executeScript, so
 * it must stay self-contained: it cannot reference anything outside its own
 * body, since Chrome serializes it with toString() and runs it in the page's
 * world. Everything it touches is reached through `window` and `document`.
 *
 * Both globals here are assigned on `self` inside an IIFE. Content scripts in
 * one frame share an isolated world, so a bare top-level `const` would be a
 * load-time SyntaxError the moment two of them picked the same name.
 *
 * Nothing here runs when the master switch is off or the site is allowlisted;
 * src/relay.js decides that before calling in.
 */
(() => {
  'use strict';

  const AD_ZAPPER_RUN_SCRIPTLET = function (name, args) {
    'use strict';
    const w = window;
    const d = w.document || {};
    const list = args || [];

    // A scriptlet argument is either `/regex/flags` or a plain substring to
    // look for. Everything in this file matches through this.
    const toMatcher = (value) => {
      if (!value) return null;
      const rx = /^\/(.*)\/([gimsuy]*)$/.exec(value);
      if (rx) {
        try {
          return new RegExp(rx[1], rx[2]);
        } catch (_) {
          return null;
        }
      }
      return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    };
    const hits = (matcher, value) => {
      if (!matcher) return false;
      matcher.lastIndex = 0;
      return matcher.test(String(value == null ? '' : value));
    };
    const walk = (path) => {
      const parts = String(path || '').split('.').filter(Boolean);
      if (!parts.length) return null;
      let target = w;
      for (let index = 0; index < parts.length - 1; index += 1) {
        target = target[parts[index]];
        if (!target || (typeof target !== 'object' && typeof target !== 'function')) return null;
      }
      return { target, key: parts[parts.length - 1] };
    };

    switch (name) {
      case 'set': {
        // set, property, value. The value vocabulary is uBO's, because the
        // filters are written against it.
        const where = walk(list[0]);
        if (!where) return 'set: no target';
        const raw = list[1];
        const literals = {
          false: false,
          true: true,
          null: null,
          undefined: undefined,
          '': '',
          '0': 0,
          noopFunc: function () {},
          trueFunc: function () {
            return true;
          },
          falseFunc: function () {
            return false;
          },
          noopCallbackFunc: function () {},
          throwFunc: function () {
            throw new Error('ad zapper');
          }
        };
        let value;
        if (Object.prototype.hasOwnProperty.call(literals, raw)) value = literals[raw];
        else if (/^-?\d+$/.test(raw)) value = Number(raw);
        else if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) value = raw.slice(1, -1);
        else value = raw;
        try {
          Object.defineProperty(where.target, where.key, {
            get: function () {
              return value;
            },
            set: function () {},
            configurable: true
          });
          return 'set ' + list[0];
        } catch (error) {
          return 'set failed: ' + error.message;
        }
      }

      case 'json-prune': {
        // json-prune, prop1 prop2. Deletes those properties wherever they turn
        // up in what the page parses, at any depth, so an ad schedule that
        // arrives inside a larger payload loses its fields.
        const props = String(list.join(' ')).split(/\s+/).filter(Boolean);
        if (!props.length) return 'json-prune: no properties';
        const prune = (node, depth) => {
          if (!node || typeof node !== 'object' || depth > 8) return;
          for (const prop of props) {
            if (Object.prototype.hasOwnProperty.call(node, prop)) {
              try {
                delete node[prop];
              } catch (_) {}
            }
          }
          for (const key of Object.keys(node)) {
            const child = node[key];
            if (child && typeof child === 'object') prune(child, depth + 1);
          }
        };
        const nativeParse = w.JSON.parse;
        w.JSON.parse = function () {
          const parsed = nativeParse.apply(this, arguments);
          try {
            prune(parsed, 0);
          } catch (_) {}
          return parsed;
        };
        const responseProto = w.Response && w.Response.prototype;
        if (responseProto && typeof responseProto.json === 'function') {
          const nativeJson = responseProto.json;
          responseProto.json = function () {
            return nativeJson.apply(this, arguments).then((parsed) => {
              try {
                prune(parsed, 0);
              } catch (_) {}
              return parsed;
            });
          };
        }
        return 'json-prune ' + props.join(' ');
      }

      case 'no-fetch-if': {
        const matchers = list.filter((arg) => !/^(method|type|propsToMatch)=/i.test(arg)).map(toMatcher).filter(Boolean);
        if (!matchers.length || typeof w.fetch !== 'function') return 'no-fetch-if: unsupported';
        const nativeFetch = w.fetch;
        w.fetch = function (input) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (matchers.some((matcher) => hits(matcher, url))) return Promise.reject(new TypeError('Failed to fetch'));
          return nativeFetch.apply(this, arguments);
        };
        return 'no-fetch-if ' + matchers.length;
      }

      case 'no-xhr-if': {
        const matchers = list.filter((arg) => !/^(method|propsToMatch)=/i.test(arg)).map(toMatcher).filter(Boolean);
        const proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
        if (!matchers.length || !proto) return 'no-xhr-if: unsupported';
        const nativeOpen = proto.open;
        const nativeSend = proto.send;
        proto.open = function (method, url) {
          if (matchers.some((matcher) => hits(matcher, url))) {
            this.__adZapperDefused = true;
            return;
          }
          return nativeOpen.apply(this, arguments);
        };
        proto.send = function () {
          if (this.__adZapperDefused) return;
          return nativeSend.apply(this, arguments);
        };
        return 'no-xhr-if ' + matchers.length;
      }

      case 'abort-on-property-read':
      case 'abort-on-property-write': {
        const where = walk(list[0]);
        if (!where) return name + ': no target';
        const throwing = function () {
          throw new ReferenceError('ad zapper');
        };
        try {
          if (name === 'abort-on-property-read') {
            Object.defineProperty(where.target, where.key, {
              get: throwing,
              set: function () {},
              configurable: true
            });
          } else {
            Object.defineProperty(where.target, where.key, {
              get: function () {
                return undefined;
              },
              set: throwing,
              configurable: true
            });
          }
          return name + ' ' + list[0];
        } catch (error) {
          return name + ' failed: ' + error.message;
        }
      }

      case 'abort-current-inline-script': {
        // acs, propertyChain, [pattern]. The inline script an adblock wall uses
        // to read the property is aborted by throwing where it reads it; the
        // property itself is untouched for anything else.
        const where = walk(list[0]);
        if (!where) return 'acs: no target';
        const matcher = list[1] ? toMatcher(list[1]) : null;
        let original = where.target[where.key];
        try {
          Object.defineProperty(where.target, where.key, {
            get: function () {
              const script = d.currentScript;
              const source = script ? script.textContent || script.src || '' : '';
              if (!matcher || hits(matcher, source)) throw new ReferenceError('ad zapper');
              return original;
            },
            set: function (value) {
              original = value;
            },
            configurable: true
          });
          return 'abort-current-inline-script ' + list[0];
        } catch (error) {
          return 'acs failed: ' + error.message;
        }
      }

      case 'no-window-open-if': {
        // nowoif, [pattern]. Without a pattern every open is defused. This sits
        // outside whatever patching the popup killer already did, so it only
        // needs to answer for matching URLs.
        const matchers = list.map(toMatcher).filter(Boolean);
        if (typeof w.open !== 'function') return 'nowoif: unsupported';
        const nativeOpen = w.open;
        w.open = function (url) {
          const target = String(url == null ? '' : url);
          if (!matchers.length || matchers.some((matcher) => hits(matcher, target))) return null;
          return nativeOpen.apply(this, arguments);
        };
        return 'no-window-open-if';
      }

      case 'addEventListener-defuser': {
        // aeld, pattern[, type]. Drops listeners whose handler or type matches,
        // which is how most "listen for the blocker and complain" code works.
        const typeMatcher = list.length > 1 ? toMatcher(list[1]) : null;
        const handlerMatcher = toMatcher(list[0]);
        const proto = w.EventTarget && w.EventTarget.prototype;
        if (!proto || (!typeMatcher && !handlerMatcher)) return 'aeld: unsupported';
        const nativeAdd = proto.addEventListener;
        proto.addEventListener = function (type, handler) {
          const handlerText = typeof handler === 'function' ? String(handler) : '';
          if ((!typeMatcher || hits(typeMatcher, type)) && (!handlerMatcher || hits(handlerMatcher, handlerText))) {
            return;
          }
          return nativeAdd.apply(this, arguments);
        };
        return 'addEventListener-defuser';
      }

      case 'no-setTimeout-if':
      case 'no-setInterval-if': {
        const native = name === 'no-setTimeout-if' ? w.setTimeout : w.setInterval;
        if (typeof native !== 'function') return name + ': unsupported';
        const matchers = list.filter((arg) => !/^!?\d+$/.test(arg)).map(toMatcher).filter(Boolean);
        const delays = list.filter((arg) => /^!?\d+$/.test(arg));
        if (!matchers.length) return name + ': no matcher';
        const wrapped = function (handler, delay) {
          const handlerText = typeof handler === 'function' ? String(handler) : String(handler || '');
          const matched = matchers.some((matcher) => hits(matcher, handlerText));
          const delayMatched = delays.length
            ? delays.some((value) => (value[0] === '!' ? Number(delay) !== Number(value.slice(1)) : Number(delay) === Number(value)))
            : true;
          if (matched && delayMatched) {
            // Same shape as a real call, so code that keeps the id still works.
            return native.call(w, function () {}, delay);
          }
          return native.apply(this, arguments);
        };
        if (name === 'no-setTimeout-if') w.setTimeout = wrapped;
        else w.setInterval = wrapped;
        return name;
      }

      case 'cookie-remover': {
        const proto = w.Document && w.Document.prototype;
        const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'cookie');
        if (!descriptor || !descriptor.set) return 'cookie-remover: unsupported';
        const names = list.map((arg) => String(arg).replace(/^\/|\/$/g, '')).filter(Boolean);
        if (!names.length) return 'cookie-remover: no names';
        Object.defineProperty(proto, 'cookie', {
          configurable: true,
          get: function () {
            return descriptor.get.call(this);
          },
          set: function (value) {
            const cookieName = String(value).split('=')[0].trim();
            if (names.some((entry) => cookieName === entry || String(value).includes(entry))) return;
            return descriptor.set.call(this, value);
          }
        });
        return 'cookie-remover ' + names.join(',');
      }

      case 'set-cookie': {
        if (!d || typeof d.cookie === 'undefined') return 'set-cookie: unsupported';
        const value = list.join(',');
        if (!value) return 'set-cookie: empty';
        try {
          d.cookie = value;
          return 'set-cookie';
        } catch (error) {
          return 'set-cookie failed: ' + error.message;
        }
      }

      default:
        return 'unknown scriptlet ' + name;
    }
  };

  // host -> the calls that apply to it: everything generic, plus the entries for
  // the closest matching domain, the way a filter with a domain list works.
  const AD_ZAPPER_SCRIPTLETS_FOR = (host) => {
    const map = self.AD_ZAPPER_SCRIPTLETS || { generic: [], hosts: {} };
    const out = (map.generic || []).slice();
    let name = String(host || '').toLowerCase();
    for (;;) {
      if (!name) break;
      const entries = map.hosts && map.hosts[name];
      if (entries && entries.length) {
        for (const entry of entries) out.push(entry);
        break;
      }
      const dot = name.indexOf('.');
      if (dot < 0) break;
      name = name.slice(dot + 1);
    }
    return out;
  };

  self.AD_ZAPPER_RUN_SCRIPTLET = AD_ZAPPER_RUN_SCRIPTLET;
  self.AD_ZAPPER_SCRIPTLETS_FOR = AD_ZAPPER_SCRIPTLETS_FOR;
})();
