'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var Registry = require('../store/registry.js');
var stubs = require('./hisense-stub.js');

var HOST = 'tanaualopes93.github.io';
function app(id, extra) {
  var a = {id: id, name: 'App ' + id, url: 'https://' + HOST + '/' + id + '/', icon: 'https://' + HOST + '/icons/' + id + '.png'};
  for (var k in (extra || {})) a[k] = extra[k];
  return a;
}

function make(profile, options) {
  options = options || {};
  options.profile = profile;
  var stub = stubs.createStub(options);
  return {stub: stub, reg: Registry.create(stub.host())};
}

function apply(reg, changes, opts) {
  return new Promise(function (resolve) { reg.apply(changes, opts, resolve); });
}

function restore(reg, raw, opts) {
  return new Promise(function (resolve) { reg.restore(raw, opts, resolve); });
}

/** backup callback that records what it got */
function recorder(seen, err) {
  return function (raw, cb) { seen.push(raw); setTimeout(function () { cb(err || null); }, 1); };
}

function rawEntries(raw) {
  // the exact text of each element of AppInfo, by the same rule the registry uses
  var list = JSON.parse(raw).AppInfo;
  return list.map(function (e) { return JSON.stringify(e); });
}

// ---------- probe / read ----------

test('probe: vidaahub reads the list and counts it', function () {
  var m = make('vidaahub');
  assert.deepEqual(m.reg.probe(), {available: true, readable: true, count: 3, error: null});
});

test('probe: without the API (github-sem-api) says no-api and does not throw', function () {
  var m = make('github-sem-api');
  assert.deepEqual(m.reg.probe(), {available: false, readable: false, count: 0, error: 'no-api'});
});

test('probe: a call that throws is unreadable, not a crash', function () {
  var p = make('lanca-erro').reg.probe();
  assert.equal(p.available, true);
  assert.equal(p.readable, false);
  assert.equal(p.error, 'unreadable');
});

test('probe: ret:false is unreadable', function () {
  assert.equal(make('ret-false').reg.probe().error, 'unreadable');
});

test('read: text that is not a list is unreadable (truncated, wrong shape, empty)', function () {
  ['{"AppInfo":[{"Id":"1"', '[]', '{"AppInfo":{}}', '{"Other":1}'].forEach(function (bad) {
    var m = make('vidaahub', {initial: bad});
    assert.equal(m.reg.read().ok, false, bad);
    assert.equal(m.reg.read().error, 'unreadable', bad);
  });
  assert.equal(make('vidaahub', {initial: ''}).reg.read().error, 'unreadable');
});

test('read: separates ours (fmtv_ and the legacy FreeMyTV) from the others', function () {
  var m = make('vidaahub', {initial: stubs.fixture('lista-espacada.json')});
  var r = m.reg.read();
  assert.equal(r.ok, true);
  assert.deepEqual(r.ours.map(function (e) { return e.Id; }), ['FreeMyTV', 'fmtv_antigo']);
  assert.equal(r.list.AppInfo.length, 4);
});

test('read: an Id that only contains our prefix in the middle is not ours', function () {
  var raw = '{"AppInfo":[{"Id":"xfmtv_a"},{"Id":"FreeMyTV2"},{"Id":"fmtv_ok"}]}';
  var r = make('vidaahub', {initial: raw}).reg.read();
  assert.deepEqual(r.ours.map(function (e) { return e.Id; }), ['fmtv_ok']);
});

// ---------- entryFor ----------

test('entryFor: has every field of the contract and a prefixed Id', function () {
  var m = make('vidaahub');
  var e = m.reg.entryFor(app('netflix'));
  assert.deepEqual(e, {
    Id: 'fmtv_netflix', AppName: 'App netflix', Title: 'App netflix',
    URL: 'https://' + HOST + '/netflix/', StartCommand: 'https://' + HOST + '/netflix/',
    IconURL: 'https://' + HOST + '/icons/netflix.png', Icon_96: 'https://' + HOST + '/icons/netflix.png',
    Image: 'https://' + HOST + '/icons/netflix.png', Thumb: 'https://' + HOST + '/icons/netflix.png',
    Type: 'Browser', InstallTime: '2026-10-26', RunTimes: 0, StoreType: 'custom', PreInstall: false
  });
});

test('entryFor: the legacy FreeMyTV keeps its Id, with no prefix', function () {
  assert.equal(make('vidaahub').reg.entryFor(app('FreeMyTV')).Id, 'FreeMyTV');
});

