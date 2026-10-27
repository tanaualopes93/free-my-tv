/*
 * The Store: a layer of the home screen where the TV's apps are found, installed and removed (VIDAA only).
 * window.FMTVStore.open({onClose, launch(app, done), pin(app), pinned(id), focusRestore}), .close(), .isOpen().
 * Needs window.FMTVRegistry (registry.js) for the TV's app list. If the page can read it, apps are installed straight
 * from here (mode A); if not, they wait in a queue and are installed from the computer (mode B).
 * Chrome 111, no libraries. Texts come from window.FMTV_STRINGS (strings.json), the catalogue from catalogo.json.
 */
(function () {
  'use strict';

  const KEY = {left: 37, up: 38, right: 39, down: 40, ok: 13, done: 65376, cancel: 65385};
  const BACK = {8: 1, 27: 1, 461: 1, 10009: 1};   // Back is still unmeasured on the real TV; 8 never counts inside a field
  const LS = {catalog: 'fmtv.store.catalog', queue: 'fmtv.store.queue', installed: 'fmtv.store.installed', seen: 'fmtv.store.seen'};
  const PING = 'https://vidaahub.com/ping';
  const INSTALLER = 'https://vidaahub.com/?add=';
  const NS = 'http://www.w3.org/2000/svg';
  const ICON = {
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
    chevron: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'
  };

  // Layout (px on the 1920 × 1080 stage)
  const X0 = 80, COL = 320, GAP = 40, PER_ROW = 5;
  const HERO_H = 240, HERO_GAP = 56, GRID_H = 180, ROW_GAP = 42, Q_H = 96;
  const BASE_Y = 280;

  const script = document.currentScript;
  const BASE = script && script.src ? script.src.replace(/[?#].*$/, '').replace(/[^/]*$/, '') : 'store/';

  const S = {
    open: false, built: false, host: {}, root: null, zone: 'body', tab: 'featured', hi: 0, tabs: [], panes: {}, fnode: null,
    cat: null, catText: '', net: 'pending', fetching: false, view: 'loading', st: null, modeA: false, reg: null, queue: [], timers: {}
  };
  const LOADED = new Set();   // logos already seen: a redraw shows them at once
  let D = null;   // the app sheet in view
  let L = null;   // add by link
  let Q = null;   // install from the computer

  // MARK: - Small helpers

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function svg(path, parent) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '24');
    s.setAttribute('height', '24');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    if (parent) parent.appendChild(s);
    return s;
  }
  function px(n) { return n + 'px'; }
  function setClass(e, c, on) { if (e) e.classList.toggle(c, !!on); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* full or blocked: the Store works without it */ } }
  function lsList(k) {
    const raw = lsGet(k);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.map(String);
    } catch (e) { /* not JSON: "a,b" */ }
    return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function later(ms, fn) { return setTimeout(fn, ms); }
  /** Each step gives the screen a turn: paint first, then work. */
  function yieldTo(fn) { requestAnimationFrame(function () { setTimeout(fn, 0); }); }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  // MARK: - Texts

  let stringsWait = null;
  function lang() {
    const tv = window.TV && typeof window.TV.lang === 'string' ? window.TV.lang : '';
    return /^pt/i.test(tv || document.documentElement.lang || navigator.language || 'pt') ? 'pt' : 'en';
  }
  function say(key, vars) {
    let t;
    const all = window.FMTV_STRINGS;
    if (all) {
      const l = all[lang()];
      t = l && l[key];
      if (t == null && all.en) t = all.en[key];
      if (t == null && all.pt) t = all.pt[key];
    }
    if (t == null && window.TV && typeof window.TV.say === 'function') t = window.TV.say(key, vars);
    if (t == null) t = key;
    return vars ? String(t).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : t;
  }
  function ensureStrings(cb) {
    if (window.FMTV_STRINGS) { cb(); return; }
    if (stringsWait) { stringsWait.push(cb); return; }
    stringsWait = [cb];
    const flush = function () { const w = stringsWait; stringsWait = null; w.forEach(function (f) { f(); }); };
    fetch(BASE + 'strings.json').then(function (r) { return r.json(); }).then(function (j) {
      if (!window.FMTV_STRINGS) window.FMTV_STRINGS = j;
      flush();
    }).catch(flush);
  }

  // MARK: - Colors

  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [58, 61, 69];
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  function gradient(hex) {
    const c = rgb(hex), d = c.map(function (v) { return Math.round(v * 0.68); });
    return 'linear-gradient(135deg, rgb(' + c.join(',') + '), rgb(' + d.join(',') + '))';
  }
  function isLight(hex) { const c = rgb(hex); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.72; }

  // MARK: - Catalogue

  function normalize(j) {
    if (!j || !Array.isArray(j.apps)) return null;
    const cats = {};
    (j.categories || []).forEach(function (c) { cats[c.id] = c.name || {}; });
    const apps = j.apps.filter(function (a) { return a && a.id && a.name && a.url; }).map(function (a) {
      let icon = '';
      try { icon = a.icon ? new URL(a.icon, BASE).href : ''; } catch (e) { icon = ''; }
      return {
        id: String(a.id), name: String(a.name), url: String(a.url), iconUrl: icon, color: a.color || '#3A3D45',
        category: a.category || '', desc: a.desc || {}, site: a.site || '', paid: a.paid || 'free',
        http: !!a.http || /^http:/i.test(a.url), featured: !!a.featured, order: a.order || 0, custom: false
      };
    });
    apps.sort(function (a, b) { return a.order - b.order; });
    return {apps: apps, cats: cats};
  }
  function catName(app) {
    const n = S.cat && S.cat.cats[app.category];
    return n ? (n[lang()] || n.pt || n.en || '') : '';
  }
  function descOf(app) { return app.desc && (app.desc[lang()] || app.desc.pt || app.desc.en) || ''; }

  function loadCatalog() {
    if (S.fetching) return;
    S.fetching = true;
    fetch(BASE + 'catalogo.json', {cache: 'no-cache'}).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text();
    }).then(function (t) {
      const cat = normalize(JSON.parse(t));
      if (!cat) throw new Error('catalogue');
      S.fetching = false;
      S.net = 'ok';
      if (t !== S.catText) {
        S.catText = t;
        S.cat = cat;
        lsSet(LS.catalog, t);
        renderHead();
        rebuildPanes();
      }
      updateView();
    }).catch(function () {
      S.fetching = false;
      S.net = navigator.onLine === false ? 'offline' : 'error';
      updateView();
    });
  }
  function loadCachedCatalog() {
    if (S.cat) return;
    const t = lsGet(LS.catalog);
    if (!t) return;
    try {
      const cat = normalize(JSON.parse(t));
      if (cat) { S.cat = cat; S.catText = t; }
    } catch (e) { /* bad copy: the fetch replaces it */ }
  }

  // MARK: - The TV's list (registry) and what is installed

  function makeRegistry() {
    if (S.reg || !window.FMTVRegistry) return;
    try {
      S.reg = window.FMTVRegistry.create({
        storage: (function () { try { return window.localStorage; } catch (e) { return null; } })(),
        today: function () { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
      });
    } catch (e) { S.reg = null; }
  }
  function prefix() { return (S.reg && S.reg.PREFIX) || 'fmtv_'; }

  function readState() {
    const st = {readable: false, ours: {}, tv: {}, installedB: lsList(LS.installed)};
    try {
      const p = S.reg && S.reg.probe();
      if (p && p.readable) {
        const r = S.reg.read();
        if (r && r.ok) {
          st.readable = true;
          const list = (r.list && r.list.AppInfo) || [];
          list.forEach(function (e) {
            const id = String(e.Id || '');
            if (id.indexOf(prefix()) === 0) st.ours[id.slice(prefix().length)] = e;
            else if (id !== 'FreeMyTV') {
              const h = hostOf(e.URL || String(e.StartCommand || '').trim());
              if (h) st.tv[h] = e;
            }
          });
        }
      }
    } catch (e) { st.readable = false; }
    return st;
  }
  function refreshState() {
    makeRegistry();
    S.st = readState();
    S.modeA = S.st.readable;
    S.queue = lsList(LS.queue).filter(function (id) { return S.st.installedB.indexOf(id) < 0; });
  }
  /** Without the TV's list and without storage there is nothing to remember: no check marks, no Installed tab. */
  function tracking() {
    if (S.modeA) return true;
    try { window.localStorage.setItem('fmtv.store.probe', '1'); window.localStorage.removeItem('fmtv.store.probe'); return true; } catch (e) { return false; }
  }

  /** available | installed | tv (came with the TV's own store) | queued */
  function stateOf(app) {
    const st = S.st;
    if (S.modeA) {
      if (st.ours[app.id]) return {kind: 'installed', removable: true};
    } else if (st.installedB.indexOf(app.id) >= 0) return {kind: 'installed', removable: false};
    if (!app.custom && st.tv[hostOf(app.url)]) return {kind: 'tv', removable: false};
    if (S.queue.indexOf(app.id) >= 0) return {kind: 'queued', removable: false};
    return {kind: 'available', removable: false};
  }

  /** The registry only takes https icons; an http site's favicon stays on screen only. */
  function regApp(app) { return {id: app.id, name: app.name, url: app.url, icon: /^https:/i.test(app.iconUrl || '') ? app.iconUrl : ''}; }

  function installedApps() {
    const out = [], seen = {};
    const add = function (app) { if (!seen[app.id]) { seen[app.id] = 1; out.push(app); } };
    const byId = {};
    S.cat.apps.forEach(function (a) { byId[a.id] = a; });
    if (S.modeA) {
      Object.keys(S.st.ours).forEach(function (id) {
        if (byId[id]) { add(byId[id]); return; }
        const e = S.st.ours[id], url = String(e.URL || e.StartCommand || '').trim();
        add({id: id, name: e.AppName || e.Title || id, url: url, iconUrl: /^https?:/i.test(e.IconURL || '') ? e.IconURL : '', color: '#3A3D45',
          category: '', desc: {}, site: '', paid: 'free', http: /^http:/i.test(url), featured: false, order: 999, custom: true});
      });
    } else {
      S.st.installedB.forEach(function (id) { if (byId[id]) add(byId[id]); });
    }
    S.cat.apps.forEach(function (a) { if (S.st.tv[hostOf(a.url)]) add(a); });
    return out;
  }

  // MARK: - Faces: the brand color first, the logo comes in by opacity

  function makeFace(app, w, h, kind, parent) {
    const f = el('div', 'st-face ' + (kind.indexOf('hero') === 0 ? 'hero' : ''), parent);
    f.style.background = gradient(app.color);
    if (isLight(app.color)) f.classList.add('lightface');
    let word = null;
    if (kind.indexOf('hero') !== 0) word = el('span', 'st-word', f, app.name);
    if (app.iconUrl) {
      const size = {grid: 100, 'hero-wide': 156, 'hero-tall': 120, detail: 150, prev: 52}[kind] || 100;
      const img = new Image();
      img.className = 'st-logo';
      img.alt = '';
      img.decoding = 'async';
      img.style.width = img.style.height = px(size);
      img.style.borderRadius = px(Math.round(size * 0.22));
      img.style.left = kind === 'hero-wide' ? px(44) : px(Math.round((w - size) / 2));
      img.style.top = kind === 'hero-tall' ? px(34) : px(Math.round((h - size) / 2) + (kind === 'grid' ? 14 : 0));
      img.onload = function () { LOADED.add(app.iconUrl); img.classList.add('ready'); if (word) word.classList.add('off'); };
      if (LOADED.has(app.iconUrl)) { img.classList.add('ready'); if (word) word.classList.add('off'); }
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = app.iconUrl;
      f.appendChild(img);
    }
    return f;
  }

  function seal(face) { const s = el('div', 'st-seal', face); svg(ICON.check, s); }

  // MARK: - Panes (one per tab): rows of cards

  function heroItems() { return S.cat.apps.filter(function (a) { return a.featured; }).slice(0, 3); }
  function appsFor(tab) {
    const apps = S.cat.apps;
    if (tab === 'iptv') return apps.filter(function (a) { return a.category === 'iptv'; });
    if (tab === 'video') return apps.filter(function (a) { return a.category === 'video-musica'; });
    if (tab === 'installed') return installedApps();
    const hero = heroItems();
    return apps.filter(function (a) { return a.category === 'destaques' && hero.indexOf(a) < 0; });
  }

  function buildPane(tab) {
    const p = {tab: tab, rows: [], pos: {r: 0, c: 0}, base: tab === 'iptv' ? BASE_Y + 50 : BASE_Y, el: null, rowsEl: null, empty: false};
    p.el = el('div', 'st-pane', S.bodyEl);
    p.rowsEl = el('div', 'st-rows', p.el);
    let y = p.base;
    const hero = tab === 'featured' ? heroItems() : [];
    if (hero.length) {
      const row = newRow(p, y, HERO_H);
      const widths = hero.length === 1 ? [1760] : hero.length === 2 ? [860, 860] : [1040, COL, COL];
      let x = X0;
      hero.forEach(function (app, i) {
        row.items.push(heroCard(row, app, x, widths[i], widths[i] > COL));
        x += widths[i] + GAP;
      });
      y += HERO_H + HERO_GAP;
    }
    if (tab === 'installed' && !S.modeA) {
      if (S.queue.length) {
        const row = newRow(p, y, Q_H);
        row.items.push(queueCard(row));
        y += Q_H + ROW_GAP;
      } else {
        el('div', 'st-text', p.rowsEl, say('queue_empty')).style.top = px(y);
        y += 80;
      }
    }
    const apps = appsFor(tab);
    for (let i = 0; i < apps.length; i += PER_ROW) {
      const row = newRow(p, y, GRID_H + 44);
      apps.slice(i, i + PER_ROW).forEach(function (app, j) {
        row.items.push(gridCard(row, app, X0 + j * (COL + GAP), COL, GRID_H));
      });
      y += GRID_H + 44 + ROW_GAP;
    }
    if (tab !== 'installed') {   // a small shelf is never a dead end: the way to add any site is right under it
      const row = newRow(p, y, Q_H);
      row.items.push(linkCard(row));
    }
    if (tab === 'installed' && !apps.length) el('div', 'st-text', p.rowsEl, say('installed_empty')).style.top = px(y + 10);
    return p;
  }

  function newRow(p, y, h) {
    const e = el('div', 'st-row', p.rowsEl);
    e.style.top = px(y);
    e.style.height = px(h);
    const row = {y: y, h: h, el: e, items: []};
    p.rows.push(row);
    return row;
  }

  function cardShell(row, x, w, h, cls, nameText) {
    const c = el('div', 'st-card ' + cls, row.el);
    c.style.left = px(x);
    c.style.top = '0px';
    c.style.width = px(w);
    c.style.height = px(h + 44);
    const lift = el('div', 'st-lift', c);
    lift.style.width = px(w);
    lift.style.height = px(h);
    if (nameText != null) {
      const n = el('div', 'st-name', c, nameText);
      n.style.top = px(h + 14);
    }
    return {c: c, lift: lift};
  }

  function decorate(face, state) {
    if (state.kind === 'installed' || state.kind === 'tv') seal(face);
    else if (state.kind === 'queued') el('div', 'st-flag', face, say('state_queued'));
  }

  function gridCard(row, app, x, w, h) {
    const state = stateOf(app);
    const sh = cardShell(row, x, w, h, 'grid', app.name);
    const face = makeFace(app, w, h, 'grid', sh.lift);
    decorate(face, state);
    const item = {app: app, state: state, x: x, w: w, node: sh.c};
    wireClick(sh.c, item);
    return item;
  }

  function heroCard(row, app, x, w, wide) {
    const state = stateOf(app);
    const sh = cardShell(row, x, w, HERO_H, 'hero', null);
    const face = makeFace(app, w, HERO_H, wide ? 'hero-wide' : 'hero-tall', sh.lift);
    if (wide) {
      const t = el('div', 'st-hero-text', face);
      el('div', 'st-hero-name', t, app.name);
      el('div', 'st-hero-desc', t, descOf(app));
    } else {
      el('div', 'st-hero-tall', face, app.name);
    }
    decorate(face, state);
    const item = {app: app, state: state, x: x, w: w, node: sh.c};
    wireClick(sh.c, item);
    return item;
  }

  function queueCard(row) {
    const c = el('div', 'st-card st-qrow', row.el);
    c.style.left = px(X0);
    c.style.top = '0px';
    c.style.width = px(1760);
    const lift = el('div', 'st-lift', c);
    const face = el('div', 'st-face', lift);
    el('div', 't', face, say('queue_row', {n: S.queue.length}));
    el('div', 's', face, say('queue_row_sub'));
    svg(ICON.chevron, face);
    const item = {queue: true, x: X0, w: 1760, node: c};
    c.addEventListener('click', function () { focusItem(item); activate(); });
    return item;
  }

  /** The "Add by link" row under a short list: the same shape as the queue row. */
  function linkCard(row) {
    const c = el('div', 'st-card st-qrow st-linkrow', row.el);
    c.style.left = px(X0);
    c.style.top = '0px';
    c.style.width = px(1760);
    const lift = el('div', 'st-lift', c);
    const face = el('div', 'st-face', lift);
    el('div', 't', face, say('add_link'));
    el('div', 's', face, say('link_cta_sub'));
    svg(ICON.chevron, face);
    const item = {link: true, x: X0, w: 1760, node: c};
    c.addEventListener('click', function () { focusItem(item); activate(); });
    return item;
  }

  function wireClick(node, item) { node.addEventListener('click', function () { focusItem(item); activate(); }); }

  function focusItem(item) {
    const p = pane();
    if (!p) return;
    for (let r = 0; r < p.rows.length; r++) {
      const c = p.rows[r].items.indexOf(item);
      if (c >= 0) { p.pos.r = r; p.pos.c = c; S.zone = 'body'; paint(); return; }
    }
  }

  function pane() { return S.panes[S.tab] || null; }

  function rebuildPanes() {
    if (!S.bodyEl) return;
    Object.keys(S.panes).forEach(function (t) {
      const old = S.panes[t];
      if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
    });
    const keep = {};
    Object.keys(S.panes).forEach(function (t) { keep[t] = S.panes[t].pos; });
    S.panes = {};
    S.fnode = null;
    if (S.cat && S.st) {
      S.panes[S.tab] = buildPane(S.tab);
      const p = S.panes[S.tab], pos = keep[S.tab] || {r: 0, c: 0};
      p.pos.r = Math.max(0, Math.min(pos.r, p.rows.length - 1));
      p.pos.c = p.rows.length ? Math.max(0, Math.min(pos.c, p.rows[p.pos.r].items.length - 1)) : 0;
      p.el.classList.add('on');
    }
    paint();
  }

  // MARK: - Focus and scrolling

  function paint() {
    if (!S.root) return;
    if (S.fnode) S.fnode.classList.remove('focus');
    let n = null;
    const p = pane();
    if (S.zone === 'head') n = S.hi < S.tabs.length ? S.tabNodes[S.hi] : S.roundNode;   // under a sheet no ring shows
    else if (S.zone === 'body') {
      if (p && p.rows.length) n = p.rows[p.pos.r].items[p.pos.c].node;
      else if (S.retryNode && S.view === 'nocat') n = S.retryNode;
    }
    if (n) n.classList.add('focus');
    S.fnode = n;
    if (S.zone === 'head' || S.zone === 'body') scroll();
  }

  /** The focused row always sits at the same height; the rows above it fade out. Header focus shows everything. */
  function scroll() {
    const p = pane();
    if (!p || !p.rows.length) return;
    const r = S.zone === 'body' ? p.pos.r : -1;
    const ty = r >= 0 ? p.base - p.rows[r].y : 0;
    p.rowsEl.style.transform = 'translateY(' + ty + 'px)';
    for (let i = 0; i < p.rows.length; i++) setClass(p.rows[i].el, 'gone', r >= 0 && i < r && ty < 0);
  }

  function bodyMove(dx, dy) {
    const p = pane();
    if (!p || !p.rows.length) { if (dy < 0) enterHead(); return; }
    const pos = p.pos, row = p.rows[pos.r];
    if (dx) {
      const c = pos.c + dx;
      if (c >= 0 && c < row.items.length) { pos.c = c; paint(); }
      return;
    }
    if (dy < 0 && pos.r === 0) { enterHead(); return; }
    const r = pos.r + dy;
    if (r < 0 || r >= p.rows.length) return;
    const cur = row.items[pos.c], mid = cur.x + cur.w / 2;
    let best = 0, bd = 1e9;
    p.rows[r].items.forEach(function (it, i) {
      const d = Math.abs(it.x + it.w / 2 - mid);
      if (d < bd) { bd = d; best = i; }
    });
    pos.r = r;
    pos.c = best;
    paint();
  }

  function enterHead() {
    S.zone = 'head';
    S.hi = Math.max(0, S.tabs.indexOf(S.tab));
    paint();
  }
  function enterBody() {
    const p = pane();
    if (p && p.rows.length || (S.retryNode && S.view === 'nocat')) { S.zone = 'body'; paint(); }
  }

  function headMove(dx) {
    const i = Math.max(0, Math.min(S.tabs.length, S.hi + dx));
    if (i === S.hi) return;
    S.hi = i;
    if (i < S.tabs.length) selectTab(S.tabs[i]);
    paint();
  }

  function selectTab(tab) {
    if (tab === S.tab && S.panes[tab]) return;
    const old = S.panes[S.tab];
    if (old) old.el.classList.remove('on');
    S.tab = tab;
    if (S.cat && S.st && !S.panes[tab]) S.panes[tab] = buildPane(tab);
    const p = S.panes[tab];
    if (p) p.el.classList.add('on');
    S.tabNodes.forEach(function (n, i) { setClass(n, 'on', S.tabs[i] === tab); });
    setClass(S.noticeEl, 'on', tab === 'iptv');
  }

  // MARK: - Page states: loading blocks, no internet, catalogue not loaded

  function updateView() {
    if (!S.root) return;
    const v = S.cat ? 'ok' : S.net === 'pending' ? 'loading' : S.net === 'offline' ? 'offline' : 'nocat';
    if (v === S.view && S.stateEl.firstChild) return;
    S.view = v;
    S.stateEl.innerHTML = '';
    S.retryNode = null;
    clearInterval(S.timers.clock);
    if (v === 'loading') {
      for (let i = 0; i < PER_ROW; i++) { const b = el('div', 'st-block', S.stateEl); b.style.left = px(X0 + i * (COL + GAP)); }
    } else if (v === 'offline') {
      const clock = el('div', 'st-clock', S.stateEl);
      const t = el('span', '', clock), d = el('span', 'date', clock);
      const tick = function () {
        const now = new Date();
        t.textContent = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
        d.textContent = now.toLocaleDateString(lang() === 'pt' ? 'pt-BR' : 'en-US', {weekday: 'long', day: 'numeric', month: 'long'});
      };
      tick();
      S.timers.clock = setInterval(tick, 15000);
      el('div', 'st-line', S.stateEl, say('offline'));
    } else if (v === 'nocat') {
      el('div', 'st-line', S.stateEl, say('no_catalog')).style.top = px(330);
      const b = el('div', 'st-btn solo', S.stateEl);
      el('span', 'lab', b, say('retry'));
      b.style.top = px(420);
      b.addEventListener('click', retryNow);
      S.retryNode = b;
    }
    setClass(S.stateEl, 'on', v !== 'ok');
    S.bodyEl.style.visibility = v === 'ok' ? '' : 'hidden';
    if (v === 'ok') {
      if (!S.panes[S.tab]) selectTabForce();
    }
    paint();
  }
  function selectTabForce() {
    const t = S.tab;
    S.panes[t] = buildPane(t);
    S.panes[t].el.classList.add('on');
  }
  function retryNow() { S.net = 'pending'; updateView(); loadCatalog(); }

  // MARK: - Root DOM (built once)

  function build() {
    if (S.built) return;
    const stage = document.getElementById('stage') || document.body;
    const root = el('div', '', stage);
    root.id = 'store';
    S.root = root;
    el('div', 'st-bg', root);
    S.bodyEl = el('div', 'st-body', root);
    S.stateEl = el('div', 'st-state', root);
    el('h1', 'st-title', root, say('store_title'));
    S.tabsEl = el('div', 'st-tabs', root);
    S.noticeEl = el('div', 'st-notice', root, say('iptv_notice'));
    const round = el('div', 'st-round', root);
    svg(ICON.link, round);
    el('span', 'tip', round, say('add_link'));
    round.addEventListener('click', function () { S.zone = 'head'; S.hi = S.tabs.length; paint(); activate(); });
    S.roundNode = round;
    S.dSheet = el('div', 'st-sheet', root);
    S.dSheet.id = 'st-detail';
    S.dBox = el('div', 'st-box', S.dSheet);
    S.lSheet = el('div', 'st-sheet', root);
    S.lSheet.id = 'st-link';
    S.lBox = el('div', 'st-box', S.lSheet);
    S.qSheet = el('div', 'st-sheet', root);
    S.qSheet.id = 'st-queue';
    S.qBox = el('div', 'st-box', S.qSheet);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('online', function () { if (S.open && !S.cat) retryNow(); });
    S.built = true;
  }

  function renderHead() {
    if (!S.tabsEl) return;   // the catalogue can arrive before the first open
    // the IPTV tab only exists while the catalogue has an approved player in it: no dead end
    S.tabs = ['featured'];
    if (S.cat && S.cat.apps.some(function (a) { return a.category === 'iptv'; })) S.tabs.push('iptv');
    S.tabs.push('video');
    if (tracking()) S.tabs.push('installed');
    const names = {featured: 'tab_featured', iptv: 'tab_iptv', video: 'tab_video', installed: 'tab_installed'};
    S.tabsEl.innerHTML = '';
    S.tabNodes = S.tabs.map(function (t, i) {
      const n = el('div', 'st-tab', S.tabsEl);
      el('span', '', n, say(names[t]));
      n.addEventListener('click', function () { S.zone = 'head'; S.hi = i; selectTab(t); paint(); enterBody(); });
      return n;
    });
    if (S.tabs.indexOf(S.tab) < 0) { S.tab = 'featured'; S.hi = 0; }
    S.hi = Math.min(S.hi, S.tabs.length);
    S.tabNodes.forEach(function (n, i) { setClass(n, 'on', S.tabs[i] === S.tab); });
    setClass(S.noticeEl, 'on', S.tab === 'iptv');
  }

  // MARK: - Open and close

  function open(opts) {
    if (S.open) return;
    S.open = true;
    S.host = opts || {};
    try { performance.mark('fmtv-store-open'); } catch (e) { /* no marks */ }
    ensureStrings(function () {
      if (!S.open) return;
      build();
      loadCachedCatalog();
      refreshState();
      renderHead();
      S.view = '';
      rebuildPanes();
      updateView();
      S.zone = 'body';
      const p = pane();
      if (!p || !p.rows.length) { S.zone = 'head'; S.hi = Math.max(0, S.tabs.indexOf(S.tab)); }
      paint();
      S.root.classList.add('open');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          try { performance.mark('fmtv-store-ready'); } catch (e) { /* no marks */ }
        });
      });
      loadCatalog();
      S.timers.retry = setInterval(function () { if (S.open && !S.cat) loadCatalog(); }, 8000);
    });
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    clearInterval(S.timers.retry);
    clearInterval(S.timers.clock);
    if (D) { clearTimers(D); D = null; }
    L = null;
    Q = null;
    if (S.root) {
      S.root.classList.remove('open');
      [S.dSheet, S.lSheet, S.qSheet].forEach(function (s) { s.classList.remove('open'); });
      S.view = '';
    }
    const h = S.host || {};
    try { if (typeof h.onClose === 'function') h.onClose(); } catch (e) { /* the caller's problem */ }
    try { if (typeof h.focusRestore === 'function') h.focusRestore(); } catch (e) { /* idem */ }
  }

  // MARK: - Keys (captured: the home screen sleeps while the Store is open)

  function onKey(e) {
    if (!S.open) return;
    const k = e.keyCode;
    const f = document.activeElement;
    const inField = !!(f && f.tagName === 'INPUT' && S.root.contains(f));
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (inField) { fieldKey(k, e, f); return; }
    let handled = true;
    if (k === KEY.left || k === KEY.right) arrow(k === KEY.left ? -1 : 1, 0);
    else if (k === KEY.up || k === KEY.down) arrow(0, k === KEY.up ? -1 : 1);
    else if (k === KEY.ok) activate();
    else if (BACK[k]) back();
    else handled = false;
    if (handled) e.preventDefault();
  }

  function arrow(dx, dy) {
    if (S.zone === 'head') {
      if (dx) headMove(dx);
      else if (dy > 0) enterBody();
    } else if (S.zone === 'body') bodyMove(dx, dy);
    else if (S.zone === 'detail') { if (dx) detailMove(dx); }
    else if (S.zone === 'link') { if (dy) linkMove(dy); else linkMove(dx, true); }
  }

  function activate() {
    if (S.zone === 'head') {
      if (S.hi >= S.tabs.length) openLink();
      else enterBody();
    } else if (S.zone === 'body') {
      const p = pane();
      if (p && p.rows.length) {
        const it = p.rows[p.pos.r].items[p.pos.c];
        if (it.queue) openQueue();
        else if (it.link) openLink();
        else openDetail({app: it.app}, {});
      } else if (S.retryNode && S.view === 'nocat') retryNow();
    } else if (S.zone === 'detail') detailActivate();
    else if (S.zone === 'link') linkActivate();
    else if (S.zone === 'queue') queueActivate();
  }

  function back() {
    if (S.zone === 'detail') {
      if (D && D.mode === 'busy') return;
      if (D && D.fromLink && D.mode === 'confirm') { closeDetail(); openLink(true); return; }
      closeDetail();
    } else if (S.zone === 'link') closeLink();
    else if (S.zone === 'queue') closeQueue();
    else close();
  }

  // MARK: - App sheet

  function clearTimers(d) { clearTimeout(d.rmTimer); clearTimeout(d.guard); clearTimeout(d.openGuard); }

  function openDetail(item, opts) {
    D = {app: item.app, mode: opts.mode || 'view', bi: 0, msg: null, typed: !!opts.typed, fromLink: !!opts.fromLink, opening: false, rmArm: false, plan: null, step: 0};
    if (D.mode === 'confirm') D.plan = dry(D.app);
    S.prevZone = S.zone === 'link' ? 'body' : S.zone;
    S.zone = 'detail';
    renderDetail();
    S.dSheet.classList.add('open');
    paint();
  }

  function closeDetail() {
    if (D) clearTimers(D);
    D = null;
    S.dSheet.classList.remove('open');
    S.zone = S.prevZone || 'body';
    refreshState();
    rebuildPanes();
  }

  function dry(app) {
    try {
      if (!S.reg || !S.modeA) return null;
      const ck = S.reg.check(regApp(app), {homeNetwork: true});
      if (ck && !ck.ok) return {ok: false, add: [], update: [], remove: []};
      return S.reg.plan({install: [regApp(app)]}, {homeNetwork: true});
    } catch (e) { return {ok: false, add: [], update: [], remove: []}; }
  }

  function seenIds() { return lsList(LS.seen); }

  /** The "appears after unplugging" strip: only for an installed app that is not on the shelf yet. */
  function unplugNeeded(st) { return D.mode === 'view' && st.kind === 'installed' && !D.pinned && seenIds().indexOf(D.app.id) < 0; }

  function buttonsFor() {
    const app = D.app, st = stateOf(app), b = [];
    const canPin = typeof S.host.pin === 'function' && tracking();
    const pinned = D.pinned;
    if (D.mode === 'busy') return [{id: 'busy', busy: true}];
    if (D.mode === 'error') return [{id: 'retry', label: say('retry'), run: retryFailed}];
    if (D.mode === 'confirm') {
      return D.plan && D.plan.ok === false ? [{id: 'cancel', label: say('btn_cancel'), run: cancelConfirm}] :
        [{id: 'confirm', label: say('btn_confirm'), run: runInstall}, {id: 'cancel', label: say('btn_cancel'), ghost: true, run: cancelConfirm}];
    }
    if (st.kind === 'available' || st.kind === 'queued') {
      if (S.modeA) b.push({id: 'install', label: say('btn_install'), run: startConfirm});
      else b.push({id: 'queue', label: say(st.kind === 'queued' ? 'queue_in' : 'queue_put'), run: toggleQueue, check: st.kind === 'queued'});
      return b;
    }
    b.push({id: 'open', label: D.opening ? say('opening') : say('btn_open'), run: doOpen});
    if (canPin && !pinned) b.push({id: 'pin', label: say('btn_pin'), run: doPin});
    if (st.removable) b.push({id: 'remove', label: D.rmArm ? say('remove_confirm') : say('btn_remove'), armed: D.rmArm, ghost: !D.rmArm, run: doRemove});
    if (unplugNeeded(st)) b.push({id: 'seen', label: say('unplug_btn'), link: true, run: markSeen});
    return b;
  }

  function renderDetail() {
    const d = D, app = d.app, st = stateOf(app);
    // the host joins the shelf after it reads the list again, so a pin just made counts at once
    d.pinned = !!d.justPinned || (typeof S.host.pinned === 'function' && !!S.host.pinned(app.id));
    const box = S.dBox;
    box.innerHTML = '';
    box.className = 'st-box' + (d.mode === 'confirm' ? ' confirm' : '');
    const glow = el('div', 'st-glow', box);
    const c = rgb(app.color);
    glow.style.background = 'radial-gradient(circle at 18% 0%, rgba(' + c.join(',') + ',0.75), rgba(' + c.join(',') + ',0) 62%)';
    const unnamed = app.custom && app.name === hostOf(app.url);
    const fw = el('div', 'st-d-face', box);
    makeFace(unnamed ? Object.assign({}, app, {name: ''}) : app, 400, 225, 'detail', fw);

    const chip = el('div', 'st-chip', box);
    let chipText = say('state_' + (st.kind === 'queued' ? 'queued' : st.kind === 'tv' ? 'tv' : st.kind === 'installed' ? 'installed' : 'available'));
    if (d.mode === 'error') { chipText = say('state_failed'); chip.classList.add('bad'); }
    else if (st.kind === 'installed' || st.kind === 'tv') svg(ICON.check, chip);
    if (d.pinned && d.mode !== 'error') chipText += ' · ' + say('on_shelf');
    chip.appendChild(document.createTextNode(chipText));

    el('div', 'st-d-name', box, unnamed ? say('unnamed_site') : app.name);
    const meta = [catName(app), app.custom ? '' : say('paid_' + app.paid), hostOf(app.url)].filter(Boolean);
    el('div', 'st-d-meta', box, meta.join(' · '));
    el('div', 'st-d-desc', box, descOf(app));

    const note = el('div', 'st-d-note', box);
    notesFor(st).forEach(function (n) {
      const p = el('p', n.k || '', note);
      if (n.host) {   // typed address: one short sentence, the host big on its own line
        p.className = 'lead';
        p.textContent = say('confirm_install_link_lead');
        el('span', 'host', note, hostOf(app.url));
      } else if (n.dom) {
        const parts = say('confirm_install', {app: app.name, domain: '\u0001'}).split('\u0001');
        p.appendChild(document.createTextNode(parts[0]));
        el('strong', '', p, hostOf(app.url));
        p.appendChild(document.createTextNode(parts[1] || ''));
      } else {
        if (n.k === 'warn') svg(ICON.warn, p);
        p.appendChild(document.createTextNode(n.t));
      }
    });

    const row = el('div', 'st-d-btns', box);
    d.btns = buttonsFor();
    d.bi = Math.max(0, Math.min(d.bi, d.btns.length - 1));
    d.nodes = d.btns.map(function (b, i) {
      const n = el('div', 'st-btn' + (b.ghost ? ' ghost' : '') + (b.link ? ' quiet' : '') + (b.armed ? ' armed' : '') + (b.busy ? ' busy' : ''), b.link ? note : row);
      if (b.busy) {
        d.bar = el('div', 'bar', n);
        d.lab = el('span', 'lab', n, '');
      } else {
        const lab = el('span', 'lab', n, b.label);
        if (b.check) { const s = svg(ICON.check, lab); s.style.cssText = 'width:26px;height:26px;vertical-align:-5px;margin-right:8px;fill:currentColor'; lab.insertBefore(s, lab.firstChild); }
      }
      n.addEventListener('click', function () { d.bi = i; detailActivate(); });
      return n;
    });
    paintDetail();
  }

  function notesFor(st) {
    const d = D, app = d.app, out = [];
    if (d.mode === 'confirm') {
      if (d.plan && d.plan.ok === false) { out.push({t: say('install_fail', {app: app.name}), k: 'bad'}); return out; }
      if (d.typed) out.push({host: true});
      else out.push({dom: true});
      if (d.plan && !d.typed) out.push({t: say(d.plan.update && d.plan.update.length ? 'confirm_dry_update' : 'confirm_dry_add')});
      if (app.http) out.push({t: say('unsafe'), k: 'warn'});
      return out;
    }
    if (d.msg) out.push(d.msg);
    if (unplugNeeded(st)) out.push({t: say('unplug_strip')});
    if (d.mode !== 'busy' && app.http && st.kind !== 'tv' && !out.some(function (n) { return n.k === 'bad'; })) out.push({t: say('unsafe'), k: 'warn'});
    return out;
  }

  function paintDetail() {
    if (!D) return;
    D.nodes.forEach(function (n, i) { setClass(n, 'focus', i === D.bi && !D.btns[i].busy); });
  }
  function detailMove(dx) {
    if (!D || D.mode === 'busy') return;
    const i = Math.max(0, Math.min(D.btns.length - 1, D.bi + dx));
    if (i !== D.bi) {
      if (D.rmArm) { D.rmArm = false; clearTimeout(D.rmTimer); D.bi = i; renderDetail(); return; }
      D.bi = i;
      paintDetail();
    }
  }
  function detailActivate() {
    if (!D || D.mode === 'busy') return;
    const b = D.btns[D.bi];
    if (b && b.run && !(b.id === 'open' && D.opening)) b.run();
  }

  /** The busy button: the label and the 3-step bar (transform only). */
  function setStep(n, key, total) {
    if (!D || !D.lab) return;
    D.step = n;
    D.lab.textContent = say(key);
    D.bar.style.transform = 'scaleX(' + (n / (total || 3)) + ')';
  }

  function startConfirm() {
    D.mode = 'confirm';
    D.msg = null;
    D.bi = 0;
    D.plan = dry(D.app);
    renderDetail();
  }
  function cancelConfirm() {
    if (D.fromLink) { closeDetail(); openLink(true); return; }
    D.mode = 'view';
    D.bi = 0;
    renderDetail();
  }

  function fail(kind) {
    if (!D) return;
    clearTimeout(D.guard);
    D.mode = 'error';
    D.failKind = kind;
    D.bi = 0;
    const key = kind === 'remove' ? 'remove_fail' : kind === 'open' ? 'open_fail' : 'install_fail';
    D.msg = {t: say(key, {app: D.app.name}), k: 'bad'};
    D.opening = false;
    renderDetail();
  }
  function retryFailed() {
    const k = D.failKind;
    D.mode = 'view';
    D.msg = null;
    if (k === 'remove') { D.rmArm = true; doRemove(); }
    else if (k === 'open') doOpen();
    else runInstall();
  }

  function applyChanges(changes, onDone) {
    let settled = false;
    const once = function (res) { if (!settled) { settled = true; onDone(res); } };
    try { S.reg.apply(changes, {backup: null, mode: 'A', homeNetwork: true}, once); } catch (e) { once({ok: false, error: 'write'}); }
  }

  function runInstall() {
    const d = D;
    d.mode = 'busy';
    d.msg = null;
    renderDetail();
    setStep(0, 'installing');
    requestAnimationFrame(function () { setStep(1, 'installing'); });
    d.guard = later(20000, function () { if (D === d && d.mode === 'busy') fail('install'); });
    yieldTo(function () {
      if (D !== d) return;
      applyChanges({install: [regApp(d.app)]}, function (res) {
        if (D !== d) return;
        if (!res || !res.ok) { fail('install'); return; }
        setStep(2, 'checking');
        later(380, function () {
          if (D !== d) return;
          setStep(3, 'telling');
          later(380, function () {
            if (D !== d) return;
            clearTimeout(d.guard);
            refreshState();
            d.mode = 'view';
            d.bi = 0;
            d.msg = {t: say('install_ok'), k: 'ok'};
            renderDetail();
          });
        });
      });
    });
  }

  function doRemove() {
    const d = D;
    if (!d.rmArm) {
      d.rmArm = true;
      clearTimeout(d.rmTimer);
      d.rmTimer = later(4000, function () { if (D === d && d.rmArm) { d.rmArm = false; renderDetail(); } });
      renderDetail();
      return;
    }
    clearTimeout(d.rmTimer);
    d.rmArm = false;
    d.mode = 'busy';
    d.msg = null;
    renderDetail();
    setStep(0, 'removing', 2);
    requestAnimationFrame(function () { setStep(1, 'removing', 2); });
    d.guard = later(20000, function () { if (D === d && d.mode === 'busy') fail('remove'); });
    yieldTo(function () {
      if (D !== d) return;
      applyChanges({remove: [d.app.id]}, function (res) {
        if (D !== d) return;
        clearTimeout(d.guard);
        if (!res || !res.ok) { fail('remove'); return; }
        lsSet(LS.seen, JSON.stringify(seenIds().filter(function (id) { return id !== d.app.id; })));
        refreshState();
        d.mode = 'view';
        d.bi = 0;
        d.msg = {t: say('remove_ok', {app: d.app.name}), k: 'ok'};
        renderDetail();
      });
    });
  }

  function doOpen() {
    const d = D;
    if (d.opening) return;
    d.opening = true;
    renderDetail();   // "Abrindo…" shows at once, before the call
    const app = d.app;
    const arg = {id: app.id, name: app.name, title: app.name, url: app.url, color: app.color, icon: app.iconUrl, entryId: prefix() + app.id, store: true};
    const finish = function (res) {
      if (D !== d || !d.opening) return;
      clearTimeout(d.openGuard);
      d.opening = false;
      if (res === false || (res && res.ok === false)) fail('open');
      else renderDetail();
    };
    d.openGuard = later(10000, function () { finish(false); });   // still here after 10 s: it did not open
    try {
      if (typeof S.host.launch === 'function') S.host.launch(arg, finish);
      else finish(false);
    } catch (e) { finish(false); }
  }

  function doPin() {
    const d = D, app = d.app;
    try { S.host.pin({id: app.id, name: app.name, title: app.name, url: app.url, color: app.color, icon: app.iconUrl, entryId: prefix() + app.id, store: true}); } catch (e) { return; }
    d.justPinned = true;
    d.msg = null;
    d.bi = 0;
    renderDetail();
  }

  function markSeen() {
    const ids = seenIds();
    ids.push(D.app.id);
    lsSet(LS.seen, JSON.stringify(ids));
    D.bi = 0;
    renderDetail();
  }

  function toggleQueue() {
    const id = D.app.id, i = S.queue.indexOf(id);
    if (i >= 0) S.queue.splice(i, 1); else S.queue.push(id);
    lsSet(LS.queue, JSON.stringify(S.queue));
    renderDetail();
  }

  // MARK: - Add by link

  function openLink(keep) {
    if (!keep || !L) L = {fi: 0, addr: '', name: '', pc: !S.modeA};
    S.prevZone = S.zone === 'detail' ? 'head' : S.zone;
    S.zone = 'link';
    renderLink();
    S.lSheet.classList.add('open');
    paint();
  }
  function closeLink() {
    S.lSheet.classList.remove('open');
    S.zone = S.prevZone || 'head';
    L = null;
    paint();
  }

  function renderLink() {
    const box = S.lBox;
    box.innerHTML = '';
    el('h2', 'st-h', box, say('add_link'));
    L.nodes = [];
    if (L.pc) {
      el('div', 'st-fmsg plain', box, say('link_pc_only'));
      const b = el('div', 'st-frow-btn', box);
      const btn = el('div', 'st-btn', b);
      el('span', 'lab', btn, say('btn_understood'));
      btn.addEventListener('click', closeLink);
      L.nodes = [btn];
      L.inputs = [null];
    } else {
      const mk = function (key, value, mode) {
        el('div', 'st-flabel', box, say(key));
        const row = el('div', 'st-frow', box);
        const input = el('input', '', row);
        input.type = 'text';
        input.placeholder = say(key);
        input.value = value;
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('inputmode', mode);
        row.addEventListener('click', function () { L.fi = L.nodes.indexOf(row); paintLink(); input.focus(); });
        return {row: row, input: input};
      };
      const a = mk('link_address', L.addr, 'url'), n = mk('link_name', L.name, 'text');
      L.addrIn = a.input;
      L.nameIn = n.input;
      a.input.addEventListener('blur', function () { L.addr = a.input.value; updatePreview(); });
      n.input.addEventListener('blur', function () { L.name = n.input.value; });
      L.prev = el('div', 'st-prev', box);
      L.msg = el('div', 'st-fmsg', box);
      const bw = el('div', 'st-frow-btn', box);
      const done = el('div', 'st-btn', bw);
      el('span', 'lab', done, say('link_done'));
      done.addEventListener('click', function () { L.fi = 2; paintLink(); submitLink(); });
      const cancel = el('div', 'st-btn ghost', bw);
      el('span', 'lab', cancel, say('btn_cancel'));
      cancel.addEventListener('click', closeLink);
      L.nodes = [a.row, n.row, done, cancel];
      L.inputs = [a.input, n.input, null, null];
      updatePreview();
    }
    paintLink();
  }

  function paintLink() { L.nodes.forEach(function (n, i) { setClass(n, 'focus', i === L.fi); }); }
  /** Up and down walk the fields; Done and Cancel sit side by side (left and right). */
  function linkMove(d, across) {
    let i = L.fi;
    if (across) { if (i >= 2) i = Math.max(2, Math.min(L.nodes.length - 1, i + d)); }
    else if (i >= 2) i = d < 0 ? 1 : i;
    else i = Math.max(0, Math.min(2, i + d));
    i = Math.min(i, L.nodes.length - 1);
    if (i !== L.fi) { L.fi = i; paintLink(); }
  }
  function linkActivate() {
    if (L.pc) { closeLink(); return; }
    const inp = L.inputs[L.fi];
    if (inp) { inp.focus(); const n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (e) { /* not selectable */ } }
    else if (L.fi === 3) closeLink();
    else submitLink();
  }

  /** A key inside a text field: it types; Done or ↑↓ leave it; Back (never 8) leaves it. */
  function fieldKey(k, e, f) {
    if (k === KEY.ok || k === KEY.done) {
      e.preventDefault();
      f.blur();
      if (L && L.fi < 2 && !L.pc) { L.fi++; paintLink(); }
    } else if (k === KEY.cancel || k === 27 || k === 461 || k === 10009) {
      e.preventDefault();
      f.blur();
    } else if (k === KEY.up || k === KEY.down) {
      e.preventDefault();
      f.blur();
      if (L) linkMove(k === KEY.up ? -1 : 1);
    }
    // everything else, 8 included, is typing
  }

  function parseAddress(text) {
    let s = String(text || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (!/^[^\s/]+\.[^\s/]+$/.test(u.hostname)) return null;
      return u;
    } catch (e) { return null; }
  }

  function updatePreview() {
    if (!L || L.pc) return;
    L.prev.innerHTML = '';
    const u = parseAddress(L.addrIn.value);
    if (!u) return;   // nothing to preview yet: the row stays empty
    const app = {name: u.hostname.replace(/^www\./, '').charAt(0).toUpperCase(), color: '#3A3D45', iconUrl: u.origin + '/favicon.ico'};
    const f = el('div', 'st-d-face', L.prev);
    makeFace(app, 142, 80, 'prev', f);
    el('div', 'dom', L.prev, u.host);
  }

  function submitLink() {
    const u = parseAddress(L.addrIn.value);
    L.msg.textContent = '';
    if (!u) { L.msg.textContent = say('link_bad'); return; }
    const host = u.hostname.replace(/^www\./, '');
    const app = {
      id: ('link-' + host.replace(/[^a-z0-9]+/gi, '-') + (u.port ? '-' + u.port : '')).toLowerCase().slice(0, 40).replace(/-+$/, ''),
      name: (L.nameIn.value || '').trim() || host, url: u.href, iconUrl: u.origin + '/favicon.ico', color: '#3A3D45',
      category: '', desc: {}, site: u.origin, paid: 'free', http: u.protocol === 'http:', featured: false, order: 999, custom: true
    };
    L.addr = L.addrIn.value;
    L.name = L.nameIn.value;
    try {
      const ck = S.reg && S.reg.check(regApp(app), {homeNetwork: true});
      if (ck && !ck.ok) { L.msg.textContent = say(ck.reason === 'domain' ? 'link_blocked' : 'link_bad'); return; }
    } catch (e) { L.msg.textContent = say('link_bad'); return; }
    S.lSheet.classList.remove('open');
    openDetail({app: app}, {mode: 'confirm', typed: true, fromLink: true});
    S.prevZone = 'head';
  }

  // MARK: - Install from the computer (mode B)

  function openQueue() {
    Q = {s3: 'todo', busy: false, fail: false};
    S.prevZone = 'body';
    S.zone = 'queue';
    renderQueue();
    S.qSheet.classList.add('open');
    paint();
  }
  function closeQueue() {
    clearTimeout(S.timers.go);
    S.qSheet.classList.remove('open');
    S.zone = 'body';
    Q = null;
    paint();
  }

  function renderQueue() {
    const box = S.qBox;
    box.innerHTML = '';
    el('h2', 'st-h', box, say('queue_title'));
    const names = S.queue.map(function (id) {
      const a = S.cat && S.cat.apps.filter(function (x) { return x.id === id; })[0];
      return a ? a.name : id;
    });
    el('div', 'st-qnote', box, names.join(', '));
    const steps = [['queue_step1', 'now'], ['queue_step2', 'now'], ['queue_step3', Q.s3]];
    steps.forEach(function (s, i) {
      const row = el('div', 'st-qstep ' + s[1], box);
      const n = el('div', 'n', row);
      if (s[1] === 'ok') svg(ICON.check, n); else n.textContent = String(i + 1);
      el('div', 't', row, say(s[0]));
      el('div', 's', row, say(s[0] + '_sub'));
    });
    el('div', 'st-qnote' + (Q.fail ? ' bad' : ''), box, Q.fail ? say('queue_fail') : say('dns_back'));
    const btn = el('div', 'st-btn' + (Q.busy ? ' busy' : ' focus'), box);
    if (Q.busy) {
      const bar = el('div', 'bar', btn);
      bar.style.transform = 'scaleX(0.66)';
      el('span', 'lab', btn, say('checking'));
    } else el('span', 'lab', btn, say(Q.fail ? 'queue_again' : 'queue_check'));
    btn.addEventListener('click', queueActivate);
  }

  /** Opens the installer only after the computer answers. */
  function queueActivate() {
    if (!Q || Q.busy || Q.s3 === 'ok') return;
    Q.busy = true;
    Q.fail = false;
    Q.s3 = 'now';
    renderQueue();
    const q = Q;
    ping(function (ok) {
      if (Q !== q) return;
      q.busy = false;
      if (!ok) { q.s3 = 'bad'; q.fail = true; renderQueue(); return; }
      q.s3 = 'ok';
      renderQueue();
      S.timers.go = later(500, function () {
        if (Q !== q) return;
        api._navigate(INSTALLER + S.queue.map(encodeURIComponent).join(','));
      });
    });
  }

  function ping(cb) {
    let done = false;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const end = function (ok) { if (!done) { done = true; clearTimeout(t); cb(ok); } };
    const t = later(4500, function () { if (ctl) ctl.abort(); end(false); });
    // no-cors: an answer, any answer, means the computer is there
    fetch(PING, {mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined}).then(function () { end(true); }, function () { end(false); });
  }

  // MARK: - Public

  const api = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    _navigate: function (url) { window.location.href = url; }
  };
  window.FMTVStore = api;

  // Warm up: the texts and the catalogue are ready by the time the Store opens.
  ensureStrings(function () {});
  loadCachedCatalog();
  loadCatalog();
})();
