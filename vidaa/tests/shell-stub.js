/* Minimal Hisense stub for trying vidaa/shell in a normal browser (no TV needed).
   Keeps the app list in memory, with the real quirks: HiUtils_createRequest is synchronous, the list comes back as a
   JSON string inside msg, StartCommand has a trailing space, InstallTime is YYYY-M-D. Synthetic data only.
   Controls on window.__stub: list (string), calls (array), failWrite (bool), model (string). */
(function () {
  'use strict';
  var original = {
    AppInfo: [
      { Id: '338', AppName: 'GloboPlay', Title: 'GloboPlay', URL: 'https://tv.globoplay.com.br/r/index.html',
        StartCommand: 'https://tv.globoplay.com.br/r/index.html ', IconURL: 'https://img.vidaahub.com/x.png',
        Icon_96: '...', Image: '...', Thumb: '...', InstallTime: '2025-8-10', RunTimes: 0, StoreType: 'hisense',
        appInfo: { openMode: '99' } },
      { Id: '16', AppName: 'TV Browser', URL: 'browser', StartCommand: 'browser', StoreType: 'browser' }
    ]
  };
  var stub = window.__stub = {
    list: JSON.stringify(original),
    calls: [],
    failWrite: false,
    model: '58A51HSV'
  };
  window.Hisense_GetModelName = function () { return stub.model; };
  window.Hisense_GetOSVersion = function () { return 'U09.09'; };
  window.HiUtils_createRequest = function (op, p) {
    stub.calls.push(op);
    if (op === 'fileRead' && p && p.path === 'websdk/Appinfo.json' && p.mode === 6) return { ret: true, msg: stub.list };
    if (op === 'fileWrite' && p && p.path === 'websdk/Appinfo.json' && p.mode === 6) {
      if (stub.failWrite) return { ret: false, msg: 'denied' };
      stub.list = p.writedata;
      return { ret: true, msg: 'success' };
    }
    return { ret: false, msg: 'unknown' };
  };
})();
