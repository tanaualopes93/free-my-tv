/*
 * Reads and writes the TV's own list of web apps (websdk/Appinfo.json) through the browser's HiUtils_createRequest.
 * Rules: only entries we own are ever changed (Id starting with "fmtv_", plus the legacy "FreeMyTV"); every other
 * entry goes back out byte for byte; nothing is written before a backup is confirmed; after writing, the list is
 * read again and compared. ES5 on purpose, no dependencies. UMD: window.FMTVRegistry or module.exports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FMTVRegistry = factory(root);
}(typeof window !== 'undefined' ? window : {}, function (root) {
  'use strict';

  var PATH = 'websdk/Appinfo.json';
  var MODE = 6;
  var PREFIX = 'fmtv_';
  var LEGACY_ID = 'FreeMyTV';
  var MAX_OURS = 30;
  var RING_MAX = 5;
  var RING_KEY = 'fmtv.reg.ring';
  var BASE_KEY = 'fmtv.reg.base';
  var BACKUP_TIMEOUT = 20000;
  var NOTIFY_MSG = {type: 'AllAppsUpdate'}; // shape not verified on a real TV; notify is best effort

  // Hosts an app may open over https. Fixed here on purpose: the catalog never adds a host.
  // Exact match only (no subdomains). Keep in sync with vidaa/store/catalogo.json (check.sh does not enforce it).
  var ALLOWED_DEFAULT = [
    'tanaualopes93.github.io',
    'hisense.tv.twitch.tv',
    'tv.emby.media'
  ];
  // Hosts allowed over plain http (shown to the person as "connection not protected"). Empty until a tested player needs one.
  var ALLOWED_HTTP_DEFAULT = [];

  var ID_RE = /^(FreeMyTV|[A-Za-z0-9][A-Za-z0-9-]{0,39})$/;
  var OUR_ID_RE = /^fmtv_[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
  var ICON_DATA_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+\/=]+$/;

  // ---------- small helpers ----------

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObject(v) { return !!v && typeof v === 'object' && !isArray(v); }
  function hasKey(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function once(fn) {
    var called = false;
    return function () {
      if (called) return;
      called = true;
      if (typeof fn === 'function') fn.apply(null, arguments);
    };
  }

  function indexOfValue(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i] === v) return i;
    return -1;
  }

  /** JSON with sorted keys, so two objects with the same content compare equal. */
  function canon(v) {
    if (isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(canon(v[i]));
      return '[' + a.join(',') + ']';
    }
    if (v && typeof v === 'object') {
      var keys = [];
      for (var k in v) if (hasKey(v, k)) keys.push(k);
      keys.sort();
      var parts = [];
      for (var j = 0; j < keys.length; j++) parts.push(JSON.stringify(keys[j]) + ':' + canon(v[keys[j]]));
      return '{' + parts.join(',') + '}';
    }
    return JSON.stringify(v);
  }

  function isOurId(id) {
    return typeof id === 'string' && (id === LEGACY_ID || id.indexOf(PREFIX) === 0);
  }

  function entryId(entry) {
    return isObject(entry) && typeof entry.Id === 'string' ? entry.Id : null;
  }

  function isOurEntry(entry) { return isOurId(entryId(entry)); }

  /** App id from the catalog ("netflix") to the Id in the TV's list ("fmtv_netflix"). */
  function idOf(appId) { return appId === LEGACY_ID ? LEGACY_ID : PREFIX + appId; }

  /** Id to remove: accepts "netflix", "fmtv_netflix" and "FreeMyTV". null when it can't be one of ours. */
  function removalId(x) {
    if (typeof x !== 'string') return null;
    if (x === LEGACY_ID || OUR_ID_RE.test(x)) return x;
    return ID_RE.test(x) ? PREFIX + x : null;
  }

  /** Local date as YYYY-M-D, the way the TV writes InstallTime. */
  function defaultToday() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // ---------- reading the list without changing a byte of the entries ----------

  var WS = ' \t\r\n';

  function skipWs(s, i) {
    while (i < s.length && WS.indexOf(s.charAt(i)) >= 0) i++;
    return i;
  }

  /** Index just after the string that starts at s[i] (a double quote), or -1. */
  function endOfString(s, i) {
    i++;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\\') i += 2;
      else if (c === '"') return i + 1;
      else i++;
    }
    return -1;
  }

  /** Index just after the JSON value that starts at s[i], or -1. Only called on text JSON.parse already accepted. */
  function endOfValue(s, i) {
    var c = s.charAt(i);
    if (c === '"') return endOfString(s, i);
    if (c === '{' || c === '[') {
      var depth = 0;
      while (i < s.length) {
        c = s.charAt(i);
        if (c === '"') { i = endOfString(s, i); if (i < 0) return -1; continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
        i++;
      }
      return -1;
    }
    while (i < s.length && ',]} \t\r\n'.indexOf(s.charAt(i)) < 0) i++;
    return i;
  }

  /** Splits {"AppInfo":[ ... ]} into the text around the array and the exact text of each element. */
  function scan(s) {
    var i = skipWs(s, 0);
    if (s.charAt(i) !== '{') return null;
    i++;
    var found = null;
    while (i < s.length) {
      i = skipWs(s, i);
      if (s.charAt(i) === '}') break;
      if (s.charAt(i) !== '"') return null;
      var kEnd = endOfString(s, i);
      if (kEnd < 0) return null;
      var key = JSON.parse(s.slice(i, kEnd));
      i = skipWs(s, kEnd);
      if (s.charAt(i) !== ':') return null;
      i = skipWs(s, i + 1);
      var vEnd = endOfValue(s, i);
      if (vEnd < 0) return null;
      if (key === 'AppInfo' && s.charAt(i) === '[') found = {open: i, close: vEnd - 1};
      i = skipWs(s, vEnd);
      if (s.charAt(i) === ',') i++;
    }
    if (!found) return null;

    var items = [];
    var p = found.open + 1;
    while (p < found.close) {
      p = skipWs(s, p);
      if (p >= found.close) break;
      var e = endOfValue(s, p);
      if (e < 0) return null;
      items.push({start: p, end: e, raw: s.slice(p, e)});
      p = skipWs(s, e);
      if (s.charAt(p) === ',') p++;
    }
    var out = {items: [], sep: ',', head: '', tail: ''};
    for (var n = 0; n < items.length; n++) out.items.push(items[n].raw);
    if (items.length > 1) out.sep = s.slice(items[0].end, items[1].start);
    if (items.length) {
      out.head = s.slice(0, items[0].start);
      out.tail = s.slice(items[items.length - 1].end);
    } else {
      out.head = s.slice(0, found.open + 1);
      out.tail = s.slice(found.close);
    }
    return out;
  }

  /** Parses the TV's list text. null when it is not a list we can safely rewrite. */
  function parseList(raw) {
    if (typeof raw !== 'string') return null;
    var list;
    try { list = JSON.parse(raw); } catch (e) { return null; }
    if (!isObject(list) || !isArray(list.AppInfo)) return null;
    var sc = scan(raw);
    if (!sc || sc.items.length !== list.AppInfo.length) return null;
    var items = [];
    for (var i = 0; i < sc.items.length; i++) {
      items.push({raw: sc.items[i], entry: list.AppInfo[i], ours: isOurEntry(list.AppInfo[i])});
    }
    return {raw: raw, list: list, items: items, head: sc.head, tail: sc.tail, sep: sc.sep};
  }

  function othersOf(parsed) {
    var out = [];
    for (var i = 0; i < parsed.items.length; i++) if (!parsed.items[i].ours) out.push(parsed.items[i]);
    return out;
  }

  /** True when the entries that are not ours (and the text around the list) are identical, byte for byte. */
  function sameOthersRaw(a, b) {
    if (a.head !== b.head || a.tail !== b.tail) return false;
    var oa = othersOf(a), ob = othersOf(b);
    if (oa.length !== ob.length) return false;
    for (var i = 0; i < oa.length; i++) if (oa[i].raw !== ob[i].raw) return false;
    return true;
  }

  // ---------- address checks ----------

  function parseUrl(u) {
    if (typeof u !== 'string' || u.length > 2048) return null;
    if (/[\u0000- \u007f-￿\\]/.test(u)) return null;
    var m = /^(https?):\/\/([^\/?#:@]+)(?::(\d{1,5}))?([\/?#].*)?$/i.exec(u);
    if (!m) return null;
    return {scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port: m[3] || ''};
  }

  function isPrivateIp(host) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    var n = [];
    for (var i = 1; i <= 4; i++) {
      if (m[i] !== String(Number(m[i])) || Number(m[i]) > 255) return false;
      n.push(Number(m[i]));
    }
    return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168);
  }

  // ---------- the factory ----------

  function create(host) {
    host = host || {};
    var hasRequest = host.request === undefined ? typeof root.HiUtils_createRequest === 'function' : typeof host.request === 'function';
    var request = host.request === undefined
      ? function (op, params) { return root.HiUtils_createRequest(op, params); }
      : host.request;
    var storage = host.storage;
    if (storage === undefined) {
      try { storage = root.localStorage || null; } catch (e) { storage = null; }
    }
    var notifyFn = host.notify;
    if (notifyFn === undefined) {
      notifyFn = function (msg) {
        var omi = root.omi_platform || root.opera_omi;
        if (omi && typeof omi.sendPlatformMessage === 'function') omi.sendPlatformMessage(msg);
      };
    }
    var todayFn = typeof host.today === 'function' ? host.today : defaultToday;
    var busy = false;

    var reg = {
      PATH: PATH,
      MODE: MODE,
      PREFIX: PREFIX,
      LEGACY_ID: LEGACY_ID,
      MAX_OURS: MAX_OURS,
      RING_MAX: RING_MAX,
      ALLOWED: ALLOWED_DEFAULT.slice(0),
      ALLOWED_HTTP: ALLOWED_HTTP_DEFAULT.slice(0)
    };

    function today() {
      var t;
      try { t = todayFn(); } catch (e) { t = null; }
      return typeof t === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(t) ? t : defaultToday();
    }

    /** One call to the TV: {ret, msg}, or null when the call threw or the API is missing. */
    function call(op, params) {
      if (!hasRequest) return null;
      try {
        var r = request(op, params);
        return isObject(r) ? r : null;
      } catch (e) {
        return null;
      }
    }

    // ----- read -----

    reg.read = function () {
      var out = {ok: false, raw: null, list: null, ours: [], error: null, parsed: null};
      if (!hasRequest) { out.error = 'no-api'; return out; }
      var r = call('fileRead', {path: PATH, mode: MODE});
      if (!r || r.ret !== true || typeof r.msg !== 'string' || r.msg === '') { out.error = 'unreadable'; return out; }
      out.raw = r.msg;
      var parsed = parseList(r.msg);
      if (!parsed) { out.error = 'unreadable'; return out; }
      out.ok = true;
      out.parsed = parsed;
      out.list = parsed.list;
      for (var i = 0; i < parsed.items.length; i++) if (parsed.items[i].ours) out.ours.push(parsed.items[i].entry);
      return out;
    };

    reg.probe = function () {
      var r = reg.read();
      return {
        available: hasRequest,
        readable: r.ok,
        count: r.ok ? r.list.AppInfo.length : 0,
        error: r.error
      };
    };

    // ----- entries -----

    reg.entryFor = function (app) {
      var icon = typeof app.icon === 'string' ? app.icon : '';
      return {
        Id: idOf(app.id),
        AppName: app.name,
        Title: app.name,
        URL: app.url,
        StartCommand: app.url,
        IconURL: icon,
        Icon_96: icon,
        Image: icon,
        Thumb: icon,
        Type: 'Browser',
        InstallTime: today(),
        RunTimes: 0,
        StoreType: 'custom',
        PreInstall: false
      };
    };

    /** {ok:true} or {ok:false, reason:'invalid'|'domain'}. opts.homeNetwork lets a private IP address through. */
    reg.check = function (app, opts) {
      opts = opts || {};
      if (!isObject(app)) return {ok: false, reason: 'invalid'};
      if (typeof app.id !== 'string' || !ID_RE.test(app.id)) return {ok: false, reason: 'invalid'};
      if (typeof app.name !== 'string' || !/\S/.test(app.name) || app.name.length > 60 || /[\u0000-\u001f\u007f]/.test(app.name)) {
        return {ok: false, reason: 'invalid'};
      }
      var icon = app.icon;
      if (icon !== undefined && icon !== null && icon !== '') {
        if (typeof icon !== 'string' || icon.length > 60000) return {ok: false, reason: 'invalid'};
        if (!/^https:\/\/[^\s\\]+$/i.test(icon) && !ICON_DATA_RE.test(icon)) return {ok: false, reason: 'invalid'};
      }
      var u = parseUrl(app.url);
      if (!u) return {ok: false, reason: 'invalid'};
      var priv = opts.homeNetwork === true && isPrivateIp(u.host);
      if (priv) return {ok: true};
      if (u.scheme === 'https') {
        if (indexOfValue(reg.ALLOWED, u.host) >= 0 && (u.port === '' || u.port === '443')) return {ok: true};
        return {ok: false, reason: 'domain'};
      }
      if (indexOfValue(reg.ALLOWED_HTTP, u.host) >= 0) return {ok: true};
      return {ok: false, reason: 'domain'};
    };

    // ----- plan (never writes) -----

    /** Every field of the wanted entry is in the existing one (RunTimes is the TV's own counter). */
    function sameEntry(have, want) {
      for (var k in want) {
        if (hasKey(want, k) && k !== 'RunTimes' && canon(have[k]) !== canon(want[k])) return false;
      }
      return true;
    }

    function fail(error, extra) {
      var r = {ok: false, add: [], update: [], remove: [], next: null, nextRaw: null, error: error};
      if (extra) for (var k in extra) if (hasKey(extra, k)) r[k] = extra[k];
      return r;
    }

    /** Plans against an already parsed list. */
    function buildPlan(parsed, changes, opts) {
      if (!isObject(changes)) return fail('invalid');
      var install = changes.install === undefined ? [] : changes.install;
      var remove = changes.remove === undefined ? [] : changes.remove;
      if (!isArray(install) || !isArray(remove)) return fail('invalid');
      var i;
      var wanted = {};
      for (i = 0; i < install.length; i++) {
        var chk = reg.check(install[i], opts);
        if (!chk.ok) return fail(chk.reason, {app: isObject(install[i]) ? install[i].id : null});
        var id = idOf(install[i].id);
        if (hasKey(wanted, id)) return fail('invalid', {app: install[i].id});
        wanted[id] = install[i];
      }
      var gone = {};
      for (i = 0; i < remove.length; i++) {
        var rid = removalId(remove[i]);
        if (rid === null || hasKey(wanted, rid)) return fail('invalid', {app: remove[i]});
        gone[rid] = true;
      }

      var add = [], update = [], removed = [];
      var keep = [];
      var seen = {};
      var oursCount = 0;
      for (i = 0; i < parsed.items.length; i++) {
        var it = parsed.items[i];
        if (!it.ours) { keep.push({raw: it.raw, entry: it.entry}); continue; }
        var oid = it.entry.Id;
        seen[oid] = true;
        if (hasKey(gone, oid)) { removed.push(oid); continue; }
        oursCount++;
        if (!hasKey(wanted, oid)) { keep.push({raw: it.raw, entry: it.entry}); continue; }
        var fresh = reg.entryFor(wanted[oid]);
        // keep what the TV counted for this app
        if (hasKey(it.entry, 'InstallTime')) fresh.InstallTime = it.entry.InstallTime;
        if (hasKey(it.entry, 'RunTimes')) fresh.RunTimes = it.entry.RunTimes;
        if (sameEntry(it.entry, fresh)) {
          keep.push({raw: it.raw, entry: it.entry});
        } else {
          update.push(fresh);
          keep.push({raw: JSON.stringify(fresh), entry: fresh});
        }
      }
      for (var wid in wanted) {
        if (hasKey(wanted, wid) && !hasKey(seen, wid)) {
          var ne = reg.entryFor(wanted[wid]);
          add.push(ne);
          keep.push({raw: JSON.stringify(ne), entry: ne});
          oursCount++;
        }
      }
      if (oursCount > MAX_OURS) return fail('limit');

      var raws = [], entries = [];
      for (i = 0; i < keep.length; i++) { raws.push(keep[i].raw); entries.push(keep[i].entry); }
      var nextRaw;
      if (!add.length && !update.length && !removed.length) {
        nextRaw = parsed.raw;
      } else if (raws.length === 0) {
        nextRaw = parsed.head.replace(/\s*$/, '') + parsed.tail.replace(/^\s*/, '');
      } else {
        nextRaw = parsed.head + raws.join(parsed.sep) + parsed.tail;
      }
      var next = {};
      for (var key in parsed.list) if (hasKey(parsed.list, key)) next[key] = parsed.list[key];
      next.AppInfo = entries;
      return {ok: true, add: add, update: update, remove: removed, next: next, nextRaw: nextRaw, error: null};
    }

    reg.plan = function (changes, opts) {
      var r = reg.read();
      if (!r.ok) return fail(r.error);
      return buildPlan(r.parsed, changes, opts);
    };

    // ----- backup -----

    function ringLoad() {
      var s = storage.getItem(RING_KEY);
      if (!s) return [];
      var a = JSON.parse(s);
      return isArray(a) ? a : [];
    }

    /** The copies kept in this browser (newest last), for the UI. */
    reg.ring = function () {
      if (!storage) return [];
      try { return ringLoad(); } catch (e) { return []; }
    };

    /** The fixed base copy: the first list this browser ever saw. */
    reg.baseCopy = function () {
      if (!storage) return null;
      try { return storage.getItem(BASE_KEY); } catch (e) { return null; }
    };

    /** Ring of the last RING_MAX lists plus a fixed base copy. True only if raw was really stored. */
    function ringSave(raw) {
      if (!storage) return false;
      try {
        var ring = ringLoad();
        if (!ring.length || ring[ring.length - 1].raw !== raw) ring.push({t: new Date().toISOString(), raw: raw});
        while (ring.length > RING_MAX) ring.shift();
        if (storage.getItem(BASE_KEY) === null) {
          storage.setItem(BASE_KEY, raw);
          if (storage.getItem(BASE_KEY) !== raw) return false;
        }
        for (;;) {
          try {
            storage.setItem(RING_KEY, JSON.stringify(ring));
            break;
          } catch (e) {
            if (ring.length <= 1) return false;
            ring.shift(); // full: drop the oldest copy and try again
          }
        }
        var back = ringLoad();
        return back.length > 0 && back[back.length - 1].raw === raw;
      } catch (e2) {
        return false;
      }
    }

    /** Mode A: ring in the browser. Mode pc: opts.backup is mandatory. cb(code) with a short code or null. */
    function doBackup(raw, opts, cb) {
      var finish = once(cb);
      var external = typeof opts.backup === 'function';
      if (opts.mode === 'pc') {
        if (!external) { finish('backup'); return; }
      } else if (!ringSave(raw) && !external) {
        finish('backup'); // no copy anywhere
        return;
      }
      if (!external) { finish(null); return; }
      var timer = setTimeout(function () { finish('backup'); }, typeof opts.timeout === 'number' ? opts.timeout : BACKUP_TIMEOUT);
      try {
        opts.backup(raw, function (err) {
          clearTimeout(timer);
          finish(err ? 'backup' : null);
        });
      } catch (e) {
        clearTimeout(timer);
        finish('backup');
      }
    }

    // ----- notify -----

    function notify() {
      if (typeof notifyFn !== 'function') return false;
      try { notifyFn(NOTIFY_MSG); return true; } catch (e) { return false; }
    }

    // ----- apply -----

    function ids(entries) {
      var out = [];
      for (var i = 0; i < entries.length; i++) out.push(typeof entries[i] === 'string' ? entries[i] : entries[i].Id);
      return out;
    }

    /** After the write: ours exactly as planned, everything else the same as before the write. */
    function verified(before, after, plan) {
      var i;
      var ob = othersOf(before), oa = othersOf(after);
      if (ob.length !== oa.length) return false;
      for (i = 0; i < ob.length; i++) if (canon(ob[i].entry) !== canon(oa[i].entry)) return false;
      var want = {};
      var wantCount = 0;
      var expected = plan.next.AppInfo;
      for (i = 0; i < expected.length; i++) {
        if (isOurEntry(expected[i])) { want[expected[i].Id] = expected[i]; wantCount++; }
      }
      var have = 0;
      for (i = 0; i < after.items.length; i++) {
        if (!after.items[i].ours) continue;
        var e = after.items[i].entry;
        if (!hasKey(want, e.Id) || !sameEntry(e, want[e.Id])) return false;
        have++;
      }
      return have === wantCount;
    }

    /**
     * Installs and removes our entries. done({ok, step, error, added, removed, verified, notified}).
     * Steps: read, backup, recheck, write, verify, notify. Codes: no-api, unreadable, backup, changed, write,
     * verify, invalid, limit, domain, plus busy (another apply is running) and internal (unexpected exception).
     */
    reg.apply = function (changes, opts, done) {
      opts = opts || {};
      var finishOnce = once(done);
      var step = 'read';
      function end(res) {
        busy = false;
        if (!hasKey(res, 'added')) res.added = [];
        if (!hasKey(res, 'removed')) res.removed = [];
        if (!hasKey(res, 'verified')) res.verified = false;
        finishOnce(res);
      }
      function stop(error, extra) {
        var r = {ok: false, step: step, error: error};
        if (extra) for (var k in extra) if (hasKey(extra, k)) r[k] = extra[k];
        end(r);
      }
      if (busy) { finishOnce({ok: false, step: 'read', error: 'busy', added: [], removed: [], verified: false}); return; }
      busy = true;
      try {
        // 1. read
        var first = reg.read();
        if (!first.ok) { stop(first.error); return; }
        var plan = buildPlan(first.parsed, changes, opts);
        if (!plan.ok) { stop(plan.error, {app: plan.app}); return; }
        if (!plan.add.length && !plan.update.length && !plan.remove.length) {
          end({ok: true, step: 'read', added: [], removed: [], verified: true, notified: false, noop: true});
          return;
        }
        // 2. backup
        step = 'backup';
        doBackup(first.raw, opts, function (err) {
          try {
            if (err) { stop(err); return; }
            // 3. read again: if anything that is not ours changed, stop without writing
            step = 'recheck';
            var second = reg.read();
            if (!second.ok) { stop(second.error); return; }
            if (!sameOthersRaw(first.parsed, second.parsed)) { stop('changed'); return; }
            var plan2 = buildPlan(second.parsed, changes, opts);
            if (!plan2.ok) { stop(plan2.error, {app: plan2.app}); return; }
            // 4. write
            step = 'write';
            var w = call('fileWrite', {path: PATH, mode: MODE, writedata: plan2.nextRaw});
            if (!w || w.ret !== true) {
              var after = reg.read();
              stop('write', {unchanged: after.raw === second.raw});
              return;
            }
            // 5. read again and compare ours (never writes an old copy back)
            step = 'verify';
            var third = reg.read();
            if (!third.ok || !verified(second.parsed, third.parsed, plan2)) { stop('verify', {touched: true}); return; }
            // 6. tell the launcher
            step = 'notify';
            var notified = notify();
            end({ok: true, step: 'notify', added: ids(plan2.add.concat(plan2.update)), removed: ids(plan2.remove), verified: true, notified: notified});
          } catch (e) {
            stop('internal');
          }
        });
      } catch (e) {
        stop('internal');
      }
    };

    // ----- diff and restore -----

    function listOf(raw) {
      var list;
      try { list = JSON.parse(raw); } catch (e) { return null; }
      if (!isObject(list) || !isArray(list.AppInfo)) return null;
      var map = {}, order = [];
      for (var i = 0; i < list.AppInfo.length; i++) {
        var e = list.AppInfo[i];
        var key = entryId(e) !== null ? e.Id : '#' + i;
        map[key] = e;
        order.push(key);
      }
      return {map: map, order: order};
    }

    function label(key, e) {
      return {id: key, name: isObject(e) && typeof e.AppName === 'string' ? e.AppName : key};
    }

    /** What changes going from list A to list B: {added, removed, changed}, each [{id, name}]. */
    reg.diff = function (rawA, rawB) {
      var a = listOf(rawA), b = listOf(rawB);
      var out = {added: [], removed: [], changed: []};
      if (!a || !b) { out.error = 'invalid'; return out; }
      var i, k;
      for (i = 0; i < b.order.length; i++) {
        k = b.order[i];
        if (!hasKey(a.map, k)) out.added.push(label(k, b.map[k]));
        else if (canon(a.map[k]) !== canon(b.map[k])) out.changed.push(label(k, b.map[k]));
      }
      for (i = 0; i < a.order.length; i++) {
        k = a.order[i];
        if (!hasKey(b.map, k)) out.removed.push(label(k, a.map[k]));
      }
      return out;
    };

    /**
     * Writes a whole list from a backup. Only from the PC installer: opts = {mode:'pc', backup, confirmed:true},
     * where confirmed means the person saw reg.diff(current, raw). done({ok, step, error, diff, verified}).
     */
    reg.restore = function (raw, opts, done) {
      opts = opts || {};
      var finishOnce = once(done);
      var step = 'read';
      var diff = null;
      function end(ok, error, extra) {
        busy = false;
        var r = {ok: ok, step: step, error: error || null, diff: diff, verified: ok};
        if (extra) for (var k in extra) if (hasKey(extra, k)) r[k] = extra[k];
        finishOnce(r);
      }
      if (busy) { finishOnce({ok: false, step: 'read', error: 'busy', diff: null, verified: false}); return; }
      busy = true;
      try {
        if (opts.mode !== 'pc' || typeof opts.backup !== 'function') { step = 'backup'; end(false, 'backup'); return; }
        if (opts.confirmed !== true || !parseList(raw)) { end(false, 'invalid'); return; }
        var cur = reg.read();
        if (cur.raw === null) { end(false, cur.error || 'unreadable'); return; }
        diff = reg.diff(cur.raw, raw);
        step = 'backup';
        doBackup(cur.raw, opts, function (err) {
          try {
            if (err) { end(false, err); return; }
            step = 'recheck';
            var again = reg.read();
            if (again.raw !== cur.raw) { end(false, 'changed'); return; }
            step = 'write';
            var w = call('fileWrite', {path: PATH, mode: MODE, writedata: raw});
            if (!w || w.ret !== true) { end(false, 'write'); return; }
            step = 'verify';
            var back = reg.read();
            if (!back.ok || canon(back.list) !== canon(JSON.parse(raw))) { end(false, 'verify', {touched: true}); return; }
            step = 'notify';
            end(true, null, {notified: notify()});
          } catch (e) {
            end(false, 'internal');
          }
        });
      } catch (e) {
        end(false, 'internal');
      }
    };

    return reg;
  }

  return {create: create, PREFIX: PREFIX, LEGACY_ID: LEGACY_ID, PATH: PATH, MODE: MODE};
}));
