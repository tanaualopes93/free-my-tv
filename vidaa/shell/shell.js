/* Free My TV installer, served on https://vidaahub.com/ by the local server.
   On the TV (Hisense_* present) it installs, updates, restores and removes entries of the app list through
   FMTVRegistry; on a computer it only explains the steps. Every write is preceded by a confirmed POST /backup. */
(function () {
  'use strict';

  var BASE = 'https://tanaualopes93.github.io/free-my-tv/';
  var FMTV = { id: 'FreeMyTV', name: 'Free My TV', url: BASE, icon: BASE + 'icon.png' };
  var BACK_KEYS = [8, 27, 461, 10009];
  var WAIT_MS = 30000;
  var CONFIRM_MS = 4000;

  var T = {
    install: 'Instalar na TV', update: 'Atualizar na TV',
    working: 'Instalando…', checking: 'Conferindo…', checkingTitle: 'Gravado. Conferindo…',
    removed: '{app} foi removido.',
    failInstall: 'Não consegui instalar o {app}. Nada mudou na sua TV.',
    failRemove: 'Não consegui remover o {app}. Nada mudou na sua TV.',
    retry: 'Tentar de novo', confirm: 'Confirmar', cancel: 'Cancelar', confirmRemove: 'Confirmar remoção',
    confirmInstall: 'Vai instalar {app} de {domain}. Confirme se é isso mesmo.',
    typed: 'Você digitou este endereço. Confira o nome do site antes de continuar.',
    insecure: 'Conexão sem proteção. Use só em redes e endereços em que você confia.',
    queueEmpty: 'Nada na fila.', done: 'Pronto',
    restoreKey: 'As cópias não guardam a chave do TMDB. Se você usava uma, digite de novo depois de restaurar.'
  };

  var ERR = {
    'no-api': 'Esta página não encontrou as funções da TV.',
    unreadable: 'Não consegui ler a lista de apps da TV.',
    backup: 'O computador não confirmou a cópia de segurança.',
    changed: 'A lista da TV mudou enquanto eu trabalhava.',
    write: 'A TV não aceitou a gravação.',
    verify: 'Gravei, mas a conferência não bateu. Use Restaurar.',
    invalid: 'O endereço não é válido.',
    limit: 'Chegou ao limite de apps nossos na lista.',
    domain: 'Este endereço não está na lista de sites aprovados.',
    busy: 'Outra gravação ainda estava em andamento.',
    internal: 'Aconteceu um erro inesperado.'
  };
  var UNTOUCHED = { 'no-api': 1, unreadable: 1, backup: 1, changed: 1, invalid: 1, limit: 1, domain: 1, busy: 1 };

  var reg = null;
  var isTV = typeof window.HiUtils_createRequest === 'function' || typeof window.Hisense_GetModelName === 'function';
  var state = { back: null, screen: 'home', busy: false, queue: [], catalog: null, ping: null, ours: [], count: null, timer: 0, confirmTimer: 0 };
  var $ = function (id) { return document.getElementById(id); };

  function fmt(s, v) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function paint() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 30); }); });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }
  function shortHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return ('0000' + h.toString(36)).slice(-4);
  }
  function stripKey(s) { return String(s || '').replace(/#k=.*$/, '#k=...'); }
  // The TMDB key rides in the FreeMyTV address; copies on the PC never keep it.
  function withoutKey(raw) { return String(raw).replace(/#k=[^"\\\s]*/g, '#k='); }

  /* Fire-and-forget log to the server. The TMDB key never goes in: only "k presente". */
  function log(ev, data) {
    try {
      var body = { t: new Date().toISOString(), ev: ev };
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) body[k] = typeof data[k] === 'string' ? stripKey(data[k]) : data[k];
      fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function () {});
    } catch (e) { /* the log is optional */ }
  }

  function jget(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  /* ---------- computer page ---------- */
  function ipFromPing(p) {
    var ip = p && (p.ip || p.pc_ip);
    if (!ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)) ip = location.hostname;
    return ip || '';
  }
  function showPc() {
    document.body.className = 'pc';
    $('pc').hidden = false;
    jget('/ping').then(function (p) {
      $('pc-ip').textContent = ipFromPing(p) || 'o mostrado quando o servidor foi iniciado';
    }, function () {
      $('pc-ip').textContent = ipFromPing(null) || 'não consegui falar com o servidor; veja o mostrado quando ele foi iniciado';
    });
  }

  /* ---------- TV scaling and focus ---------- */
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var st = $('stage').style;
    st.transform = st.webkitTransform = 'scale(' + s + ')';
    st.left = Math.round((window.innerWidth - 1920 * s) / 2) + 'px';
    st.top = Math.round((window.innerHeight - 1080 * s) / 2) + 'px';
  }
  function screenEl() { return $(state.screen); }
  function focusables() {
    var list = screenEl().querySelectorAll('.btn, .field');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.hidden || n.offsetParent === null) continue;
      out.push(n);
    }
    return out;
  }
  function setFocus(n) {
    var old = document.querySelector('.f');
    if (old) old.classList.remove('f');
    if (!n) return;
    n.classList.add('f');
    var input = n.tagName === 'INPUT' ? n : n.querySelector('input');
    if (!input && document.activeElement && document.activeElement.tagName === 'INPUT') document.activeElement.blur();
    try { n.scrollIntoView({ block: 'nearest' }); } catch (e) { /* older engines */ }
  }
  function move(dir) {
    var cur = document.querySelector('.f');
    var all = focusables();
    if (!all.length) return;
    if (!cur || all.indexOf(cur) < 0) { setFocus(all[0]); return; }
    var c = cur.getBoundingClientRect();
    var cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    var best = null, bestScore = 1e9;
    all.forEach(function (n) {
      if (n === cur) return;
      var r = n.getBoundingClientRect();
      var dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      var main = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      var cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (main < 4) return;
      var score = main + cross * 2;
      if (score < bestScore) { bestScore = score; best = n; }
    });
    if (best) setFocus(best);
  }
  function show(id) {
    var old = $(state.screen);
    if (old && old.id !== id) { old.classList.remove('show'); old.hidden = true; }
    state.screen = id;
    var n = $(id);
    n.hidden = false;
    void n.offsetWidth;
    n.classList.add('show');
  }

  function onKey(e) {
    var code = e.keyCode;
    var t = e.target;
    var inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (inField) {
      if (code === 13) { e.preventDefault(); t.blur(); focusNext(); return; }
      if (code === 38 || code === 40) { e.preventDefault(); t.blur(); move(code === 38 ? 'up' : 'down'); return; }
      if (code === 27 || code === 10009 || code === 461) { t.blur(); }
      else return; // inside the field, 8 is a plain backspace
    }
    var dirs = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
    if (dirs[code]) { e.preventDefault(); move(dirs[code]); return; }
    if (code === 13) {
      var cur = document.querySelector('.f');
      if (cur) {
        e.preventDefault();
        if (cur.classList.contains('field')) { var i = cur.querySelector('input'); if (i) i.focus(); }
        else cur.click();
      }
      return;
    }
    if (BACK_KEYS.indexOf(code) >= 0) {
      e.preventDefault();
      if (!state.busy && state.back) state.back();
    }
  }
  function focusNext() {
    var all = focusables();
    var cur = document.querySelector('.f');
    var i = all.indexOf(cur);
    if (i >= 0 && all[i + 1]) setFocus(all[i + 1]);
  }

  /* ---------- sheet renderer ---------- */
  function sheet(o) {
    clearInterval(state.timer);
    clearTimeout(state.confirmTimer);
    $('s-title').textContent = o.title || '';
    $('s-title').className = o.tone || '';
    $('s-body').textContent = o.body || '';
    $('s-meta').textContent = o.meta || '';
    var extra = $('s-extra');
    extra.textContent = '';
    if (o.extra) extra.appendChild(o.extra);
    var row = $('s-btns');
    row.textContent = '';
    var first = null;
    (o.buttons || []).forEach(function (b) {
      var n = el('button', 'btn' + (b.cls ? ' ' + b.cls : ''), b.label);
      n.type = 'button';
      n.addEventListener('click', function () { if (!state.busy) b.run(n); });
      row.appendChild(n);
      if (b.focus || !first) first = n;
    });
    row.hidden = !(o.buttons && o.buttons.length);
    state.back = o.back === undefined ? goHome : o.back;
    show('sheet');
    var target = o.focusEl || first;
    if (target) setFocus(target);
  }
  function goHome() {
    state.busy = false;
    refreshPanel();
    show('home');
    setFocus($('b-queue').hidden ? $('b-install') : $('b-queue'));
    state.back = exitScreen;
  }

  /* ---------- end screens (every way out ends with the DNS step) ---------- */
  function stepsList(items) {
    var ol = el('ol', 'steps');
    items.forEach(function (s) {
      var li = el('li', s.cls || '');
      li.appendChild(document.createTextNode(s.text));
      if (s.small) { var sm = el('small', '', s.small); li.appendChild(sm); }
      ol.appendChild(li);
    });
    return ol;
  }
  function exitScreen() {
    sheet({
      title: 'Antes de sair',
      body: 'Volte o DNS da TV para automático.',
      meta: 'Senão a TV fica sem internet se este computador desligar. Em Configurações, Rede, troque o DNS para automático.',
      extra: stepsList([{ text: 'Volte o DNS da TV para automático' }]),
      buttons: [{ label: 'Voltar ao instalador', cls: 'primary', focus: true, run: goHome }],
      back: goHome
    });
  }
  function errorScreen(title, code, retry, res) {
    var untouched = !!UNTOUCHED[code] || (code === 'write' && !!(res && res.unchanged));
    if (!untouched) title = title.replace(/ Nada mudou na sua TV\.$/, '');
    var btns = [];
    if (retry) btns.push({ label: T.retry, cls: 'primary', focus: true, run: retry });
    btns.push({ label: 'Voltar', run: goHome, focus: !retry });
    log('erro', { code: code });
    sheet({
      title: title,
      tone: 'bad',
      body: ERR[code] || 'Algo não saiu como esperado.',
      meta: untouched ? '' : 'Confira a lista e use Restaurar se precisar.',
      extra: stepsList([{ text: 'Volte o DNS da TV para automático', small: 'Os passos terminam aqui, deu certo ou não.' }]),
      buttons: btns
    });
  }

  /* Wait 30 s, re-read the list, then show the exit steps. expect: {present:[entry], gone:[id]} */
  function verifyAfter(title, expect, back) {
    var lis = [
      { text: 'Espere 30 segundos, eu confiro', small: 'Faltam 30 s' },
      { text: 'Volte o DNS da TV para automático', cls: 'wait' },
      { text: 'Tire a TV da tomada por 10 segundos', cls: 'wait' }
    ];
    var steps = stepsList(lis);
    var bar = el('div', 'bar count'); var fill = el('i'); bar.appendChild(fill); fill.style.transform = 'scaleX(0)';
    var box = el('div'); box.appendChild(steps); box.appendChild(bar);
    var btns = [];
    if (back) btns.push({ label: back.label, cls: 'primary', run: function () { location.href = back.href; } });
    btns.push({ label: T.done, run: goHome });
    sheet({ title: T.checkingTitle, body: T.checking, extra: box, buttons: [], back: null });
    state.busy = false;
    var t0 = Date.now();
    var items = steps.children;
    state.timer = setInterval(function () {
      var left = Math.max(0, WAIT_MS - (Date.now() - t0));
      fill.style.transform = 'scaleX(' + (1 - left / WAIT_MS) + ')';
      items[0].querySelector('small').textContent = 'Faltam ' + Math.ceil(left / 1000) + ' s';
      if (left > 0) return;
      clearInterval(state.timer);
      finish();
    }, 300);
    function finish() {
      var r = reg.read();
      var bad = [];
      if (!r.ok) bad.push('não consegui reler a lista');
      else {
        var byId = {};
        r.list.AppInfo.forEach(function (e) { byId[e.Id] = e; });
        (expect.present || []).forEach(function (p) {
          var e = byId[p.Id];
          if (!e || String(e.URL || '').replace(/\s+$/, '') !== String(p.URL || '').replace(/\s+$/, '')) bad.push(p.AppName || p.Id);
        });
        (expect.gone || []).forEach(function (id) { if (byId[id]) bad.push(id); });
      }
      var good = !bad.length;
      log('conferido', { ok: good, count: r.ok ? r.list.AppInfo.length : null });
      bar.hidden = true;
      $('s-title').textContent = good ? title : 'A conferência não bateu';
      $('s-title').className = good ? 'ok' : 'bad';
      items[0].classList.add('done');
      items[0].firstChild.textContent = good ? 'Conferi a lista da TV: tudo certo' : 'Conferi a lista da TV: algo mudou';
      items[0].querySelector('small').textContent = good ? '' : 'A TV mexeu em: ' + bad.join(', ') + '. Use Restaurar se precisar.';
      items[1].classList.remove('wait');
      if (good) items[2].classList.remove('wait');
      else items[2].classList.add('wait');
      $('s-body').textContent = good ? 'Falta só voltar o DNS e reiniciar a TV.' : 'Volte o DNS e confira a lista.';
      var row = $('s-btns');
      row.textContent = '';
      btns.forEach(function (b, i) {
        var n = el('button', 'btn' + (b.cls ? ' ' + b.cls : ''), b.label);
        n.type = 'button';
        n.addEventListener('click', b.run);
        row.appendChild(n);
        if (i === 0) setFocus(n);
      });
      row.hidden = false;
      state.back = goHome;
    }
  }

  /* ---------- registry plumbing ---------- */
  function backupFn(reason) {
    return function (raw, cb) {
      fetch('/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: withoutKey(raw), reason: reason }) })
        .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
        .then(function () { cb(null); }, function (e) { cb(e || new Error('backup')); });
    };
  }
  function applyP(changes, reason, extra) {
    return new Promise(function (resolve) {
      try {
        reg.apply(changes, { backup: backupFn(reason), mode: 'pc', homeNetwork: !!(extra && extra.homeNetwork) }, resolve);
      } catch (e) { resolve({ ok: false, step: 'apply', error: 'write' }); }
    });
  }
  function refreshPanel() {
    var model = callTV('Hisense_GetModelName'), os = callTV('Hisense_GetOSVersion');
    $('p-model').textContent = model || 'não informado';
    $('p-os').textContent = os ? 'VIDAA ' + os : 'VIDAA';
    var r = reg.read();
    var cnt = $('p-count'), ours = $('p-ours');
    cnt.className = ''; ours.className = '';
    if (r.ok) {
      state.count = r.list.AppInfo.length;
      state.ours = r.ours || [];
      cnt.textContent = String(state.count);
      var f = findFmtv();
      ours.textContent = f ? 'Instalado' : 'Ainda não instalado';
      ours.className = f ? 'ok' : '';
      $('b-install').textContent = f ? T.update : T.install;
    } else {
      state.ours = [];
      cnt.textContent = 'não consegui ler';
      cnt.className = 'bad';
      ours.textContent = '-';
    }
    $('b-remove').hidden = !state.ours.length;
    var srv = $('p-server');
    if (state.ping) { srv.textContent = 'Conectado'; srv.className = 'ok'; }
    else { srv.textContent = 'Sem resposta'; srv.className = 'bad'; }
  }
  function callTV(name) {
    try { var v = typeof window[name] === 'function' ? window[name]() : ''; return v == null ? '' : String(typeof v === 'object' ? (v.msg || '') : v); } catch (e) { return ''; }
  }
  function findFmtv() {
    var i, e;
    for (i = 0; i < state.ours.length; i++) {
      e = state.ours[i];
      if (String(e.URL || e.StartCommand || '').indexOf(BASE) === 0) return e;
    }
    return null;
  }

  /* ---------- flows ---------- */
  function installApps(apps, back, reason, opts) {
    state.busy = true;
    var names = apps.map(function (a) { return a.name; }).join(', ');
    sheet({ title: T.working, body: names, extra: (function () { var b = el('div', 'bar idle'); b.appendChild(el('i')); return b; })(), buttons: [], back: null });
    state.busy = true;
    return paint().then(function () {
      return applyP({ install: apps }, reason, opts);
    }).then(function (res) {
      state.busy = false;
      log('install', { ok: !!res.ok, error: res.error || null, apps: apps.map(function (a) { return a.id; }) });
      if (!res.ok) {
        errorScreen(fmt(T.failInstall, { app: names }), res.error, function () { installApps(apps, back, reason, opts); }, res);
        return;
      }
      var present = apps.map(function (a) { return reg.entryFor(a); });
      verifyAfter('Instalado. Já dá para abrir.', { present: present }, back);
    });
  }

  function installFmtv() {
    var f = findFmtv();
    var keep = f && /#k=/.test(f.URL || '') ? String(f.URL).replace(/^[^#]*/, '') : '';
    var app = { id: FMTV.id, name: FMTV.name, url: FMTV.url + keep, icon: FMTV.icon };
    installApps([app], null, 'install-fmtv');
  }

  /* TMDB key: rewrite the FreeMyTV entry with #k= at the end of the address. The key is never logged. */
  function keyScreen() {
    var wrap = el('div');
    var fld = el('div', 'field');
    var lab = el('label', '', 'Chave do TMDB (digite uma vez)');
    var inp = el('input', 'secret'); inp.type = 'text'; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off');
    lab.htmlFor = 'k-in'; inp.id = 'k-in';
    fld.appendChild(lab); fld.appendChild(inp); wrap.appendChild(fld);
    var msg = el('p', 'meta bad');
    wrap.appendChild(msg);
    var has = findFmtv() && /#k=/.test(findFmtv().URL || '');
    sheet({
      title: 'Chave do TMDB',
      body: 'A chave fica só na sua TV. Ela não vai para a internet nem para o código.',
      meta: has ? 'Já existe uma chave guardada. Digitar outra troca a anterior.' : '',
      extra: wrap,
      focusEl: fld,
      buttons: [
        { label: 'Salvar na TV', cls: 'primary', run: function () {
          var k = inp.value.replace(/\s+/g, '');
          if (!/^[A-Za-z0-9._-]{20,600}$/.test(k)) { msg.textContent = 'A chave parece incompleta. Confira e digite de novo.'; setFocus(fld); return; }
          saveKey(k);
        } },
        { label: T.cancel, run: goHome }
      ]
    });
    // the field is focusable as a whole; OK opens the TV keyboard
    fld.addEventListener('click', function () { inp.focus(); });
  }
  function saveKey(k) {
    log('chave', { note: 'k presente' });
    installApps([{ id: FMTV.id, name: FMTV.name, url: FMTV.url + '#k=' + encodeURIComponent(k), icon: FMTV.icon }],
      null, 'tmdb-key');
  }

  /* Confirmation for catalog items and typed links */
  function confirmApps(apps, typed, back, opts, note) {
    var box = el('div', 'list');
    var warn = false;
    apps.forEach(function (a) {
      var it = el('div', 'item');
      it.appendChild(el('b', '', a.name));
      it.appendChild(el('span', '', fmt(T.confirmInstall, { app: a.name, domain: hostOf(a.url) })));
      if (/^http:/i.test(a.url)) { warn = true; it.classList.add('warnbox'); it.appendChild(el('br')); it.appendChild(el('span', 'bad', T.insecure)); }
      box.appendChild(it);
    });
    sheet({
      title: 'Confirmar instalação',
      body: typed ? T.typed : '',
      meta: note || '',
      extra: box,
      buttons: [
        { label: T.confirm, cls: 'primary', focus: true, run: function () { installApps(apps, back, typed ? 'link' : 'queue', opts); } },
        { label: T.cancel, run: goHome }
      ]
    });
  }

  function loadCatalog() {
    if (state.catalog) return Promise.resolve(state.catalog);
    return jget('/store/catalogo.json').then(function (c) { state.catalog = c; return c; });
  }
  function queueIds() {
    var m = /[?&]add=([^&#]*)/.exec(location.search);
    if (!m) return [];
    return decodeURIComponent(m[1]).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function openQueue() {
    var ids = queueIds();
    if (!ids.length) { sheet({ title: T.queueEmpty, buttons: [{ label: 'Voltar', cls: 'primary', run: goHome }] }); return; }
    loadCatalog().then(function (cat) {
      var apps = [], missing = [], blocked = [];
      ids.forEach(function (id) {
        var a = null;
        (cat.apps || []).forEach(function (x) { if (x.id === id) a = x; });
        if (!a) { missing.push(id); return; }
        var app = { id: a.id, name: a.name, url: a.url, icon: BASE + 'store/' + a.icon };
        var c = reg.check(app, { homeNetwork: false });
        if (!c.ok) { blocked.push(a.name); return; }
        apps.push(app);
      });
      if (!apps.length) {
        sheet({ title: T.queueEmpty, tone: 'bad',
          body: missing.length ? 'Não achei no catálogo: ' + missing.join(', ') : 'Nenhum app da fila passou na checagem: ' + blocked.join(', '),
          buttons: [{ label: 'Voltar', cls: 'primary', run: goHome }] });
        return;
      }
      var back = { label: 'Voltar ao Free My TV', href: BASE + '#instalados=' + apps.map(function (a) { return encodeURIComponent(a.id); }).join(',') };
      var note = missing.length ? 'Não achei no catálogo: ' + missing.join(', ') : blocked.length ? 'Fora da lista aprovada: ' + blocked.join(', ') : '';
      confirmApps(apps, false, back, null, note);
    }, function () {
      errorScreen('A Loja ainda não carregou', 'unreadable', openQueue);
    });
  }

  /* Manual link, typed with the TV keyboard */
  function linkScreen() {
    var wrap = el('div');
    function field(id, label, ph) {
      var f = el('div', 'field');
      var l = el('label', '', label); l.htmlFor = id;
      var i = el('input'); i.id = id; i.type = 'text'; i.placeholder = ph || ''; i.spellcheck = false;
      i.setAttribute('autocapitalize', 'off');
      f.appendChild(l); f.appendChild(i); wrap.appendChild(f);
      f.addEventListener('click', function () { i.focus(); });
      return { box: f, input: i };
    }
    var a = field('l-url', 'Endereço do site', 'https://');
    var n = field('l-name', 'Nome do app');
    a.input.value = 'https://';
    var msg = el('p', 'meta bad'); wrap.appendChild(msg);
    sheet({
      title: 'Adicionar por link',
      extra: wrap,
      focusEl: a.box,
      buttons: [
        { label: T.done, cls: 'primary', run: function () {
          var url = a.input.value.trim(), name = n.input.value.trim();
          var u;
          try { u = new URL(url); } catch (e) { u = null; }
          if (!u || !/^https?:$/.test(u.protocol)) { msg.textContent = 'Digite o endereço completo, começando com https://'; setFocus(a.box); return; }
          if (!name) name = u.hostname.replace(/^www\./, '');
          var slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          var id = ('link-' + slug.slice(0, 26)).replace(/-$/, '') + '-' + shortHash(u.href);
          var app = { id: id, name: name, url: u.href, icon: u.protocol === 'https:' ? u.origin + '/favicon.ico' : '' };
          var priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
          var c = reg.check(app, { homeNetwork: priv });
          if (!c.ok) { msg.textContent = ERR[c.reason] || ERR.domain; return; }
          confirmApps([app], true, null, { homeNetwork: priv });
        } },
        { label: T.cancel, run: goHome }
      ]
    });
  }

  /* Remove: pick one of our entries, press OK, then Confirmar remoção within 4 s */
  function removeScreen() {
    var r = reg.read();
    var ours = r.ok ? r.ours : [];
    var box = el('div', 'list');
    var btns = [];
    ours.forEach(function (e) {
      var b = el('button', 'btn'); b.type = 'button';
      var label = el('div', '', e.AppName || e.Title || e.Id);
      var sub = el('span', '', hostOf(e.URL || ''));
      b.appendChild(label); b.appendChild(sub);
      var armed = false;
      b.addEventListener('click', function () {
        if (state.busy) return;
        if (!armed) {
          armed = true;
          label.textContent = T.confirmRemove;
          clearTimeout(state.confirmTimer);
          state.confirmTimer = setTimeout(function () { armed = false; label.textContent = e.AppName || e.Title || e.Id; }, CONFIRM_MS);
          return;
        }
        clearTimeout(state.confirmTimer);
        removeEntry(e);
      });
      box.appendChild(b); btns.push(b);
    });
    sheet({
      title: 'Remover',
      body: ours.length ? 'Só os apps instalados por este instalador aparecem aqui.' : 'Não há apps nossos na lista.',
      extra: ours.length ? box : null,
      buttons: [{ label: 'Voltar', run: goHome, focus: !ours.length }],
      focusEl: btns[0]
    });
  }
  function removeEntry(e) {
    var name = e.AppName || e.Title || e.Id;
    state.busy = true;
    sheet({ title: T.working.replace('Instalando', 'Removendo'), body: name, extra: (function () { var b = el('div', 'bar idle'); b.appendChild(el('i')); return b; })(), buttons: [], back: null });
    state.busy = true;
    paint().then(function () { return applyP({ remove: [e.Id] }, 'remove'); }).then(function (res) {
      state.busy = false;
      log('remove', { ok: !!res.ok, error: res.error || null, id: e.Id });
      if (!res.ok) { errorScreen(fmt(T.failRemove, { app: name }), res.error, null, res); return; }
      verifyAfter(fmt(T.removed, { app: name }), { gone: [e.Id] }, null);
    });
  }

  /* Restore: list copies, show the difference, ask, then write the whole list back */
  function whenText(w) {
    var d = new Date(w);
    return isNaN(d.getTime()) ? String(w || '') : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }
  function restoreScreen() {
    sheet({ title: 'Restaurar', body: 'Procurando as cópias…', buttons: [], back: goHome });
    jget('/backups').then(function (list) {
      if (!Array.isArray(list)) list = list && list.backups || [];
      list = list.slice().sort(function (a, b) { return String(b.file).localeCompare(String(a.file)); });
      if (!list.length) {
        sheet({ title: 'Restaurar', body: 'Ainda não há cópias da lista neste computador.', buttons: [{ label: 'Voltar', cls: 'primary', run: goHome }] });
        return;
      }
      var box = el('div', 'list');
      var first = null;
      list.forEach(function (b) {
        var n = el('button', 'btn'); n.type = 'button';
        n.appendChild(el('div', '', whenText(b.when || b.file)));
        n.appendChild(el('span', '', (b.apps != null ? b.apps + ' apps' : '') + (b.sha256 ? '  ' + String(b.sha256).slice(0, 8) : '')));
        n.addEventListener('click', function () { restoreDiff(b); });
        box.appendChild(n);
        if (!first) first = n;
      });
      sheet({ title: 'Restaurar', body: 'Escolha a cópia da lista de apps. Antes de gravar eu mostro o que muda.', extra: box, focusEl: first,
        buttons: [{ label: 'Voltar', run: goHome }] });
    }, function () {
      errorScreen('Não consegui listar as cópias', 'unreadable', restoreScreen);
    });
  }
  function sha256Hex(text) {
    if (!(window.crypto && crypto.subtle)) return Promise.resolve('');
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }
  function nameOf(x) {
    return typeof x === 'string' ? x : (x && (x.name || x.AppName || x.Title || x.Id || x.id)) || '?';
  }
  function restoreDiff(b) {
    fetch('/backups/' + encodeURIComponent(b.file), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text();
    }).then(function (text) {
      var raw = text;
      var wrapped = false;
      try {
        var j = JSON.parse(text);
        if (j && typeof j.raw === 'string') { raw = j.raw; wrapped = true; }
      } catch (e) { /* the copy is the list itself */ }
      return sha256Hex(raw).then(function (h) {
        var cur = reg.read();
        var d = cur.ok ? reg.diff(cur.raw, raw) : { added: [], removed: [], changed: [] };
        var box = el('div', 'list');
        function section(title, arr, cls) {
          if (!arr || !arr.length) return;
          box.appendChild(el('div', 'difftitle', title));
          box.appendChild(el('div', 'diffline ' + (cls || ''), arr.map(nameOf).join(', ')));
        }
        section('Voltam à lista', d.added, 'ok');
        section('Saem da lista', d.removed, 'bad');
        section('Mudam', d.changed, '');
        var none = !(d.added && d.added.length) && !(d.removed && d.removed.length) && !(d.changed && d.changed.length);
        var meta = T.restoreKey;
        var tampered = !wrapped && !!b.sha256 && !!h && h !== b.sha256;
        if (tampered) meta = 'Esta cópia não passou na conferência e não pode ser restaurada. Escolha outra.';
        else if (!wrapped && b.sha256 && !h) meta += ' Não consegui conferir a soma de verificação desta cópia.';
        sheet({
          title: 'Confirmar restauração',
          body: none ? 'Esta cópia é igual à lista atual.' : 'A lista inteira da TV volta a ser a desta cópia.',
          meta: meta,
          extra: none ? null : box,
          tone: tampered ? 'bad' : '',
          buttons: (tampered ? [] : [{ label: T.confirm, cls: 'primary', focus: true, run: function () { doRestore(raw); } }])
            .concat([{ label: tampered ? 'Voltar' : T.cancel, cls: tampered ? 'primary' : '', focus: tampered, run: restoreScreen }]),
          back: restoreScreen
        });
      });
    }).catch(function () {
      errorScreen('Não consegui abrir a cópia', 'unreadable', function () { restoreDiff(b); });
    });
  }
  function doRestore(raw) {
    state.busy = true;
    sheet({ title: 'Restaurando…', extra: (function () { var b = el('div', 'bar idle'); b.appendChild(el('i')); return b; })(), buttons: [], back: null });
    state.busy = true;
    paint().then(function () {
      return new Promise(function (resolve) {
        try { reg.restore(raw, { backup: backupFn('restore'), mode: 'pc', confirmed: true }, resolve); }
        catch (e) { resolve({ ok: false, error: 'write' }); }
      });
    }).then(function (res) {
      state.busy = false;
      log('restore', { ok: !!res.ok, error: res.error || null });
      if (!res.ok) { errorScreen('Não consegui restaurar. Confira a lista da TV.', res.error, null, res); return; }
      verifyAfter('Lista restaurada.', {}, null);
    });
  }

  /* ---------- start ---------- */
  function bind() {
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', fit);
    var acts = {
      install: installFmtv, queue: openQueue, restore: restoreScreen, key: keyScreen, link: linkScreen, remove: removeScreen
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () { if (!state.busy) acts[b.getAttribute('data-act')](); });
    });
  }

  function startTV() {
    document.body.className = 'tv';
    $('tv').hidden = false;
    fit();
    bind();
    if (!window.FMTVRegistry) {
      sheet({ title: 'Não consegui carregar o instalador', tone: 'bad', body: 'Falta o arquivo de apoio. Reinicie o servidor e abra de novo.',
        buttons: [{ label: T.retry, cls: 'primary', run: function () { location.reload(); } }], back: null });
      return;
    }
    var store = null;
    try { store = window.localStorage; } catch (e) { store = null; }
    reg = window.FMTVRegistry.create({
      request: function (op, p) { return window.HiUtils_createRequest(op, p); },
      storage: store,
      today: function () { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
    });
    var q = queueIds();
    if (q.length) { $('b-queue').textContent = 'Instalar fila (' + q.length + ')'; $('b-queue').hidden = false; }
    jget('/ping').then(function (p) { state.ping = p; }, function () { state.ping = null; }).then(function () {
      log('abriu', { model: callTV('Hisense_GetModelName') });
      goHome();
    });
  }

  if (isTV && !/[?&]pc=1\b/.test(location.search)) startTV();
  else showPc();
})();