test('entryFor: InstallTime is the LOCAL date as YYYY-M-D (no zero padding)', function () {
  var reg = Registry.create({request: null, storage: null, notify: null});
  var d = new Date();
  assert.equal(reg.entryFor(app('x')).InstallTime, d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate());
  var custom = Registry.create({request: null, today: function () { return '2026-1-5'; }});
  assert.equal(custom.entryFor(app('x')).InstallTime, '2026-1-5');
  var bad = Registry.create({request: null, today: function () { return 'ontem'; }});
  assert.match(bad.entryFor(app('x')).InstallTime, /^\d{4}-\d{1,2}-\d{1,2}$/);
});

// ---------- check ----------

test('check: https on an approved host passes', function () {
  assert.deepEqual(make('vidaahub').reg.check(app('a')), {ok: true});
});

test('check: a host outside ALLOWED is refused with domain', function () {
  var r = make('vidaahub').reg.check(app('a', {url: 'https://exemplo.com/'}));
  assert.deepEqual(r, {ok: false, reason: 'domain'});
});

test('check: tricks with the address do not pass (userinfo, lookalike, subdomain, port, case)', function () {
  var reg = make('vidaahub').reg;
  [
    'https://' + HOST + '@evil.com/',
    'https://' + HOST + '.evil.com/',
    'https://evil.com/' + HOST,
    'https://sub.' + HOST + '/',
    'https://' + HOST + ':8443/',
    'https://evil.com#@' + HOST,
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://' + HOST + '\\@evil.com/',
    'https://' + HOST + '/ x',
    'ftp://' + HOST + '/'
  ].forEach(function (u) {
    assert.equal(reg.check(app('a', {url: u})).ok, false, u);
  });
  assert.equal(reg.check(app('a', {url: 'https://' + HOST.toUpperCase() + '/x'})).ok, true);
  assert.equal(reg.check(app('a', {url: 'https://' + HOST + ':443/x'})).ok, true);
});

test('check: http is refused unless the host is in ALLOWED_HTTP', function () {
  var reg = make('vidaahub').reg;
  var u = 'http://player.example.org/';
  assert.deepEqual(reg.check(app('a', {url: u})), {ok: false, reason: 'domain'});
  assert.deepEqual(reg.check(app('a', {url: 'http://' + HOST + '/'})), {ok: false, reason: 'domain'}); // https list does not cover http
  reg.ALLOWED_HTTP.push('player.example.org');
  assert.deepEqual(reg.check(app('a', {url: u})), {ok: true});
});

test('check: private IP only with homeNetwork, and only real private ranges', function () {
  var reg = make('vidaahub').reg;
  var priv = ['http://10.0.0.5:8080/', 'http://172.16.3.4/', 'http://172.31.255.1/', 'http://192.168.1.20/x', 'https://192.168.0.7/'];
  priv.forEach(function (u) {
    assert.equal(reg.check(app('a', {url: u})).ok, false, 'sem homeNetwork ' + u);
    assert.equal(reg.check(app('a', {url: u}), {homeNetwork: true}).ok, true, 'com homeNetwork ' + u);
  });
  ['http://8.8.8.8/', 'http://172.32.0.1/', 'http://172.15.0.1/', 'http://192.169.1.1/', 'http://10.0.0.256/', 'http://010.0.0.1/',
    'http://127.0.0.1/', 'http://10.0.0/', 'http://10.0.0.1.evil.com/'].forEach(function (u) {
    assert.equal(reg.check(app('a', {url: u}), {homeNetwork: true}).ok, false, u);
  });
});

test('check: invalid app data is refused with invalid', function () {
  var reg = make('vidaahub').reg;
  [null, 'x', {}, app('', {}), app('a b'), app('a_b'), app('../x'), app('a', {name: ''}), app('a', {name: '   '}),
    app('a', {name: new Array(70).join('x')}), app('a', {name: 'x\ny'}), app('a', {url: 'not a url'}), app('a', {url: 42}),
    app('a', {icon: 'http://' + HOST + '/i.png'}), app('a', {icon: 'javascript:1'}), app('a', {icon: 42})
  ].forEach(function (a) {
    var r = reg.check(a);
    assert.equal(r.ok, false, JSON.stringify(a));
    assert.equal(r.reason, 'invalid', JSON.stringify(a));
  });
  assert.equal(reg.check(app('a', {icon: ''})).ok, true);
  assert.equal(reg.check(app('a', {icon: 'data:image/png;base64,AAAA'})).ok, true);
});

