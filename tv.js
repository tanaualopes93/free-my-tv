/*
 * The TV's side of the web home screen: its apps, opening one, its inputs, its settings, the Back key, its time zone.
 *  - LG webOS: the TV's service bus (Luna), the same calls LG's launcher makes.
 *  - Samsung Tizen: Tizen's web APIs (tizen.application for the apps, tizen.tvwindow for the inputs).
 *  - Hisense VIDAA: the browser's Hisense_* functions (installed as a web app through vidaahub.com).
 *  - A desktop browser: a stand-in with sample apps, so the screen can be previewed and tested on a computer.
 * Plain ES5: older TVs run a Chromium from 2015-2017 (webOS 3 and 4, Tizen 3).
 */
var TV = (function () {
  'use strict';

  var webos = typeof window.PalmServiceBridge !== 'undefined';
  var samsung = !webos && typeof window.tizen !== 'undefined' && !!window.tizen.application;
  // VIDAA's browser says nothing in its user agent, so it is told by a flag in the address (?tv=vidaa), by the Hisense_*
  // calls, or by the Opera OMI bridge its apps get. What matched is kept for About.
  var vidaaWhy = [];
  if (!webos && !samsung) {
    if (/[?&]tv=vidaa(&|$)/.test(window.location.search)) vidaaWhy.push('?tv=vidaa');
    if (hisenseCalls()) vidaaWhy.push('Hisense_*');
    if (typeof window.omi_platform !== 'undefined' || typeof window.opera_omi !== 'undefined') vidaaWhy.push('omi');
    if (/VIDAA/i.test(navigator.userAgent)) vidaaWhy.push('user agent');
  }
  var vidaa = vidaaWhy.length > 0;
  var calls = [];   // a bridge is collected if nothing holds it before its reply arrives
  var tizen2 = samsung && /Tizen 2\./.test(navigator.userAgent);
  // Tizen 2 (2016 TVs, WebKit 538) repaints every shadow on every frame of a focus animation: home.css turns them off.
  // So do TVs under 2 GB that draw the page at twice its size (an LG on webOS TV Lite 10, MT5889, 1.3 GB, ratio 2:
  // 23-28 fps moving along the shelf, 60 with lite; shadows off alone, 45). deviceMemory rounds down to 1 under 2 GB on
  // webOS 5+ and Tizen 5+, where 1.5 GB TVs at a ratio of 1 run smoothly.
  if (tizen2 || ((webos || samsung || vidaa) && navigator.deviceMemory && navigator.deviceMemory <= 1 && (window.devicePixelRatio || 1) > 1)) {
    document.documentElement.className += ' lite';
  }

  function hisenseCalls() {
    try {
      for (var k in window) if (/^Hisense_/.test(k) && typeof window[k] === 'function') return true;
    } catch (e) {}
    return typeof window.Hisense_GetModelName === 'function';
  }

  /** One Luna call; done(result) with null on failure. */
  function luna(uri, params, done) {
    if (!webos) {
      if (done) setTimeout(function () { done(null); }, 0);
      return;
    }
    var bridge = new window.PalmServiceBridge();
    calls.push(bridge);
    var finished = false;
    bridge.onservicecallback = function (message) {
      if (finished) return;
      finished = true;
      var i = calls.indexOf(bridge);
      if (i >= 0) calls.splice(i, 1);
      var result = null;
      try { result = JSON.parse(message); } catch (e) {}
      if (done) done(result && result.returnValue !== false ? result : null);
    };
    bridge.call(uri, JSON.stringify(params || {}));
  }

  // LG's own screensaver asks every subscribed app first. While Free My TV is on screen and its own screensaver will
  // take over (`hold`, from home.js), it says no; otherwise, and in the background, the TV's runs as before.
  var saverBridge = null;

  function holdScreenSaver(hold) {
    if (!webos || saverBridge) return;
    saverBridge = new window.PalmServiceBridge();
    saverBridge.onservicecallback = function (message) {
      var m = null;
      try { m = JSON.parse(message); } catch (e) {}
      if (!m || m.timestamp === undefined) return;
      luna('luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
          {clientName: self, ack: !!document.hidden || !hold(), timestamp: m.timestamp});
    };
    saverBridge.call('luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
        JSON.stringify({subscribe: true, clientName: self}));
  }

  // webOS 6 gives Developer Mode apps only the "public" group, which leaves out listLaunchPoints. There the list comes
  // from the TV's remote control API on 127.0.0.1:3000 (the one LG's phone app uses), which takes file:// pages.
  // The TV asks once to allow it; the key it gives back is kept. Newer firmware gives the page its own origin
  // (file://<app id>-webos), which the API refuses with 1008 "invalid origin": there our JS service (webos/service)
  // makes the call.
  var SSAP_KEY = 'fmtv.ssapKey', SSAP_REFUSED = 'fmtv.ssapRefused';

  /** One call to the remote control API; done(result) with null on failure. */
  function ssap(uri, done) {
    var ws = null, finished = false, key = null;
    var timer = setTimeout(function () { finish(null); }, 90000);   // time to answer the TV's prompt
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      done(result);
    }
    try { key = localStorage.getItem(SSAP_KEY); } catch (e) {}
    try { ws = new WebSocket('ws://127.0.0.1:3000'); } catch (e) { finish(null); return; }
    ws.onopen = function () {
      var payload = {forcePairing: false, pairingType: 'PROMPT',
        manifest: {manifestVersion: 1, appVersion: '1.0', permissions: ['READ_INSTALLED_APPS']}};
      if (key) payload['client-key'] = key;
      ws.send(JSON.stringify({type: 'register', id: 'register', payload: payload}));
    };
    ws.onmessage = function (event) {
      var m = null;
      try { m = JSON.parse(event.data); } catch (e) {}
      if (!m) return;
      if (m.type === 'registered') {
        try { localStorage.setItem(SSAP_KEY, m.payload['client-key']); } catch (e) {}
        ws.send(JSON.stringify({type: 'request', id: 'call', uri: 'ssap://' + uri}));
      } else if (m.id === 'call' || m.type === 'error') {
        if (m.id === 'register' && m.type === 'error') {
          try { localStorage.setItem(SSAP_REFUSED, '1'); } catch (e) {}   // the person said no on the TV
        }
        finish(m.type !== 'error' && m.payload && m.payload.returnValue !== false ? m.payload : null);
      }
    };
    ws.onerror = function () { finish(null); };
    ws.onclose = function (event) {
      if (event.code === 1008 && !finished) viaService(); else finish(null);
    };
    function viaService() {
      clearTimeout(timer);
      timer = setTimeout(function () { finish(null); }, 100000);   // the service waits 90 s for the prompt
      luna('luna://' + self + '.service/ssap', {uri: uri, clientKey: key}, function (res) {
        if (res && res.clientKey) {
          try { localStorage.setItem(SSAP_KEY, res.clientKey); } catch (e) {}
        }
        if (res && res.refused) {
          try { localStorage.setItem(SSAP_REFUSED, '1'); } catch (e) {}   // the person said no on the TV
        }
        finish(res && res.payload && res.payload.returnValue !== false ? res.payload : null);
      });
    }
  }

  // LG inputs: the antenna and the four HDMI ports, with the apps LG opens for them.
  var INPUTS = [
    {id: 'com.webos.app.livetv', key: 'live', label: null, symbol: 'live_tv'},
    {id: 'com.webos.app.hdmi1', key: 'hdmi1', label: 'HDMI 1', symbol: 'hdmi'},
    {id: 'com.webos.app.hdmi2', key: 'hdmi2', label: 'HDMI 2', symbol: 'hdmi'},
    {id: 'com.webos.app.hdmi3', key: 'hdmi3', label: 'HDMI 3', symbol: 'hdmi'},
    {id: 'com.webos.app.hdmi4', key: 'hdmi4', label: 'HDMI 4', symbol: 'hdmi'}
  ];

  // Not shown among LG's apps: the inputs above, LG's own home and launchers.
  var HIDDEN = /^(com\.webos\.app\.(livetv|hdmi\d|home|homeconnect|discovery|launcher)|com\.webos\.app\.inputpicker)$/;

  // Not shown among Samsung's apps: Smart Hub's own pieces, the platform's tools and players (but its browser,
  // Netflix and Prime Video, which live there too), services, keyboards and ad players. The rest is what Smart Hub shows.
  // Tizen 4 also lists Samsung's own pieces: the YouTube engine's hosts (cobalt-*: "App", "Youtube", "YoutubeTV"),
  // Bixby, search, previews, the weather and notification popups, Apple TV's stand-in and engine.
  // A 2020 TU8000 (Tizen 5.5) ships Prime Video as org.tizen.primevideo, next to a -dummy and a _companionapp.
  // A 2023 Q60C (Tizen 9 in Brazil) ships Globoplay as org.tizen.globoplayapp.
  // A 2023 CU7700 (Tizen 9) leaves `show` unset on ~500 apps: Samsung's system namespaces go, but for the store,
  // SmartThings, Apple TV (aria-video), TV Plus, Gaming Hub and Windows 365.
  var SAMSUNG_HIDDEN = new RegExp('^(org\\.volt\\.|org\\.tizen\\.(?!browser$|netflix|primevideo$|globoplay)|org\\.tizen\\.netflixlowmem$|ise-|ug-|d75857a5-)' +
      '|[Ss]ervice$|[Dd]aemon|Preview$|syspopup|[Hh]elper$|AdPlayer|AdSuite|[Kk]eyboard|\\.OTApp$' +
      '|^com\\.samsung\\.calendar-account-manager' +
      '|^com\\.samsung\\.tv\\.(?!store$|SmartThingsApp$|aria-video$|knox-browser-win365$|tvplus$|gaminghub$)' +
      '|^com\\.samsung\\.tizen\\.' +
      '|^com\\.samsung\\.(ep[-.]|rdm[-.]|SelfDiagnosis$|mtm-banner$|hitcomp$|video-test$)' +
      '|^com\\.sausng\\.' +
      '|^adplatform\\.' +
      '|^(unified-drm-|lib-|p2p-asm|mobilebff$|comss$|acm-watcher$|dmr_service_app$|aifw-|csapi-|capi-|ep-|test-|emergency-log-transmitter$|samsung-easy-support$)');

  // Samsung apps whose iconPath is Tizen's generic pinwheel (a valid image, so onerror never fires): our own icons.
  // Seen on a 2018 NU7675 (Tizen 4); Smart Hub draws their real icons from a folder apps can't read. On a 2017
  // MU6100 (Tizen 3) no iconPath loads at all, so common apps get a logo here: Simple Icons' (CC0), cropped and tinted
  // for the tiles, with a width and height so old WebKit sizes them like PNGs.
  var SAMSUNG_ICONS = {
    '9Ur5IzDKqV.TizenYouTube': 'icons/youtube.png',
    'evKhCgZelL.AmazonIgnitionLauncher2': 'icons/prime.png',
    'org.tizen.primevideo': 'icons/prime.png',
    'RN1MCdNq8t.Netflix': 'icons/netflix.svg',
    'org.tizen.netflix-app': 'icons/netflix.svg',
    'NvZ26VG9Yw.HBOGOLAG': 'icons/max.svg',
    'rJeHak5zRg.Spotify': 'icons/spotify.svg',
    'cexr1qp97S.Deezer': 'icons/deezer.svg',
    '5SLwh7m3En.TizenYouTubeKids': 'icons/youtubekids.svg',
    '4OAwqypfRT.RedBullTV': 'icons/redbull.svg',
    'UCJa2s9hhC.TED': 'icons/ted.svg',
    'QizQxC7CUf.PlayMovies': 'icons/googleplay.svg',
    'vIutycUzou.SteamLink': 'icons/steam.svg',
    'geUOM7qimf.FOXPlay': 'icons/fox.svg',
    'AprZAARz4r.Jellyfin': 'icons/jellyfin.svg'
  };

  // Names Smart Hub gets wrong: HBO's app has none (so it never reached the shelf), others are long or old.
  var SAMSUNG_TITLES = {
    'NvZ26VG9Yw.HBOGOLAG': 'Max',
    'rJeHak5zRg.Spotify': 'Spotify',
    'evKhCgZelL.AmazonIgnitionLauncher2': 'Prime Video',
    'org.tizen.globoplayapp': 'Globoplay'
  };

  // Samsung's settings menu on Tizen 3, which answers no "settings" app control.
  var SAMSUNG_MENU = 'org.tizen.menu';

  // Samsung's live TV viewer: it shows whichever source the TV is on (the antenna, or the HDMI picked here).
  var SAMSUNG_VIEWER = 'org.tizen.tv-viewer';

  var SAMPLE = [
    ['netflix', 'Netflix', '#E50914'], ['youtube.leanback.v4', 'YouTube', '#FF0033'], ['amazon', 'Prime Video', '#1A98FF'],
    ['com.disney.disneyplus-prod', 'Disney+', '#1838C8'], ['com.hbo.hbomax', 'Max', '#6C3BE0'],
    ['com.apple.appletv', 'Apple TV', '#B8BCC6'], ['globoplaywebos', 'Globoplay', '#FF5A1F'], ['spotify-beehive', 'Spotify', '#1DB954'],
    ['cdp-30', 'Plex', '#E5A00D'], ['com.crunchyroll.webapp', 'Crunchyroll', '#F47521'], ['com.webos.app.browser', 'Web Browser', '#3A7BD5'],
    ['com.palm.app.settings', 'Settings', '#8E8E93']
  ];

  // Newer webOS (11 tested) denies listLaunchPoints to Developer Mode apps, but still answers getAppLoadStatus for
  // one app id: these are checked one by one there. Their icons can't be read, so they get our logo where web/icons
  // has one, as on Samsung, and otherwise their name on the brand's color: [id, title, logo, color].
  var KNOWN = [
    ['netflix', 'Netflix', 'icons/netflix.svg'], ['youtube.leanback.v4', 'YouTube', 'icons/youtube.png'],
    ['amazon', 'Prime Video', 'icons/prime.png'], ['com.disney.disneyplus-prod', 'Disney+'],
    ['com.wbd.stream', 'HBO Max', 'icons/max.svg'], ['com.hbo.hbomax', 'Max', 'icons/max.svg'],
    ['com.apple.appletv', 'Apple TV'], ['hulu', 'Hulu'], ['com.peacock.tv', 'Peacock'], ['com.nfl.app', 'NFL'],
    ['globoplaywebos', 'Globoplay'], ['spotify-beehive', 'Spotify', 'icons/spotify.svg'],
    ['tv.twitch.tv.starshot.lg', 'Twitch', '', '#9146FF'], ['cdp-30', 'Plex', '', '#E5A00D'],
    ['org.jellyfin.webos', 'Jellyfin', 'icons/jellyfin.svg'], ['com.crunchyroll.webapp', 'Crunchyroll', '', '#F47521'],
    ['com.webos.app.browser', 'Web Browser', '', '#3A7BD5']
  ];

  function knownApps(done) {
    var found = [], left = KNOWN.length, sent = false;
    function finish() {
      if (sent) return;
      sent = true;
      done(found.filter(function (x) { return x; }));
    }
    setTimeout(finish, 5000);   // an id that never answers doesn't hold the rest
    KNOWN.forEach(function (k, i) {
      luna('luna://com.webos.applicationManager/getAppLoadStatus', {appId: k[0]}, function (res) {
        if (res && res.exist) found[i] = {id: k[0], title: k[1], icon: k[2] || '', color: k[3] || ''};
        if (--left === 0) finish();
      });
    });
  }

  var self = 'io.freemytv';
  if (webos && window.PalmSystem && window.PalmSystem.identifier) self = window.PalmSystem.identifier.split(' ')[0];
  if (samsung) {
    try { self = window.tizen.application.getCurrentApplication().appInfo.id; } catch (e) {}
  }

  // MARK: - Samsung

  function samsungApps(done) {
    try {
      window.tizen.application.getAppsInfo(function (list) {
        var out = [];
        // App ids named in shelf_apps stay even with show false, and are looked up when the list leaves them out:
        // Moonlight, installed in Developer Mode on a 2023 Q60C (Tizen 9), never reached the shelf though Smart Hub
        // lists it. Only whole ids, so a name in shelf_apps can't bring back the platform's hidden pieces.
        var ids = ((window.CONFIG || {}).shelfApps || []).filter(function (w) { return w.indexOf('.') > 0; });
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (!a.id || a.id === self || SAMSUNG_HIDDEN.test(a.id) || (a.show === false && ids.indexOf(a.id) < 0)) continue;
          out.push(samsungApp(a));
        }
        ids.forEach(function (id) {
          if (out.some(function (x) { return x.id === id; })) return;
          try { out.push(samsungApp(window.tizen.application.getAppInfo(id))); } catch (e) {}
        });
        // The built-in Netflix stays only when the store's Netflix isn't installed.
        var store = out.some(function (x) { return /\.Netflix$/.test(x.id); });
        if (store) out = out.filter(function (x) { return x.id.indexOf('org.tizen.netflix') !== 0; });
        // Smart Hub keeps its own order, which isn't readable: the same alphabetical order as All Apps elsewhere.
        out.sort(function (x, y) { var a = x.title.toLowerCase(), b = y.title.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; });
        done(out);
      }, function () { done([]); });
    } catch (e) {
      done([]);
    }
  }

  function samsungApp(a) {
    var icon = a.iconPath || '';
    if (icon && icon.indexOf('://') < 0) icon = 'file://' + icon;
    if (SAMSUNG_ICONS[a.id]) icon = SAMSUNG_ICONS[a.id];
    return {id: a.id, title: SAMSUNG_TITLES[a.id] || a.name || a.id, icon: icon, color: ''};
  }

  function samsungLaunch(id, done) {
    try {
      window.tizen.application.launch(id, function () { if (done) done(true); }, function () { if (done) done(false); });
    } catch (e) {
      if (done) done(false);
    }
  }

  /**
   * The video sources the TV reports ([{type: 'TV' | 'HDMI' | ..., number}]), or null when it doesn't tell. With `all`,
   * the disconnected ones too: Tizen 4 lists an HDMI device on standby as disconnected (even the one on screen), and
   * tvwindow.setSource still switches to it, as Samsung's own source menu does.
   */
  function samsungSources(done, all) {
    try {
      window.tizen.systeminfo.getPropertyValue('VIDEOSOURCE', function (v) {
        done(v && v.connected ? (all ? v.connected.concat(v.disconnected || []) : v.connected) : null);
      }, function () { done(null); });
    } catch (e) {
      done(null);
    }
  }

  /** Puts the TV on a source ("source:HDMI:2"), then brings the TV's viewer up to show it. */
  function samsungSource(spec, done) {
    var parts = spec.split(':'), type = parts[1], number = +parts[2];
    function show(ok) {
      if (!ok) { if (done) done(false); return; }
      samsungLaunch(SAMSUNG_VIEWER, function (shown) {
        if (!shown) {
          try { window.tizen.application.getCurrentApplication().hide(); } catch (e) {}
        }
        if (done) done(true);
      });
    }
    samsungSources(function (sources) {
      var source = null;
      for (var i = 0; sources && i < sources.length; i++) {
        if (sources[i].type === type && sources[i].number === number) source = sources[i];
      }
      if (!source) { show(type === 'TV'); return; }   // the antenna: the viewer alone brings it up
      try {
        window.tizen.tvwindow.setSource(source, function () { show(true); }, function () { show(false); });
      } catch (e) {
        show(false);
      }
    }, true);
  }

  function samsungInputs(done) {
    var list = [{id: 'source:TV:1', key: 'live', label: null, symbol: 'live_tv', connected: true}];
    for (var n = 1; n <= 4; n++) list.push({id: 'source:HDMI:' + n, key: 'hdmi' + n, label: 'HDMI ' + n, symbol: 'hdmi', connected: true});
    samsungSources(function (sources) {
      if (sources) {
        for (var i = 1; i < list.length; i++) list[i].connected = false;
        for (var j = 0; j < sources.length; j++) {
          var s = sources[j];
          if (s.type === 'HDMI' && s.number >= 1 && s.number <= 4) list[s.number].connected = true;
        }
      }
      done(list);
    });
  }

  /** Samsung's settings: whichever app answers the platform's "settings" request, else the TV's menu (Tizen 3). */
  function samsungSettings(done) {
    function menu() { samsungLaunch(SAMSUNG_MENU, done); }
    try {
      var control = new window.tizen.ApplicationControl('http://tizen.org/appcontrol/operation/setting', null, null, null, []);
      window.tizen.application.launchAppControl(control, null, function () { if (done) done(true); }, menu);
    } catch (e) {
      menu();
    }
  }

  // MARK: - Hisense VIDAA

  // VIDAA has no public reference for listing or opening apps: Hisense_launchAppViaName and Hisense_launchAppViaUri
  // exist on its browser (found by listing window), with arguments nobody has published. So the shelf starts from the
  // apps of the remote's own buttons and the TV's list wins over it (address, icon); opening tries each call in turn and
  // counts only when this page goes to the background; an app nothing opens stays dimmed, and the way that worked is
  // remembered. About shows what is there, to set the calls right for a firmware.
  // [id, title, logo, color]: no web address is guessed, one comes only from the TV's own list.
  var VIDAA_APPS = [
    ['netflix', 'Netflix', 'icons/netflix.svg'], ['youtube', 'YouTube', 'icons/youtube.png'],
    ['prime', 'Prime Video', 'icons/prime.png'], ['globoplay', 'Globoplay', '', '#FF5A1F'],
    ['deezer', 'Deezer', 'icons/deezer.svg'], ['kids', 'Kids', '', '#FF5A5F'],
    ['plex', 'Plex', '', '#E5A00D'], ['clarovideo', 'Claro vídeo', '', '#DA291C'],
    ['plutotv', 'Pluto TV', '', '#2D2D2D'], ['vidaatv', 'VIDAA TV', '', '#12A7A0'], ['fifaplus', 'FIFA+', '', '#2B3F8C']
  ];

  // The web apps' list on the TV, read through HiUtils_createRequest (read only: this file never writes it).
  var VIDAA_REGISTRY = 'websdk/Appinfo.json';

  var KEY_WAYS = 'fmtv.vidaa.ways', KEY_FAILED = 'fmtv.vidaa.failed', KEY_LOG = 'fmtv.vidaa.log', KEY_PENDING = 'fmtv.vidaa.pending';

  function recall(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }

  function keep(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  var vidaaList = [];   // what apps() last listed, with the addresses launch() needs
  var vidaaLog = vidaa ? recall(KEY_LOG, []) : [];   // the last attempts to open something, for About (kept: opening may end the page)

  function has(name) {
    try { return typeof window[name] === 'function'; } catch (e) { return false; }
  }

  function note(text) {
    vidaaLog.push(text);
    if (vidaaLog.length > 6) vidaaLog.shift();
    if (vidaa) keep(KEY_LOG, vidaaLog);
  }

  // A call that was made and never came back to this page: the page was most likely taken to the background and ended.
  var vidaaPending = vidaa ? recall(KEY_PENDING, null) : null;
  if (vidaaPending) {
    note(vidaaPending.app + ': ' + vidaaPending.way + ' provavelmente abriu (a página recarregou)');
    keep(KEY_PENDING, null);
  }

  function trim(s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); }

  /** An absolute http(s) address, else '': the only thing location may be pointed at. */
  function webUrl(u) {
    u = trim(u);
    return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
  }

  /** A name to compare by: lowercase, no accents, letters and digits only ("Claro vídeo" = "claro video", "AppleTV+" = "appletv"). */
  function norm(s) {
    return String(s).toLowerCase().replace(/[áàâãä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
        .replace(/[óòôõö]/g, 'o').replace(/[úùûü]/g, 'u').replace(/ç/g, 'c').replace(/[^a-z0-9]/g, '');
  }

  /** One app from the TV's own lists, whichever field names its firmware uses; null without a name. */
  function vidaaApp(a) {
    if (!a || typeof a !== 'object') return null;
    var title = a.AppName || a.appName || a.Title || a.title || a.name || a.Name || '';
    if (!title || /free my tv/i.test(title)) return null;
    // The list holds web apps (StoreType custom or hisense) and the TV's browser, whose address is the word "browser".
    var raw = trim(a.URL || a.url || a.appUrl || a.AppUrl || a.StartCommand), type = trim(a.StoreType).toLowerCase();
    var browser = type === 'browser' || raw.toLowerCase() === 'browser';
    return {
      id: String(a.Id || a.appId || a.AppId || a.id || title), title: String(title),
      icon: a.IconURL || a.Icon_96 || a.iconUrl || a.icon || a.Image || a.Thumb || '', color: '',
      url: browser ? '' : webUrl(raw), rawUrl: raw, type: browser ? 'browser' : type,
      listId: String(a.Id || a.appId || a.AppId || a.id || ''), appName: ''
    };
  }

  /** The first list of apps in a reply (a JSON string, a list, or an object holding one). */
  function vidaaListOf(res) {
    if (typeof res === 'string') {
      try { res = JSON.parse(res); } catch (e) { return []; }
    }
    if (!res || typeof res !== 'object') return [];
    if (res instanceof Array) return res;
    for (var k in res) if (res[k] instanceof Array) return res[k];
    return [];
  }

  /** Apps the launcher lists, when Hisense_getInstalledApps answers (by return value or by callback), else null. */
  function vidaaInstalled(done) {
    if (!has('Hisense_getInstalledApps')) { done(null); return; }
    var sent = false;
    function finish(res) {
      if (sent) return;
      sent = true;
      var out = [], list = vidaaListOf(res);
      for (var i = 0; i < list.length; i++) {
        var a = vidaaApp(list[i]);
        if (a) out.push(a);
      }
      done(out.length ? out : null);
    }
    setTimeout(function () { finish(null); }, 1500);
    try {
      var res = window.Hisense_getInstalledApps(function (r) { finish(r); });
      if (res !== undefined && res !== null) finish(res);
    } catch (e) {
      finish(null);
    }
  }

  /** The TV's list file, read only: {ret, bytes, apps: [app]}; ret is null when there is no reader. */
  function vidaaRead() {
    if (!has('HiUtils_createRequest')) return {ret: null, bytes: 0, apps: []};
    try {
      var res = window.HiUtils_createRequest('fileRead', {path: VIDAA_REGISTRY, mode: 6});
      var text = res && res.ret && typeof res.msg === 'string' ? res.msg : '';
      var apps = [], list = vidaaListOf(text);
      for (var i = 0; i < list.length; i++) {
        var a = vidaaApp(list[i]);
        if (a) apps.push(a);
      }
      return {ret: !!(res && res.ret), bytes: text.length, apps: apps, count: list.length};
    } catch (e) {
      return {ret: false, bytes: 0, apps: [], count: 0};
    }
  }

  /**
   * The shelf's apps: the remote's buttons, with the TV's own entry winning where it has the same app (address, icon,
   * the name its launcher knows); then what the list holds beyond them. The TV's browser never gets an address.
   */
  function vidaaApps(done) {
    vidaaInstalled(function (installed) {
      var base = [], byName = {}, extras = [], browsers = [], seen = {};
      VIDAA_APPS.forEach(function (k) {
        var b = {id: k[0], title: k[1], icon: k[2] || '', color: k[3] || '', url: '', rawUrl: '', type: '', listId: '', appName: ''};
        base.push(b);
        byName[norm(b.title)] = b;
      });
      vidaaRead().apps.concat(installed || []).forEach(function (a) {
        var n = norm(a.title);
        if (!n || seen[n]) return;
        seen[n] = true;
        var b = byName[n];
        if (b) {
          b.appName = a.title;
          b.url = a.url;
          b.rawUrl = a.rawUrl;
          b.type = a.type;
          b.listId = a.listId;
          if (a.icon) b.icon = a.icon;
        } else if (a.type === 'browser') {
          browsers.push(a);
        } else {
          extras.push(a);
        }
      });
      var out = base.slice(0, 4).concat(extras, base.slice(4), browsers);
      vidaaList = out;
      done(out.map(function (a) { return {id: a.id, title: a.title, icon: a.icon, color: a.color}; }));
    });
  }

  // How a call can be made: [the Hisense function, the argument for an app ('' when it has none for this way].
  var WAYS = {
    'name:title': ['Hisense_launchAppViaName', function (a) { return a.appName || a.title; }],
    'name:id': ['Hisense_launchAppViaName', function (a) { return a.listId; }],
    'name:json': ['Hisense_launchAppViaName', function (a) { return JSON.stringify({appName: a.appName || a.title}); }],
    'name:object': ['Hisense_launchAppViaName', function (a) { return {appName: a.appName || a.title}; }],
    'name:json-id': ['Hisense_launchAppViaName', function (a) {
      return a.listId ? JSON.stringify({Id: a.listId, AppName: a.appName || a.title}) : '';
    }],
    'uri:url': ['Hisense_launchAppViaUri', function (a) { return a.url; }],
    'uri:raw': ['Hisense_launchAppViaUri', function (a) { return a.rawUrl; }]
  };
  var LAUNCH_WAYS = ['name:title', 'uri:url'];
  var TEST_WAYS = ['name:title', 'name:id', 'name:json', 'name:object', 'name:json-id', 'uri:url', 'uri:raw'];

  /**
   * Makes each call in turn until one takes this page to the background (VIDAA's calls answer nothing, and a wrong
   * argument is silently ignored); done(the way that did, or ''). Only visibilitychange and document.hidden count:
   * blur also fires on a TV's own overlays.
   */
  function tryWays(app, ways, wait, done) {
    var i = 0, tried = {}, gone = false;
    function away() { if (document.hidden) gone = true; }
    document.addEventListener('visibilitychange', away);
    function finish(way) {
      document.removeEventListener('visibilitychange', away);
      keep(KEY_PENDING, null);
      done(way);
    }
    function attempt(name, call, arg) {
      var threw = '', waited = 0;
      gone = false;
      keep(KEY_PENDING, {app: app.title, way: name});
      try { window[call](arg); } catch (e) { threw = ' (' + e.message + ')'; }
      var timer = setInterval(function () {
        waited += 100;
        if (gone || document.hidden) {
          clearInterval(timer);
          note(app.title + ': ' + name + ' abriu');
          finish(name);
        } else if (waited >= wait || threw) {
          clearInterval(timer);
          note(app.title + ': ' + name + ' nada' + threw);
          next();
        }
      }, 100);
    }
    function next() {
      while (i < ways.length) {
        var name = ways[i++], def = WAYS[name];
        if (!def || !has(def[0])) continue;
        var arg = def[1](app);
        if (arg === '' || arg === null || arg === undefined) continue;
        var sig = def[0] + JSON.stringify(arg);
        if (tried[sig]) continue;
        tried[sig] = true;
        attempt(name, def[0], arg);
        return;
      }
      finish('');
    }
    next();
  }

  /** The way that opened an app is remembered (and the app is no longer dimmed). */
  function remember(id, way) {
    var ways = recall(KEY_WAYS, {}), failed = recall(KEY_FAILED, {});
    ways[id] = way;
    delete failed[id];
    keep(KEY_WAYS, ways);
    keep(KEY_FAILED, failed);
  }

  function forget(id, off) {
    var failed = recall(KEY_FAILED, {});
    if (off) failed[id] = 1; else delete failed[id];
    keep(KEY_FAILED, failed);
  }

  /**
   * Opens an app: the remembered way first, then by name, then by address, and last (a web app with an absolute
   * address, never the TV's browser) by going to its page. Nothing worked: the app stays dimmed.
   */
  function launchApp(app, done) {
    var ways = recall(KEY_WAYS, {}), order = ways[app.id] ? [ways[app.id]].concat(LAUNCH_WAYS) : LAUNCH_WAYS;
    tryWays(app, order, 2000, function (way) {
      if (way) { remember(app.id, way); if (done) done(true); return; }
      if (app.url && app.type !== 'browser') {
        note(app.title + ': location ' + app.url);
        if (done) done(true);
        window.location.href = app.url;
        return;
      }
      note(app.title + ': nada o abriu');
      forget(app.id, true);
      if (done) done(false);
    });
  }

  function vidaaLaunch(id, done) {
    var app = null;
    for (var i = 0; i < vidaaList.length; i++) if (vidaaList[i].id === id) app = vidaaList[i];
    if (!app) { if (done) done(false); return; }
    launchApp(app, done);
  }

  /** The Store's app ({id, name, url}) once it is in the TV's list: found there by its entry, else tried as it is. */
  function vidaaLaunchStore(a, done) {
    var id = String(a && a.id || ''), listId = id.indexOf('fmtv_') === 0 ? id : 'fmtv_' + id, app = null;
    for (var i = 0; i < vidaaList.length; i++) if (vidaaList[i].listId === listId || vidaaList[i].id === listId) app = vidaaList[i];
    if (!app) {
      app = {id: listId, title: String(a && (a.name || a.title) || id), icon: '', color: '', url: webUrl(a && a.url), rawUrl: '',
        type: '', listId: listId, appName: ''};
    }
    launchApp(app, done);
  }

  /** Whether an app was tried and nothing opened it (it stays dimmed until something does). */
  function vidaaOff(id) {
    return !!recall(KEY_FAILED, {})[id];
  }

  /** Apps "Testar abrir" can try, by name. */
  function testApps() {
    return vidaaList.map(function (a) { return a.title; });
  }

  /** Tries every format of argument for one app; done(the way that opened it, or ''). The way is remembered. */
  function testOpen(index, done) {
    var app = vidaaList[index];
    if (!app) { if (done) done(''); return; }
    note('teste: ' + app.title);
    tryWays(app, TEST_WAYS, 2500, function (way) {
      if (way) remember(app.id, way); else note(app.title + ': nenhum formato abriu');
      if (done) done(way);
    });
  }

  var keylog = [];   // the last keys, for About: the key code beside the name the TV gives it
  if (!webos && !samsung) {
    document.addEventListener('keydown', function (e) {
      keylog.push(e.keyCode + ' ' + (e.key || '?'));
      if (keylog.length > 5) keylog.shift();
    }, true);
  }

  function vidaaCall(name) {
    if (!has(name)) return '';
    try { return String(window[name]() || ''); } catch (e) { return ''; }
  }

  function yes(on) { return on ? 'sim' : 'não'; }

  /**
   * What About shows on VIDAA, in lines: the build, why this is VIDAA, a read of the TV's list (read only), which calls
   * exist, the last keys, the screen, then the last attempts to open something. One photo of it sets the rest right.
   */
  function diagnostics() {
    var cfg = window.CONFIG || {}, read = vidaaRead();
    var omi = window.omi_platform || window.opera_omi;
    var chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
    var out = [
      'Build ' + (cfg.buildVersion || cfg.appVersion || '—') + (chrome ? ' · Chrome ' + chrome[1].split('.')[0] : ''),
      'Detecção: ' + (vidaaWhy.length ? vidaaWhy.join(' + ') : 'nenhuma (simulador)'),
      'Lista: ' + (read.ret === null ? 'sem leitor' : 'ret ' + read.ret + ' · ' + read.bytes + ' bytes · ' + (read.count || 0) + ' apps'),
      'launchAppViaName ' + yes(has('Hisense_launchAppViaName')) + ' · launchAppViaUri ' + yes(has('Hisense_launchAppViaUri')),
      'StartApp ' + yes(has('Hisense_StartApp')) + ' · getInstalledApps ' + yes(has('Hisense_getInstalledApps')),
      'Exit ' + yes(has('Hisense_Exit')) + ' · CloseApp ' + yes(has('Hisense_CloseApp')) +
          ' · HiUtils ' + yes(has('HiUtils_createRequest')) + ' · omi ' + yes(omi && typeof omi.sendPlatformMessage === 'function'),
      'Teclas: ' + (keylog.join('   ') || '—'),
      'Tela ' + (window.screen ? window.screen.width + '×' + window.screen.height : '?') + ' · janela ' + window.innerWidth + '×' +
          window.innerHeight + ' · DPR ' + (window.devicePixelRatio || 1) + ' · memória ' + (navigator.deviceMemory || '?'),
      'lite ' + yes(/(^|\s)lite(\s|$)/.test(document.documentElement.className)) + ' · serviceWorker ' + yes('serviceWorker' in navigator)
    ];
    return out.concat(vidaaLog.map(function (line) { return '› ' + line; }));
  }

  // MARK: - Text only the VIDAA build shows (window.FMTV_STRINGS, from vidaa/store/strings.json; Portuguese and English here as a reserve)

  var SAY = {
    pt: {
      opening: 'Abrindo…', openFailed: 'Não consegui abrir o {app}. Use o botão {app} do controle.',
      useRemote: 'Use o botão {app} do controle', backAgain: 'Aperte Voltar de novo para sair', store: 'Loja',
      moreInStore: 'Mais apps na Loja', storeLoading: 'A Loja ainda não carregou. Aguarde um instante.', testOpen: 'Testar abrir'
    },
    en: {
      opening: 'Opening…', openFailed: "Couldn't open {app}. Use the {app} button on your remote.",
      useRemote: 'Use the {app} button on your remote', backAgain: 'Press Back again to exit', store: 'Store',
      moreInStore: 'More apps in the Store', storeLoading: 'The Store has not loaded yet. Wait a moment.', testOpen: 'Test opening'
    }
  };

  /** FMTV_STRINGS may be {pt: {key: text}} or {key: {pt: text}}; the text of this language, else English, else the reserve. */
  function sayFrom(table, lang, key) {
    if (!table || typeof table !== 'object') return null;
    var byLang = table[lang], byKey = table[key];
    if (byLang && typeof byLang === 'object' && typeof byLang[key] === 'string') return byLang[key];
    if (typeof byKey === 'string') return byKey;
    if (byKey && typeof byKey === 'object' && typeof byKey[lang] === 'string') return byKey[lang];
    return null;
  }

  // The names strings.json gives the same texts.
  var SAY_FILE = {openFailed: 'open_fail', useRemote: 'shelf_no_path', store: 'store_title', backAgain: 'back_again'};

  function say(key, vars) {
    var lang = typeof I18N !== 'undefined' && I18N.lang ? I18N.lang : 'en';
    var file = SAY_FILE[key] || key;
    var text = sayFrom(window.FMTV_STRINGS, lang, file) || sayFrom(window.FMTV_STRINGS, 'en', file) ||
        (SAY[lang] && SAY[lang][key]) || SAY.en[key] || SAY.pt[key] || key;
    return text.replace(/\{(\w+)\}/g, function (all, name) { return vars && vars[name] !== undefined ? vars[name] : all; });
  }

  // MARK: - About this TV

  /** done({model, firmware, system, version, ip}), with '' for what the TV doesn't tell. */
  function about(done) {
    var out = {model: '', firmware: '', system: '', version: '', ip: ''}, left = 1, sent = false;
    function wait() { left++; }
    function finish() {
      if (--left > 0 || sent) return;
      sent = true;
      clearTimeout(timer);
      done(out);
    }
    var timer = setTimeout(function () { left = 1; finish(); }, 4000);   // a service that never answers doesn't hold the rest

    if (webos) {
      // The services LG's webOSTV.js reads for webOS.deviceInfo, and its public connection manager.
      wait();
      luna('luna://com.webos.service.tv.systemproperty/getSystemInfo', {keys: ['modelName', 'firmwareVersion', 'sdkVersion']}, function (res) {
        if (res) {
          out.model = res.modelName || '';
          out.firmware = res.firmwareVersion || '';
          if (!out.system && res.sdkVersion) out.system = 'webOS ' + res.sdkVersion;
        }
        finish();
      });
      wait();
      luna('luna://com.webos.service.systemservice/osInfo/query', {parameters: ['webos_release']}, function (res) {
        if (res && res.webos_release) out.system = 'webOS ' + res.webos_release;
        finish();
      });
      wait();
      luna('luna://com.palm.connectionmanager/getStatus', {}, function (res) {
        if (res) {
          var wired = res.wired || {}, wifi = res.wifi || {};
          if (wired.state === 'connected' && wired.ipAddress) out.ip = wired.ipAddress;
          else if (wifi.state === 'connected' && wifi.ipAddress) out.ip = wifi.ipAddress;
        }
        finish();
      });
      wait();
      // The app's own version: its appinfo.json, beside index.html.
      var x = new XMLHttpRequest();
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        try { out.version = JSON.parse(x.responseText).version || ''; } catch (e) {}
        finish();
      };
      try { x.open('GET', 'appinfo.json', true); x.send(); } catch (e) { finish(); }
    } else if (samsung) {
      var info = window.tizen.systeminfo;
      try { out.model = info.getCapability('http://tizen.org/system/model_name') || ''; } catch (e) {}
      try { out.system = 'Tizen ' + info.getCapability('http://tizen.org/feature/platform.version'); } catch (e) {}
      try { out.version = window.tizen.application.getCurrentApplication().appInfo.version || ''; } catch (e) {}
      var property = function (name, got) {
        wait();
        try {
          info.getPropertyValue(name, function (v) { got(v); finish(); }, function () { finish(); });
        } catch (e) {
          finish();
        }
      };
      // BUILD's buildVersion is the firmware (T-KTMDEUC-1250.4); its model is the panel's (UN55NU7100) where model_name is a code.
      property('BUILD', function (v) {
        if (v.buildVersion) out.firmware = v.buildVersion;
        if (v.model) out.model = v.model;
      });
      property('ETHERNET_NETWORK', function (v) {
        if (v.status === 'ON' && v.ipAddress) out.ip = v.ipAddress;
      });
      property('WIFI_NETWORK', function (v) {
        if (v.status === 'ON' && v.ipAddress && !out.ip) out.ip = v.ipAddress;
      });
    } else if (vidaa) {
      out.model = vidaaCall('Hisense_GetModelName');
      out.firmware = vidaaCall('Hisense_GetFirmWareVersion');
      var os = vidaaCall('Hisense_GetOSVersion');
      out.system = 'VIDAA' + (os ? ' ' + os : '');
      out.ip = vidaaCall('Hisense_GetIPAddress');
      out.version = (window.CONFIG && CONFIG.appVersion) || '';
    } else {
      out = {model: 'OLED55C1', firmware: '03.33.85', system: 'webOS 6.0', version: 'preview', ip: '192.168.1.50'};
    }
    finish();
  }

  // MARK: - The TV, whichever it is

  return {
    name: webos ? 'webos' : samsung ? 'tizen' : vidaa ? 'vidaa' : 'browser',

    /**
     * Whether an app can open the TV's settings. Not on Tizen 2 (a 2016 KU6300): the "settings" request and
     * org.tizen.menu both answer success and nothing shows, and the remote API ignores MENU and HOME.
     * Not on VIDAA, which has no call for it.
     */
    canOpenSettings: !tizen2 && !vidaa,

    /** Installed apps, as the TV's launcher lists them: [{id, title, icon, color}]. */
    apps: function (done) {
      if (samsung) { samsungApps(done); return; }
      if (vidaa) { vidaaApps(done); return; }
      if (!webos) {
        done(SAMPLE.map(function (s) { return {id: s[0], title: s[1], icon: '', color: s[2]}; }));
        return;
      }
      function list(res) {
        var out = [];
        var points = res && res.launchPoints ? res.launchPoints : [];
        for (var i = 0; i < points.length; i++) {
          var p = points[i];
          if (!p.id || p.id === self || HIDDEN.test(p.id)) continue;
          out.push({id: p.id, title: p.title || p.id, icon: p.largeIcon || p.icon || '', color: p.bgColor || p.iconColor || ''});
        }
        return out;
      }
      luna('luna://com.webos.applicationManager/listLaunchPoints', {}, function (res) {
        if (res) { done(list(res)); return; }
        // Denied to Developer Mode apps (webOS 6 and newer): once the TV has allowed the remote control API, it lists
        // every app with its icon; until then, the known apps the TV says it has, while the TV asks once (an answer
        // only counts from the next load on, and a "no" isn't asked again).
        // webOS 3 has neither getAppLoadStatus nor a remote control API that takes file:// pages ("invalid origin"):
        // there the list comes from the computer (webos/apps.py), built into the LG package.
        var built = (window.CONFIG && CONFIG.installedApps) || [];
        if (built.length) {
          done(built.filter(function (a) { return a.id !== self && !HIDDEN.test(a.id); }));
          return;
        }
        var paired = false, refused = false;
        try { paired = !!localStorage.getItem(SSAP_KEY); refused = !!localStorage.getItem(SSAP_REFUSED); } catch (e) {}
        if (paired) {
          ssap('com.webos.applicationManager/listLaunchPoints', function (res2) {
            if (res2) done(list(res2)); else knownApps(done);
          });
          return;
        }
        knownApps(done);
        if (!refused) ssap('com.webos.applicationManager/listLaunchPoints', function () {});
      });
    },

    /** Opens an app (or an input); done(ok). */
    launch: function (id, params, done) {
      if (samsung) {
        if (id.indexOf('source:') === 0) samsungSource(id, done);
        else samsungLaunch(id, done);
        return;
      }
      if (vidaa) { vidaaLaunch(id, done); return; }
      if (!webos) {
        if (done) setTimeout(function () { done(true); }, 0);
        return;
      }
      luna('luna://com.webos.applicationManager/launch', params ? {id: id, params: params} : {id: id}, function (res) {
        if (done) done(!!res);
      });
    },

    /** The antenna and HDMI inputs; `connected` when the TV says a device is on (when it tells). */
    inputs: function (done) {
      if (samsung) { samsungInputs(done); return; }
      if (vidaa) { done([]); return; }   // no call lists or opens VIDAA's inputs
      var list = INPUTS.map(function (x) { return {id: x.id, key: x.key, label: x.label, symbol: x.symbol, connected: true}; });
      if (!webos) {
        list[2].connected = false;
        list[3].connected = false;
        list[4].connected = false;
        done(list);
        return;
      }
      luna('luna://com.webos.service.eim/getAllInputStatus', {}, function (res) {
        var devices = res && res.devices ? res.devices : null;
        if (devices) {
          for (var i = 1; i < list.length; i++) {
            for (var j = 0; j < devices.length; j++) {
              var d = devices[j];
              if (d.appId !== list[i].id) continue;
              list[i].connected = d.connected !== false;
              // A name the person gave the input on the TV ("PS5"), if any.
              if (d.label && !/^hdmi\s*\d$/i.test(d.label)) list[i].label = d.label;
            }
          }
        }
        done(list);
      });
    },

    /** The TV's own settings; done(ok). */
    settings: function (done) {
      if (samsung) samsungSettings(done);
      else this.launch('com.palm.app.settings', null, done);
    },

    /** The TV's model, firmware, system, IP address and this app's version, for About this TV. */
    about: about,

    /** Lines for About on a TV that isn't LG or Samsung (VIDAA, or the preview), to set the Hisense calls right; null elsewhere. */
    diagnostics: !webos && !samsung ? diagnostics : null,

    /** VIDAA's "Testar abrir": the apps it can try by name, and trying every format of argument for one; done(way or ''). */
    testApps: testApps,
    testOpen: testOpen,

    /** VIDAA: whether nothing has opened this app yet (it stays dimmed), and opening the Store's apps by their entry. */
    isOff: function (id) { return vidaa && vidaaOff(id); },
    launchStoreApp: function (app, done) {
      if (vidaa) vidaaLaunchStore(app, done); else if (done) done(false);
    },

    /** Text only the VIDAA build shows, in the viewer's language (window.FMTV_STRINGS, else the reserve here). */
    say: say,

    /** Why this TV counts as VIDAA ('' when it doesn't). */
    why: vidaaWhy.join(' + '),

    /** LG: keeps the TV's screensaver away while ours will take over (`hold` says when). */
    holdScreenSaver: holdScreenSaver,

    /** Back on the first screen: back to wherever the person came from. */
    back: function () {
      if (samsung) {
        try { window.tizen.application.getCurrentApplication().hide(); } catch (e) {}
        return;
      }
      if (vidaa) {
        // window.close() does nothing on VIDAA: Hisense_Exit (or CloseApp, on older firmware) leaves the app.
        try {
          if (has('Hisense_Exit')) window.Hisense_Exit();
          else if (has('Hisense_CloseApp')) window.Hisense_CloseApp();
          else window.close();
        } catch (e) {}
        return;
      }
      if (window.PalmSystem && window.PalmSystem.platformBack) window.PalmSystem.platformBack();
    },

    /** The TV's time zone ("America/Sao_Paulo"), or ''. */
    zone: function () {
      if (samsung) {
        try { return window.tizen.time.getLocalTimezone() || ''; } catch (e) {}
      }
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
    },

    /** Key codes: the arrows, OK and the TV's Back (LG 461, Samsung 10009). */
    keys: {left: 37, up: 38, right: 39, down: 40, ok: 13, back: samsung ? 10009 : 461}
  };
})();
