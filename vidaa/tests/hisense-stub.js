'use strict';
/*
 * A fake Hisense/VIDAA browser for the tests. Not shipped: node only.
 *
 *   var stub = createStub({profile: 'vidaahub'});
 *   var reg = FMTVRegistry.create(stub.host());
 *
 * Profiles (how the TV answers HiUtils_createRequest):
 *   vidaahub               works like the real one on vidaahub.com: synchronous {ret, msg}
 *   github-sem-api         no HiUtils_createRequest at all (host.request is null)
 *   lanca-erro             every call throws
 *   ret-false              every call answers {ret:false}; with only:'write' just fileWrite does
 *   grava-mas-nao-muda     fileWrite says success but the file stays as it was
 *   grava-truncado         fileWrite says success but keeps only the first half of the text
 *   tv-muda-no-meio        the TV changes another entry on its own: after the Nth fileRead
 *                          (afterReads, default 1) or, with when:'after-write', right after the write
 *   lento                  every call busy-waits `delay` ms (default 20)
 *   getInstalledApps-mudo  works, and Hisense_getInstalledApps never answers (stub.getInstalledApps)
 *   localStorage-cheio     storage.setItem always throws QuotaExceededError
 *
 * Opening an app (openStub): ignorado (nothing happens), abre (document goes hidden and fires
 * visibilitychange), blur-falso (window blur fires but the page stays visible).
 */

var fs = require('fs');
var path = require('path');

var FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').replace(/\r?\n$/, '');
}

function memoryStorage(full) {
  var data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) {
      if (full) {
        var e = new Error('The quota has been exceeded.');
        e.name = 'QuotaExceededError';
        throw e;
      }
      data[k] = String(v);
    },
    removeItem: function (k) { delete data[k]; },
    dump: function () { return data; }
  };
}

function busyWait(ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) { /* the real call blocks too */ }
}

function createStub(options) {
  options = options || {};
  var profile = options.profile || 'vidaahub';
  var stub = {
    profile: profile,
    file: options.initial !== undefined ? options.initial : fixture('lista-original.json'),
    calls: [],
    reads: 0,
    writes: 0,
    notified: [],
    storage: memoryStorage(profile === 'localStorage-cheio'),
    getInstalledApps: null
  };

  if (profile === 'getInstalledApps-mudo') {
    // answers neither by return value nor by callback, like the real one on some firmware
    stub.getInstalledApps = function () { return undefined; };
  }

  /** The TV edits an entry that is not ours (a firmware update, another installer). */
  stub.touchOthers = function () {
    stub.file = stub.file.replace('"InstallTime":"2025-8-10"', '"InstallTime":"2025-8-11"');
    if (stub.file.indexOf('"2025-8-11"') < 0) stub.file = stub.file.replace('"InstallTime": "2025-8-10"', '"InstallTime": "2025-8-11"');
  };

  stub.request = function (op, params) {
    stub.calls.push({op: op, params: params});
    if (op === 'fileWrite') stub.writes++;
    if (profile === 'lento') busyWait(typeof options.delay === 'number' ? options.delay : 20);
    if (profile === 'lanca-erro') throw new Error('HiUtils exploded');
    if (profile === 'ret-false' && (options.only !== 'write' || op === 'fileWrite')) return {ret: false, msg: 'error'};

    if (!params || params.path !== 'websdk/Appinfo.json' || params.mode !== 6) return {ret: false, msg: 'bad path'};

    if (op === 'fileRead') {
      stub.reads++;
      var out = {ret: true, msg: stub.file};
      if (profile === 'tv-muda-no-meio' && options.when !== 'after-write' && stub.reads === (options.afterReads || 1)) stub.touchOthers();
      return out;
    }
    if (op === 'fileWrite') {
      if (typeof params.writedata !== 'string') return {ret: false, msg: 'writedata'};
      if (profile === 'grava-mas-nao-muda') return {ret: true, msg: 'success'};
      if (profile === 'grava-truncado') {
        stub.file = params.writedata.slice(0, Math.floor(params.writedata.length / 2));
        return {ret: true, msg: 'success'};
      }
      stub.file = params.writedata;
      if (profile === 'tv-muda-no-meio' && options.when === 'after-write') stub.touchOthers();
      return {ret: true, msg: 'success'};
    }
    return {ret: false, msg: 'unknown op'};
  };

  stub.notify = function (msg) { stub.notified.push(msg); };
  stub.today = function () { return options.today || '2026-10-26'; };

  stub.host = function () {
    return {
      request: profile === 'github-sem-api' ? null : stub.request,
      storage: stub.storage,
      notify: stub.notify,
      today: stub.today
    };
  };

  stub.ops = function () {
    var out = [];
    for (var i = 0; i < stub.calls.length; i++) out.push(stub.calls[i].op);
    return out;
  };

  return stub;
}

/** A page plus the launcher call: mode 'ignorado' | 'abre' | 'blur-falso'. */
function openStub(mode) {
  var listeners = {};
  function emitter(target) {
    target.addEventListener = function (type, fn) { (listeners[target.name + ':' + type] = listeners[target.name + ':' + type] || []).push(fn); };
    target.removeEventListener = function (type, fn) {
      var l = listeners[target.name + ':' + type] || [];
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };
    target.dispatch = function (type) {
      var l = (listeners[target.name + ':' + type] || []).slice();
      for (var i = 0; i < l.length; i++) l[i]({type: type});
    };
    return target;
  }
  var win = emitter({name: 'window'});
  var doc = emitter({name: 'document', hidden: false, visibilityState: 'visible'});
  var env = {window: win, document: doc, launched: []};
  env.launch = function (name) {
    env.launched.push(name);
    if (mode === 'abre') {
      setTimeout(function () {
        doc.hidden = true;
        doc.visibilityState = 'hidden';
        doc.dispatch('visibilitychange');
      }, 0);
    } else if (mode === 'blur-falso') {
      setTimeout(function () { win.dispatch('blur'); }, 0);
    }
    return undefined; // the real launch functions return nothing useful
  };
  return env;
}

module.exports = {createStub: createStub, openStub: openStub, fixture: fixture, memoryStorage: memoryStorage};