test('each registry has its own copy of the lists (a change in one does not leak)', function () {
  var a = make('vidaahub').reg, b = make('vidaahub').reg;
  a.ALLOWED.push('outro.example');
  assert.equal(b.ALLOWED.indexOf('outro.example'), -1);
  assert.equal(Registry.create({request: null}).ALLOWED.indexOf('outro.example'), -1);
});

// ---------- plan ----------

test('plan: add, update and remove are told apart and nothing is written (dry)', async function () {
  var m = make('vidaahub', {initial: stubs.fixture('lista-espacada.json')});
  var p = m.reg.plan({install: [app('novo'), app('antigo', {name: 'Antigo 2'})], remove: ['FreeMyTV']});
  assert.equal(p.ok, true);
  assert.deepEqual(p.add.map(function (e) { return e.Id; }), ['fmtv_novo']);
  assert.deepEqual(p.update.map(function (e) { return e.Id; }), ['fmtv_antigo']);
  assert.deepEqual(p.remove, ['FreeMyTV']);
  assert.equal(m.stub.writes, 0);
  assert.equal(m.stub.ops().indexOf('fileWrite'), -1);
  assert.equal(p.next.Version, 2); // other top-level keys travel along
  assert.deepEqual(p.next.AppInfo.map(function (e) { return e.Id; }), ['338', 'fmtv_antigo', '16', 'fmtv_novo']);
});

test('plan: installing the same unchanged app again is not an update (upsert by Id)', function () {
  var m = make('vidaahub', {initial: stubs.fixture('lista-espacada.json')});
  var same = {id: 'antigo', name: 'Antigo', url: 'https://tanaualopes93.github.io/antigo/', icon: ''};
  var p = m.reg.plan({install: [same]});
  assert.deepEqual([p.add.length, p.update.length, p.remove.length], [0, 0, 0]);
  assert.equal(p.nextRaw, stubs.fixture('lista-espacada.json'));
});

test('plan: an update keeps the install date and the run counter the TV already had', function () {
  var m = make('vidaahub', {initial: stubs.fixture('lista-espacada.json')});
  var u = m.reg.plan({install: [app('antigo', {name: 'Novo nome'})]}).update[0];
  assert.equal(u.InstallTime, '2026-10-1');
  assert.equal(u.RunTimes, 2);
  assert.equal(u.AppName, 'Novo nome');
});

test('plan: entries that are not ours come out as the exact text that was read', function () {
  var original = stubs.fixture('lista-original.json');
  var m = make('vidaahub', {initial: original});
  var p = m.reg.plan({install: [app('novo')]});
  // everything up to the closing of the third entry is untouched, including the space at the end of StartCommand
  var untouched = original.slice(0, original.length - 2); // before "]}"
  assert.equal(p.nextRaw.indexOf(untouched), 0);
  assert.ok(p.nextRaw.indexOf('/index.html "') > 0);
  assert.ok(p.nextRaw.indexOf('\\u00e9') > 0, 'escapes are not rewritten');
  assert.equal(p.nextRaw, untouched + ',' + JSON.stringify(p.add[0]) + ']}');
});

test('plan: pretty-printed lists keep their layout and their other keys', function () {
  var original = stubs.fixture('lista-espacada.json');
  var m = make('vidaahub', {initial: original});
  var p = m.reg.plan({remove: ['antigo']});
  assert.equal(p.ok, true);
  assert.deepEqual(p.remove, ['fmtv_antigo']);
  assert.equal(p.nextRaw.indexOf('"Version" : 2'), original.indexOf('"Version" : 2'));
  assert.ok(p.nextRaw.indexOf('"Extra" : [1, 2, 3]') > 0);
  assert.ok(p.nextRaw.indexOf('{ "Id": "338",  "AppName"') > 0, 'odd spacing inside an entry stays');
  assert.equal(JSON.parse(p.nextRaw).AppInfo.length, 3);
});

test('plan: removing something that is not there is a no-op, and never touches the others', function () {
  var m = make('vidaahub', {initial: stubs.fixture('lista-espacada.json')});
  var p = m.reg.plan({remove: ['inexistente']});
  assert.equal(p.ok, true);
  assert.deepEqual(p.remove, []);
  assert.equal(p.nextRaw, stubs.fixture('lista-espacada.json'));
});

test('plan: a remove can never reach an entry that is not ours (338, 16 become fmtv_338, fmtv_16)', function () {
  var m = make('vidaahub');
  var p = m.reg.plan({remove: ['338', '16']});
  assert.deepEqual(p.remove, []);
  assert.equal(p.nextRaw, stubs.fixture('lista-original.json'));
  assert.equal(m.reg.plan({remove: ['../x']}).error, 'invalid');
  assert.equal(m.reg.plan({remove: [42]}).error, 'invalid');
});

test('plan: removing every one of ours leaves a valid list', function () {
  var m = make('vidaahub', {initial: '{"AppInfo":[{"Id":"fmtv_a"}]}'});
  var p = m.reg.plan({remove: ['a']});
  assert.deepEqual(JSON.parse(p.nextRaw), {AppInfo: []});
});

test('plan: more than 30 of ours is refused with limit; 30 is fine', function () {
  var many = [];
  for (var i = 0; i < 31; i++) many.push(app('a' + i));
  var m = make('vidaahub');
  assert.equal(m.reg.plan({install: many}).error, 'limit');
  assert.equal(m.reg.plan({install: many.slice(0, 30)}).ok, true);
  // the ones already installed count too
  var raw = '{"AppInfo":[' + many.slice(0, 30).map(function (a) { return JSON.stringify(m.reg.entryFor(a)); }).join(',') + ']}';
  var full = make('vidaahub', {initial: raw});
  assert.equal(full.reg.plan({install: [app('extra')]}).error, 'limit');
  assert.equal(full.reg.plan({install: [app('extra')], remove: ['a0']}).ok, true);
});

test('plan: a domain outside the list is refused with domain, before anything else', function () {
  var m = make('vidaahub');
  var p = m.reg.plan({install: [app('ok'), app('mau', {url: 'https://evil.example/'})]});
  assert.equal(p.ok, false);
  assert.equal(p.error, 'domain');
  assert.equal(p.app, 'mau');
});

test('plan: repeated ids in one batch, and install plus remove of the same id, are invalid', function () {
  var m = make('vidaahub');
  assert.equal(m.reg.plan({install: [app('a'), app('a')]}).error, 'invalid');
  assert.equal(m.reg.plan({install: [app('a')], remove: ['a']}).error, 'invalid');
  assert.equal(m.reg.plan(null).error, 'invalid');
  assert.equal(m.reg.plan({install: 'a'}).error, 'invalid');
});

test('plan: without a readable list it fails with the read error', function () {
  assert.equal(make('github-sem-api').reg.plan({install: [app('a')]}).error, 'no-api');
  assert.equal(make('ret-false').reg.plan({install: [app('a')]}).error, 'unreadable');
});

// ---------- apply: the six steps ----------

test('apply: the six steps happen in order and the list is changed only where it should', async function () {
  var seen = [];
  var m = make('vidaahub');
  var original = m.stub.file;
  var res = await apply(m.reg, {install: [app('netflix')]}, {mode: 'pc', backup: recorder(seen)});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verified, true);
  assert.deepEqual(res.added, ['fmtv_netflix']);
  assert.deepEqual(res.removed, []);
  assert.equal(res.notified, true);
  assert.deepEqual(m.stub.ops(), ['fileRead', 'fileRead', 'fileWrite', 'fileRead']);
  assert.deepEqual(seen, [original], 'the backup is the exact text read in step 1');
  assert.deepEqual(m.stub.notified, [{type: 'AllAppsUpdate'}]);
  // the others are byte for byte what they were
  var before = original.slice(0, original.length - 2);
  assert.equal(m.stub.file.indexOf(before), 0);
  assert.equal(JSON.parse(m.stub.file).AppInfo.length, 4);
  var wr = m.stub.calls.filter(function (c) { return c.op === 'fileWrite'; })[0];
  assert.deepEqual([wr.params.path, wr.params.mode], ['websdk/Appinfo.json', 6]);
});

test('apply: the backup is finished before the write (a slow backup is waited for)', async function () {
  var m = make('vidaahub');
  var order = [];
  var origRequest = m.stub.request;
  var host = m.stub.host();
  host.request = function (op, p) { order.push(op); return origRequest(op, p); };
  var reg = Registry.create(host);
  var res = await apply(reg, {install: [app('a')]}, {
    mode: 'pc',
    backup: function (raw, cb) { order.push('backup-start'); setTimeout(function () { order.push('backup-end'); cb(null); }, 40); }
  });
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['fileRead', 'backup-start', 'backup-end', 'fileRead', 'fileWrite', 'fileRead']);
});

test('apply: a backup that fails stops everything and nothing is written', async function () {
  var m = make('vidaahub');
  var before = m.stub.file;
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([], 'disk full')});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'backup');
  assert.equal(res.step, 'backup');
  assert.equal(m.stub.writes, 0);
  assert.equal(m.stub.file, before);
  assert.equal(m.stub.notified.length, 0);
});

test('apply: a backup that throws, or never answers, also stops with backup', async function () {
  var m = make('vidaahub');
  var r1 = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: function () { throw new Error('x'); }});
  assert.equal(r1.error, 'backup');
  var r2 = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', timeout: 30, backup: function () { /* never calls back */ }});
  assert.equal(r2.error, 'backup');
  assert.equal(m.stub.writes, 0);
});

test('apply: a backup that answers twice (ok, then error) does not run the write twice', async function () {
  var m = make('vidaahub');
  var calls = 0;
  var res = await new Promise(function (resolve) {
    m.reg.apply({install: [app('a')]}, {mode: 'pc', backup: function (raw, cb) { cb(null); cb('late error'); }}, function (r) { calls++; resolve(r); });
  });
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.equal(res.ok, true);
  assert.equal(calls, 1);
  assert.equal(m.stub.writes, 1);
});

test('apply: mode pc without a backup function refuses (nothing written)', async function () {
  var m = make('vidaahub');
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc'});
  assert.equal(res.error, 'backup');
  assert.equal(m.stub.writes, 0);
});

test('apply: mode A keeps the copy in the browser (ring and fixed base) before it writes', async function () {
  var m = make('vidaahub');
  var original = m.stub.file;
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'A'});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(m.reg.baseCopy(), original);
  assert.equal(m.reg.ring().length, 1);
  assert.equal(m.reg.ring()[0].raw, original);
});

test('apply: the base copy is fixed and the ring keeps only the last 5', async function () {
  var m = make('vidaahub');
  var original = m.stub.file;
  for (var i = 0; i < 8; i++) {
    var r = await apply(m.reg, {install: [app('a' + i)]}, {mode: 'A'});
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal(m.reg.baseCopy(), original, 'base never changes');
  var ring = m.reg.ring();
  assert.equal(ring.length, 5);
  assert.equal(JSON.parse(ring[4].raw).AppInfo.length, 3 + 7, 'newest copy is the list right before the 8th change');
});

test('apply: mode A with a full browser storage and no other backup does not write', async function () {
  var m = make('localStorage-cheio');
  var before = m.stub.file;
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'A'});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'backup');
  assert.equal(m.stub.writes, 0);
  assert.equal(m.stub.file, before);
});

test('apply: a full storage is fine when the PC backup is confirmed', async function () {
  var m = make('localStorage-cheio');
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'A', backup: recorder([])});
  assert.equal(res.ok, true);
  assert.equal(m.stub.writes, 1);
});

test('apply: mode A without any storage object does not write', async function () {
  var m = make('vidaahub');
  var host = m.stub.host();
  host.storage = null;
  var res = await apply(Registry.create(host), {install: [app('a')]}, {mode: 'A'});
  assert.equal(res.error, 'backup');
  assert.equal(m.stub.writes, 0);
});

test('apply: storage that drops writes silently is caught by reading the copy back', async function () {
  var m = make('vidaahub');
  var host = m.stub.host();
  host.storage = {getItem: function () { return null; }, setItem: function () { /* lost */ }};
  var res = await apply(Registry.create(host), {install: [app('a')]}, {mode: 'A'});
  assert.equal(res.error, 'backup');
  assert.equal(m.stub.writes, 0);
});

test('apply: no readable list means no backup, no write', async function () {
  var seen = [];
  var m = make('ret-false');
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder(seen)});
  assert.equal(res.error, 'unreadable');
  assert.equal(res.step, 'read');
  assert.equal(seen.length, 0);
  assert.equal(m.stub.writes, 0);
  var g = await apply(make('github-sem-api').reg, {install: [app('a')]}, {mode: 'A'});
  assert.equal(g.error, 'no-api');
  var t = await apply(make('lanca-erro').reg, {install: [app('a')]}, {mode: 'A'});
  assert.equal(t.error, 'unreadable');
});

test('apply: a refused domain or limit stops before the backup', async function () {
  var seen = [];
  var m = make('vidaahub');
  var res = await apply(m.reg, {install: [app('mau', {url: 'https://evil.example/'})]}, {mode: 'pc', backup: recorder(seen)});
  assert.equal(res.error, 'domain');
  assert.equal(seen.length, 0);
  assert.equal(m.stub.writes, 0);
});

test('apply: if another entry changed while the backup ran, it stops with changed and writes nothing', async function () {
  var m = make('tv-muda-no-meio');
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'changed');
  assert.equal(res.step, 'recheck');
  assert.equal(m.stub.writes, 0);
  assert.ok(m.stub.file.indexOf('2025-8-11') > 0, 'the TV change is still there: nothing old was written back');
});

test('apply: a change to ours alone during the backup is not a conflict (it is planned again on the new list)', async function () {
  var m = make('vidaahub');
  var res = await apply(m.reg, {install: [app('novo')]}, {
    mode: 'pc',
    backup: function (raw, cb) {
      // another installer adds one of OUR entries meanwhile; the others stay as they were
      m.stub.file = m.stub.file.replace(/\]\}$/, ',{"Id":"fmtv_outro","AppName":"Outro"}]}');
      cb(null);
    }
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  var ids = JSON.parse(m.stub.file).AppInfo.map(function (e) { return e.Id; });
  assert.deepEqual(ids, ['338', '351', '16', 'fmtv_outro', 'fmtv_novo']);
});

test('apply: write refused by the TV (ret:false) is reported as write, and says the list is unchanged', async function () {
  var m = make('ret-false', {only: 'write'});
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.error, 'write');
  assert.equal(res.step, 'write');
  assert.equal(res.unchanged, true);
  assert.equal(m.stub.writes, 1, 'it is not retried');
  assert.equal(m.stub.notified.length, 0);
});

test('apply: a write that says success but changes nothing is a verify error, with no second write', async function () {
  var m = make('grava-mas-nao-muda');
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'verify');
  assert.equal(res.step, 'verify');
  assert.equal(m.stub.writes, 1, 'never writes an old copy back');
  assert.equal(m.stub.notified.length, 0, 'no notification when it did not verify');
});

test('apply: a truncated write is a verify error and the old copy is not written back', async function () {
  var m = make('grava-truncado');
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.error, 'verify');
  assert.equal(res.touched, true);
  assert.equal(m.stub.writes, 1);
});

test('apply: if another entry changes during the write, verify catches it', async function () {
  var m = make('tv-muda-no-meio', {when: 'after-write'});
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.error, 'verify');
  assert.equal(m.stub.writes, 1);
});

test('apply: a TV that throws on write ends in write, not a crash', async function () {
  var m = make('vidaahub');
  var host = m.stub.host();
  var base = host.request;
  host.request = function (op, p) { if (op === 'fileWrite') throw new Error('boom'); return base(op, p); };
  var res = await apply(Registry.create(host), {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.error, 'write');
});

test('apply: a slow TV still works (lento) and reads/writes are not repeated', async function () {
  var m = make('lento', {delay: 15});
  var t0 = Date.now();
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.ok, true);
  assert.ok(Date.now() - t0 >= 15 * 4);
  assert.equal(m.stub.writes, 1);
  assert.equal(m.stub.reads, 3);
});

test('apply: nothing to change does not backup, write or notify', async function () {
  var seen = [];
  var m = make('vidaahub');
  var res = await apply(m.reg, {install: [], remove: ['nada']}, {mode: 'pc', backup: recorder(seen)});
  assert.equal(res.ok, true);
  assert.equal(res.noop, true);
  assert.equal(seen.length, 0);
  assert.equal(m.stub.writes, 0);
  assert.equal(m.stub.notified.length, 0);
});

test('apply: remove only takes ours out; the legacy FreeMyTV can be removed, 338 and 16 stay', async function () {
  var m = make('vidaahub', {initial: stubs.fixture('lista-espacada.json')});
  var res = await apply(m.reg, {remove: ['FreeMyTV', 'antigo', '338', '16']}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.removed.sort(), ['FreeMyTV', 'fmtv_antigo']);
  assert.deepEqual(JSON.parse(m.stub.file).AppInfo.map(function (e) { return e.Id; }), ['338', '16']);
  assert.ok(m.stub.file.indexOf('"StartCommand": "https://tv.globoplay.com.br/r/index.html "') > 0, 'trailing space intact');
});

test('apply: a notify that throws does not undo a good write', async function () {
  var m = make('vidaahub');
  var host = m.stub.host();
  host.notify = function () { throw new Error('no bridge'); };
  var res = await apply(Registry.create(host), {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.ok, true);
  assert.equal(res.notified, false);
});

test('apply: a second apply while one is running is refused with busy; done is called once each', async function () {
  var m = make('vidaahub');
  var first = apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: function (raw, cb) { setTimeout(function () { cb(null); }, 30); }});
  var second = await apply(m.reg, {install: [app('b')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(second.error, 'busy');
  assert.equal((await first).ok, true);
  var third = await apply(m.reg, {install: [app('b')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(third.ok, true, 'free again afterwards');
});

test('apply: installing the same app twice leaves one entry (upsert)', async function () {
  var m = make('vidaahub');
  await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  var again = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(again.noop, true);
  assert.equal(JSON.parse(m.stub.file).AppInfo.filter(function (e) { return e.Id === 'fmtv_a'; }).length, 1);
});

test('apply: works when the registry does not need getInstalledApps (getInstalledApps-mudo)', async function () {
  var m = make('getInstalledApps-mudo');
  var answered = false;
  assert.equal(m.stub.getInstalledApps(function () { answered = true; }), undefined);
  assert.equal(answered, false);
  var res = await apply(m.reg, {install: [app('a')]}, {mode: 'pc', backup: recorder([])});
  assert.equal(res.ok, true);
});

// ---------- diff and restore ----------

test('diff: lists added, removed and changed by Id', function () {
  var reg = make('vidaahub').reg;
  var a = '{"AppInfo":[{"Id":"1","AppName":"Um"},{"Id":"2","AppName":"Dois"},{"Id":"3","AppName":"Tres"}]}';
  var b = '{"AppInfo":[{"Id":"2","AppName":"Dois"},{"Id":"3","AppName":"Tres B"},{"Id":"4","AppName":"Quatro"}]}';
  var d = reg.diff(a, b);
  assert.deepEqual(d.added, [{id: '4', name: 'Quatro'}]);
  assert.deepEqual(d.removed, [{id: '1', name: 'Um'}]);
  assert.deepEqual(d.changed, [{id: '3', name: 'Tres B'}]);
  assert.deepEqual(reg.diff(a, a), {added: [], removed: [], changed: []});
  assert.equal(reg.diff(a, 'lixo').error, 'invalid');
});

test('diff: key order inside an entry is not a difference', function () {
  var reg = make('vidaahub').reg;
  var d = reg.diff('{"AppInfo":[{"Id":"1","A":1,"B":2}]}', '{"AppInfo":[{"B":2,"Id":"1","A":1}]}');
  assert.deepEqual(d.changed, []);
});

test('restore: writes the whole backup, after backing up the current list, only from the PC', async function () {
  var m = make('vidaahub');
  var backup = m.stub.file;
  await apply(m.reg, {install: [app('a'), app('b')]}, {mode: 'pc', backup: recorder([])});
  var current = m.stub.file;
  assert.notEqual(current, backup);
  var seen = [];
  var res = await restore(m.reg, backup, {mode: 'pc', backup: recorder(seen), confirmed: true});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.verified, true);
  assert.deepEqual(seen, [current], 'the list that is about to be replaced is saved first');
  assert.equal(m.stub.file, backup, 'byte for byte');
  assert.deepEqual(res.diff.removed.map(function (e) { return e.id; }), ['fmtv_a', 'fmtv_b']);
});

test('restore: refuses without mode pc, without a backup function, or without the confirmation of the diff', async function () {
  var m = make('vidaahub');
  var raw = stubs.fixture('lista-espacada.json');
  var before = m.stub.file;
  assert.equal((await restore(m.reg, raw, {mode: 'A', backup: recorder([]), confirmed: true})).error, 'backup');
  assert.equal((await restore(m.reg, raw, {mode: 'pc', confirmed: true})).error, 'backup');
  assert.equal((await restore(m.reg, raw, {mode: 'pc', backup: recorder([])})).error, 'invalid');
  assert.equal((await restore(m.reg, raw, {mode: 'pc', backup: recorder([]), confirmed: 'yes'})).error, 'invalid');
  assert.equal(m.stub.writes, 0);
  assert.equal(m.stub.file, before);
});

test('restore: a copy that is not a list is refused (invalid) and nothing is written', async function () {
  var m = make('vidaahub');
  var res = await restore(m.reg, '{"AppInfo":[{"Id":', {mode: 'pc', backup: recorder([]), confirmed: true});
  assert.equal(res.error, 'invalid');
  assert.equal(m.stub.writes, 0);
});

test('restore: a failed backup of the current list stops before the write', async function () {
  var m = make('vidaahub');
  var res = await restore(m.reg, stubs.fixture('lista-espacada.json'), {mode: 'pc', backup: recorder([], 'x'), confirmed: true});
  assert.equal(res.error, 'backup');
  assert.equal(m.stub.writes, 0);
});

test('restore: it can repair a list that the TV has left broken (unreadable but present)', async function () {
  var good = stubs.fixture('lista-original.json');
  var m = make('vidaahub', {initial: good.slice(0, 100)});
  var seen = [];
  var res = await restore(m.reg, good, {mode: 'pc', backup: recorder(seen), confirmed: true});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(seen[0].length, 100, 'even the broken text is saved first');
  assert.equal(m.stub.file, good);
});

test('restore: a write that does not stick is a verify error', async function () {
  var m = make('grava-mas-nao-muda');
  var res = await restore(m.reg, stubs.fixture('lista-espacada.json'), {mode: 'pc', backup: recorder([]), confirmed: true});
  assert.equal(res.error, 'verify');
  assert.equal(m.stub.writes, 1);
});

test('restore: stops with changed if the list moved while the backup ran', async function () {
  var m = make('vidaahub');
  var res = await restore(m.reg, stubs.fixture('lista-espacada.json'), {
    mode: 'pc', confirmed: true,
    backup: function (raw, cb) { m.stub.touchOthers(); cb(null); }
  });
  assert.equal(res.error, 'changed');
  assert.equal(m.stub.writes, 0);
});

// ---------- the stub itself (so the tests above can be trusted) ----------

test('stub: vidaahub answers like the real TV (sync {ret,msg}, success on write)', function () {
  var s = stubs.createStub({});
  var r = s.request('fileRead', {path: 'websdk/Appinfo.json', mode: 6});
  assert.equal(r.ret, true);
  assert.equal(typeof r.msg, 'string');
  assert.deepEqual(s.request('fileWrite', {path: 'websdk/Appinfo.json', mode: 6, writedata: '{"AppInfo":[]}'}), {ret: true, msg: 'success'});
  assert.equal(s.request('fileRead', {path: 'outro', mode: 6}).ret, false);
});

test('stub: openStub modes behave as named', async function () {
  function wait() { return new Promise(function (r) { setTimeout(r, 15); }); }
  var ign = stubs.openStub('ignorado'), events = [];
  ign.document.addEventListener('visibilitychange', function () { events.push('vis'); });
  ign.window.addEventListener('blur', function () { events.push('blur'); });
  ign.launch('Netflix');
  await wait();
  assert.deepEqual(events, []);
  assert.equal(ign.document.hidden, false);

  var open = stubs.openStub('abre'), ev2 = [];
  open.document.addEventListener('visibilitychange', function () { ev2.push(open.document.hidden); });
  assert.equal(open.launch('Netflix'), undefined);
  await wait();
  assert.deepEqual(ev2, [true]);

  var fake = stubs.openStub('blur-falso'), ev3 = [];
  fake.window.addEventListener('blur', function () { ev3.push('blur'); });
  fake.launch('Netflix');
  await wait();
  assert.deepEqual(ev3, ['blur']);
  assert.equal(fake.document.hidden, false, 'blur alone does not mean the app opened');
});

// ---------- source rules ----------

test('registry.js stays ES5-safe: none of the newer calls old TVs lack, no secrets, no home IP', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'store', 'registry.js'), 'utf8');
  assert.equal(/\.(includes|startsWith|endsWith|padStart|padEnd|repeat|find|findIndex|closest)\(|Object\.(assign|entries|values)\(|Array\.from\(|\bPromise\b|\bfetch\(|new (Map|Set|WeakMap)\b/.test(src), false);
  assert.equal(/\b(let|const)\s|=>|`/.test(src), false);
  assert.equal(/192\.168\.15\.|PRIVATE KEY|api[_-]?key/i.test(src), false);
});

test('fixtures carry no personal data or home network address', function () {
  var dir = path.join(__dirname, 'fixtures');
  fs.readdirSync(dir).forEach(function (f) {
    var t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/192\.168\.15\.|PRIVATE KEY|@gmail/i.test(t), false, f);
  });
});
