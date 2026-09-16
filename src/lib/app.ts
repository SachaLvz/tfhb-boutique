// @ts-nocheck — logique legacy migrée ; typage progressif
// Coquille de l'app + écran Caisse (Lot 1). Persistance via db.js.
import { CATEGORIES, CATEGORY_LABELS, formatMatchDate, sku } from './catalog';
import * as db from './db';
import { renderBackoffice } from './backoffice';
import { renderFinances } from './finances';
import { renderReglages } from './reglages';
import * as sync from './sync';

const $ = (id) => document.getElementById(id);
const eur = (v) => (Math.round(v * 100) / 100).toLocaleString('fr-FR') + ' €';
const num = (v) => v.toLocaleString('fr-FR');

const VIEW_LOAD_MSG = {
  caisse: 'Chargement de la caisse…',
  backoffice: 'Chargement du back-office…',
  finances: 'Chargement des finances…',
  reglages: 'Chargement des réglages…',
  boot: 'Chargement des données…',
};

function showPageLoader(message = 'Chargement…') {
  const view = $('view');
  if (!view) return;
  view.innerHTML = `<div class="page-loader" role="status" aria-live="polite">
    <div class="page-loader-spin" aria-hidden="true"></div>
    <p>${message}</p>
  </div>`;
}

function showPageError(message) {
  const view = $('view');
  if (!view) return;
  view.innerHTML = `<div class="page-loader page-loader-err" role="alert">
    <p>${message}</p>
    <button type="button" class="bo-btn primary" id="pageRetry">Réessayer</button>
  </div>`;
}

// ---------- état ----------
const state = {
  match: null,          // {id, code, label, channel}
  matches: [],
  products: [],         // catalogue vivant (source = base)
  categories: [],       // catégories gérables
  photos: {},           // productId -> dataUrl (photos importées)
  stock: {},            // sku -> {physique, reserve, ...}
  cart: [],             // {id,productId,name,sku,size,unit,qty,mode}
  curCat: 'Maillot',
  payMethod: 'espece',
  matchStats: { ventes: 0, nb: 0, com: 0 },
  seq: 1,
};
const PAY = { espece: 'Espèces', cb: 'CB', cheque: 'Chèque' };
const productById = (id) => state.products.find((p) => p.id === id);

// ---------- démarrage ----------
let started = false;

async function hydrateState() {
  await db.ensureRemovedProducts();
  await reloadCore();
  const savedMatch = await db.kvGet('current_match');
  state.match = state.matches.find((m) => m.id === savedMatch) || state.matches[0];
  await refreshStats();
}

function revealUi() {
  buildNav();
  updateNet();
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  wireOverlays();
  registerSW();
  return showCurrentView();
}

async function applyCloudToUi() {
  await db.ensureMatches();
  await db.ensureCatalog();
  await reloadCore();
  if (curView !== 'caisse' || !$('catGrid')) return;
  renderMatchName();
  renderCat();
  await refreshStats();
  renderStats();
}

export async function boot() {
  // React Fast Refresh recrée le shell DOM : on ré-affiche sans re-seed
  if (started) {
    await resumeAfterRemount();
    return;
  }
  started = true;
  showPageLoader(VIEW_LOAD_MSG.boot);

  sync.onSyncing((on) => {
    syncing = on;
    updateNet();
  });
  db.onLocalWrite(() => sync.schedulePush());

  const [configured, hasCache] = await Promise.all([
    sync.isConfigured(),
    db.hasLocalCache(),
  ]);

  if (hasCache) {
    await db.ensureMatches();
    await hydrateState();
    await revealUi();
    if (configured && navigator.onLine) {
      void (async () => {
        try {
          await sync.pullAll();
          await applyCloudToUi();
        } catch (e) {
          console.warn('[boot] pull Supabase échoué, cache local', e);
        }
      })();
    }
  } else if (configured && navigator.onLine) {
    try {
      showPageLoader('Chargement depuis Supabase…');
      let r = await sync.pullAll({ omitPhotos: true });
      if (r.empty) {
        showPageLoader('Initialisation du catalogue…');
        await db.kvSet('seeded', false);
        await db.ensureSeeded();
        await db.ensureMatches();
        await sync.pushAll();
        r = await sync.pullAll({ omitPhotos: true });
        toast('Catalogue initial envoyé vers Supabase');
      }
    } catch (e) {
      console.warn('[boot] pull Supabase échoué, cache local', e);
      toast('Supabase injoignable — cache local');
      await db.ensureSeeded();
    }
    await db.ensureMatches();
    await hydrateState();
    await revealUi();
    if (navigator.onLine) {
      void sync.pullAll({ photosOnly: true }).then(applyCloudToUi).catch((e) => {
        console.warn('[boot] photos', e);
      });
    }
  } else {
    await db.ensureSeeded();
    await db.ensureMatches();
    await hydrateState();
    await revealUi();
  }

  sync.startAuto(async (err, r) => {
    if (err) return;
    await applyCloudToUi();
    if (r && r.pulled) toast('Données à jour ✓');
  });
}

/** Après un remount React (Fast Refresh) : rebrancher le DOM sans reset IndexedDB. */
async function resumeAfterRemount() {
  buildNav();
  updateNet();
  wireOverlays();
  await showCurrentView();
}

async function showCurrentView() {
  if (curView === 'caisse') {
    renderCaisse();
  } else if (curView === 'backoffice') {
    await renderBackoffice($('view'), {
      toast,
      onChanged: () => sync.schedulePush(),
      refreshApp: () => reloadCore(),
    });
  } else if (curView === 'finances') {
    await renderFinances($('view'), { toast });
  } else if (curView === 'reglages') {
    await renderReglages($('view'), {
      toast,
      onChanged: async () => { sync.schedulePush(); await reloadCore(); },
    });
  }
}

let syncing = false;
function updateNet() {
  const chip = $('netChip');
  if (!chip) return;
  const on = navigator.onLine;
  chip.classList.toggle('online', on && !syncing);
  chip.classList.toggle('syncing', !!syncing);
  const txt = $('netTxt');
  if (txt) txt.textContent = syncing ? 'Synchro…' : (on ? 'En ligne' : 'Hors-ligne');
}

// ---------- navigation ----------
const VIEWS = [
  { id: 'caisse', label: 'Caisse', enabled: true },
  { id: 'backoffice', label: 'Back-office', enabled: true },
  { id: 'finances', label: 'Finances', enabled: true },
  { id: 'reglages', label: 'Réglages', enabled: true },
];
let curView = 'caisse';
function buildNav() {
  $('navMain').innerHTML = VIEWS.map((v) =>
    `<button data-v="${v.id}" class="${v.id === curView ? 'on' : ''}" ${v.enabled ? '' : 'disabled title="À venir (Lot 3)"'}>${v.label}</button>`
  ).join('');
  $('navMain').querySelectorAll('button:not([disabled])').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.v)));
}
async function switchView(view) {
  if (view === curView) return;
  const prev = curView;
  curView = view;
  buildNav();
  showPageLoader(VIEW_LOAD_MSG[view] || 'Chargement…');
  try {
    if (view === 'caisse') {
      await reloadCore();
      state.cart = [];
      await refreshStats();
      renderCaisse();
    } else if (view === 'backoffice') {
      await renderBackoffice($('view'), {
        toast,
        onChanged: () => sync.schedulePush(),
        refreshApp: () => reloadCore(),
      });
    } else if (view === 'finances') {
      await renderFinances($('view'), { toast });
    } else if (view === 'reglages') {
      await renderReglages($('view'), {
        toast,
        onChanged: async () => { sync.schedulePush(); await reloadCore(); },
      });
    }
  } catch (e) {
    console.error('[switchView]', view, e);
    showPageError(`Impossible de charger cette page.`);
    const btn = $('pageRetry');
    if (btn) {
      btn.addEventListener('click', () => {
        curView = prev;
        void switchView(view);
      });
    }
  }
}

// recharge les données cœur après une synchro / changement de saison
async function reloadCore() {
  const [products, matches, categories, photos, stock] = await Promise.all([
    db.listProducts(),
    db.listMatches(),
    db.getCategories(),
    db.photosMap(),
    db.stockMap(),
  ]);
  state.products = products;
  state.matches = matches;
  state.categories = categories;
  state.photos = photos;
  state.stock = stock;
  state.match = state.matches.find((m) => m.id === state.match?.id) || state.matches[0];
}

// ---------- écran Caisse ----------
function renderMatchName() {
  const el = $('matchName');
  if (!el) return;
  el.innerHTML = state.match
    ? `${state.match.logo ? `<img class="match-logo sm" src="${state.match.logo}" alt="">` : ''}${state.match.code} ${state.match.label}`
    : '—';
}

function renderCaisse() {
  renderMatchName();
  $('view').innerHTML = `
    <div class="grid">
      <section class="panel">
        <div class="cat-tabs" id="catTabs"></div>
        <div class="cat-grid" id="catGrid"></div>
      </section>
      <section class="panel tk">
        <h2>Panier <button class="undo" id="undoBtn">↶ Annuler</button></h2>
        <div class="lines" id="lines"></div>
        <div class="sum">
          <div class="row"><span>Articles</span><span id="nItems" class="tnum">0</span></div>
          <div class="row big"><span>Total panier</span><span id="cartTotal" class="tnum">0 €</span></div>
          <button class="encais" id="encBtn" disabled>Encaisser</button>
        </div>
      </section>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Ventes du match</div><div class="v tnum" id="sVentes">0 <small>€</small></div></div>
      <div class="stat"><div class="k">Nbr de ventes</div><div class="v tnum" id="sNb">0</div></div>
      <div class="stat"><div class="k">Panier moyen</div><div class="v tnum" id="sPanier">0 <small>€</small></div></div>
      <div class="stat"><div class="k">Imputation com</div><div class="v tnum" id="sCom">0 <small>€</small></div></div>
    </div>`;
  renderCatTabs();
  renderCat();
  renderCart();
  renderStats();
  $('undoBtn').addEventListener('click', undo);
  $('encBtn').addEventListener('click', openPay);
}

const photoSrc = (pid) => state.photos[pid] || `/assets/produits/${pid}.png`;
function renderCatTabs() {
  const cats = state.categories.length ? state.categories : CATEGORIES;
  if (!cats.includes(state.curCat)) state.curCat = cats[0];
  $('catTabs').innerHTML = cats.map((c) =>
    `<button class="${c === state.curCat ? 'on' : ''}" data-c="${c}">${CATEGORY_LABELS[c] || c}</button>`).join('');
  $('catTabs').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { state.curCat = b.dataset.c; renderCatTabs(); renderCat(); }));
}

function stockOf(skuId) {
  const s = state.stock[skuId];
  const loc = state.match && state.match.channel === 'en_ligne' ? 'en_ligne' : 'physique';
  return s ? (s[loc] || 0) : 0;
}
function totalStock(p) { return p.variants.reduce((a, v) => a + stockOf(sku(p.id, v.size)), 0); }
function priceLabel(p) {
  const vals = [...new Set(p.variants.map((v) => v.sale_price))];
  return vals.length === 1 ? eur(vals[0]) : `${eur(Math.min(...vals))} – ${eur(Math.max(...vals))}`;
}

function renderCat() {
  const items = state.products.filter((p) => p.category === state.curCat);
  $('catGrid').innerHTML = items.map((p) => {
    const tot = totalStock(p), low = tot <= 3;
    return `<button class="art" data-p="${p.id}">
      <span class="art-img"><img src="${photoSrc(p.id)}" alt=""
        onerror="this.closest('.art').classList.add('no-img')"></span>
      <span class="st ${low ? 'low' : ''}">${tot} en stock</span>
      <span class="art-body"><span class="nm">${p.name}</span><span class="pr">${priceLabel(p)}</span></span></button>`;
  }).join('');
  $('catGrid').querySelectorAll('.art').forEach((b) => b.addEventListener('click', () => openSizes(b.dataset.p)));
}

// ----- overlay tailles -----
let ovProduct = null;
function openSizes(pid) {
  ovProduct = productById(pid);
  $('ovName').innerHTML = `<img class="ov-thumb" src="${photoSrc(pid)}" alt="" onerror="this.remove()"><span>${ovProduct.name}</span>`;
  $('ovSizes').innerHTML = ovProduct.variants.map((v) => {
    const st = stockOf(sku(pid, v.size));
    return `<button class="sz ${st <= 0 ? 'out' : ''}" data-size="${encodeURIComponent(v.size)}">
      <span class="l">${v.size}</span><span class="p">${eur(v.sale_price)}</span>
      <span class="q">${st > 0 ? st + ' dispo' : 'épuisé'}</span></button>`;
  }).join('');
  $('ovSizes').querySelectorAll('.sz').forEach((b) =>
    b.addEventListener('click', () => addLine(decodeURIComponent(b.dataset.size))));
  $('ov').classList.add('on');
}
function addLine(size) {
  const v = ovProduct.variants.find((x) => x.size === size);
  const skuId = sku(ovProduct.id, size);
  const ex = state.cart.find((l) => l.sku === skuId && l.mode === 'plein');
  if (ex) ex.qty++;
  else state.cart.push({ id: state.seq++, productId: ovProduct.id, name: ovProduct.name, sku: skuId, size, unit: v.sale_price, qty: 1, mode: 'plein' });
  $('ov').classList.remove('on');
  renderCart();
  toast(`${ovProduct.name} · ${size} ajouté`);
}

// ----- panier -----
function lineTotal(l) {
  if (l.mode === 'com') return 0;
  return (l.mode === 'abonne' ? l.unit * 0.8 : l.unit) * l.qty;
}
function renderCart() {
  const box = $('lines');
  const salChan = !!(state.match && state.match.channel === 'salarie');
  if (!state.cart.length) { box.innerHTML = '<div class="empty">Touchez un article pour commencer</div>'; }
  else box.innerHTML = state.cart.map((l) => {
    const raw = l.unit * l.qty, t = lineTotal(l), strike = l.mode !== 'plein' && !salChan;
    const meta = `${l.size}` + (salChan ? ' · prix salarié' : ` · ${eur(l.unit)}`) +
      (l.mode === 'abonne' ? ' · −20%' : '') + (l.mode === 'com' ? ' · dotation' : '');
    const controls = salChan
      ? `<label class="ln-price">Prix <input data-price="${l.id}" type="number" step="0.5" min="0" value="${l.unit}"> €</label>`
      : `<button class="pill ab ${l.mode === 'abonne' ? 'on' : ''}" data-a="abonne">Abonné</button>
         <button class="pill sa ${l.mode === 'salarie' ? 'on' : ''}" data-a="salarie">Salarié</button>`;
    return `<div class="ln ${l.mode === 'com' ? 'com' : ''}" data-id="${l.id}">
      <div class="r1"><div><div class="nm">${l.name}</div><div class="meta">${meta}</div></div>
        <div style="text-align:right">${strike ? `<div class="tot strike">${eur(raw)}</div>` : ''}<div class="tot">${eur(t)}</div></div></div>
      <div class="r2">
        <div class="stp"><button data-a="dec">−</button><span>${l.qty}</span><button data-a="inc">+</button></div>
        ${controls}
        <button class="pill co ${l.mode === 'com' ? 'on' : ''}" data-a="com">Imput. com</button>
        <button class="lnx" data-a="rm">🗑</button>
      </div></div>`;
  }).join('');
  box.querySelectorAll('.ln').forEach((el) => {
    const id = +el.dataset.id;
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => lineAction(id, b.dataset.a)));
  });
  box.querySelectorAll('input[data-price]').forEach((inp) => inp.addEventListener('change', () => {
    const l = state.cart.find((x) => x.id === +inp.dataset.price);
    if (l) { l.unit = Math.max(0, +inp.value || 0); l.mode = 'plein'; renderCart(); }
  }));
  const tot = state.cart.reduce((a, l) => a + lineTotal(l), 0);
  const n = state.cart.reduce((a, l) => a + l.qty, 0);
  $('nItems').textContent = n;
  $('cartTotal').textContent = eur(tot);
  $('encBtn').disabled = !state.cart.length;
  $('encBtn').textContent = state.cart.length ? `Encaisser ${eur(tot)}` : 'Encaisser';
}
function lineAction(id, a) {
  const l = state.cart.find((x) => x.id === id);
  if (!l) return;
  if (a === 'inc') l.qty++;
  else if (a === 'dec') { l.qty--; if (l.qty <= 0) state.cart = state.cart.filter((x) => x.id !== id); }
  else if (a === 'rm') state.cart = state.cart.filter((x) => x.id !== id);
  else l.mode = l.mode === a ? 'plein' : a; // abonne/salarie/com toggle
  renderCart();
}
function undo() {
  if (!state.cart.length) return toast('Rien à annuler');
  const l = state.cart[state.cart.length - 1];
  if (l.qty > 1) l.qty--; else state.cart.pop();
  renderCart();
  toast('Dernière saisie annulée');
}

// ----- encaissement -----
function openPay() {
  if (!state.cart.length) return;
  const tot = state.cart.reduce((a, l) => a + lineTotal(l), 0);
  $('payTotal').textContent = eur(tot);
  state.payMethod = 'espece';
  $('payMethods').innerHTML = Object.entries(PAY).map(([k, v]) =>
    `<button data-m="${k}" class="${k === 'espece' ? 'on' : ''}">${v}</button>`).join('');
  $('payMethods').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.payMethod = b.dataset.m;
    $('payMethods').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('wantReceipt').checked = false;
  $('payOv').classList.add('on');
}
async function confirmPay() {
  const tot = state.cart.reduce((a, l) => a + lineTotal(l), 0);
  const com = state.cart.reduce((a, l) => a + (l.mode === 'com' ? l.unit * l.qty : 0), 0);
  const sale = {
    matchId: state.match.id,
    matchLabel: `${state.match.code} ${state.match.label}`,
    channel: state.match.channel,
    payment_method: state.payMethod,
    total: tot, com_total: com,
    lines: state.cart.map((l) => ({ sku: l.sku, name: l.name, size: l.size, qty: l.qty, unit: l.unit, mode: l.mode, line_total: lineTotal(l) })),
  };
  const rec = await db.recordSale(sale);
  // maj stock en mémoire
  const loc = state.match.channel === 'en_ligne' ? 'en_ligne' : 'physique';
  for (const l of state.cart) { const s = state.stock[l.sku]; if (s) s[loc] = (s[loc] || 0) - l.qty; }
  const wantReceipt = $('wantReceipt').checked;
  state.cart = [];
  $('payOv').classList.remove('on');
  await refreshStats();
  renderCart(); renderCat(); renderStats();
  toast('Vente enregistrée ✓ stock mis à jour');
  if (wantReceipt) printReceipt(rec);
}

async function refreshStats() {
  if (!state.match) {
    state.matchStats = { ventes: 0, nb: 0, com: 0 };
    return;
  }
  const sales = await db.salesForMatch(state.match.id);
  state.matchStats = {
    ventes: sales.reduce((a, s) => a + s.total, 0),
    nb: sales.length,
    com: sales.reduce((a, s) => a + (s.com_total || 0), 0),
  };
}
function renderStats() {
  const s = state.matchStats;
  $('sVentes').innerHTML = `${num(Math.round(s.ventes))} <small>€</small>`;
  $('sNb').textContent = s.nb;
  $('sPanier').innerHTML = `${num(s.nb ? Math.round(s.ventes / s.nb) : 0)} <small>€</small>`;
  $('sCom').innerHTML = `${num(Math.round(s.com))} <small>€</small>`;
}

// ----- reçu -----
function printReceipt(rec) {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return toast('Fenêtre bloquée : autorisez les pop-ups pour le reçu');
  const rows = rec.lines.map((l) =>
    `<tr><td>${l.qty}× ${l.name} ${l.size}</td><td style="text-align:right">${eur(l.line_total)}</td></tr>`).join('');
  w.document.write(`<title>Reçu TFHB</title>
    <div style="font-family:system-ui;padding:16px;max-width:320px">
      <div style="background:#103a5c;color:#fff;border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-weight:900;font-size:18px;letter-spacing:.5px">TREMBLAY HANDBALL</div>
        <div style="color:#efb00c;font-weight:700;font-size:12px">Boutique du club</div>
      </div>
      <div style="color:#555;font-size:13px;margin-top:10px">${rec.matchLabel} · ${new Date(rec.created_at).toLocaleString('fr-FR')}</div>
      <hr><table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table><hr>
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:18px"><span>Total</span><span>${eur(rec.total)}</span></div>
      <div style="color:#555;font-size:13px;margin-top:4px">Paiement : ${PAY[rec.payment_method] || rec.payment_method}</div>
      <p style="text-align:center;color:#777;font-size:12px;margin-top:18px">Merci et allez le TFHB ! 🤾</p>
    </div>`);
  w.document.close(); w.focus(); w.print();
}

// ----- overlays câblage -----
function wireOverlays() {
  // onclick (pas addEventListener) : safe après remount React / Fast Refresh
  const ovClose = $('ovClose');
  const payClose = $('payClose');
  const payConfirm = $('payConfirm');
  const matchClose = $('matchClose');
  const matchBtn = $('matchBtn');
  if (!ovClose || !payClose || !payConfirm || !matchClose || !matchBtn) return;

  ovClose.onclick = () => $('ov').classList.remove('on');
  payClose.onclick = () => $('payOv').classList.remove('on');
  payConfirm.onclick = () => { void confirmPay(); };
  matchClose.onclick = () => $('matchOv').classList.remove('on');
  matchBtn.onclick = () => { void openMatchPicker(); };
  ['ov', 'payOv', 'matchOv'].forEach((id) => {
    const o = $(id);
    if (!o) return;
    o.onclick = (e) => { if (e.target === o) o.classList.remove('on'); };
  });
}
function openMatchPicker() {
  $('matchList').innerHTML = state.matches.map((m) => {
    const when = formatMatchDate(m.date);
    const kind = m.channel === 'en_ligne' ? 'Boutique en ligne' : m.channel === 'salarie' ? 'Salariés · prix libre' : 'Soir de match';
    return `<button data-id="${m.id}" class="${m.id === state.match?.id ? 'on' : ''}">
      ${m.logo ? `<img class="match-logo" src="${m.logo}" alt="">` : ''}
      <span>${m.code} ${m.label}
      <small>${when ? when + ' · ' : ''}${kind}</small></span></button>`;
  }).join('');
  $('matchList').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    state.match = state.matches.find((m) => m.id === b.dataset.id);
    await db.kvSet('current_match', state.match.id);
    state.cart = [];
    $('matchOv').classList.remove('on');
    await refreshStats();
    if (curView !== 'caisse') { curView = 'caisse'; buildNav(); }
    renderCaisse();
    toast(`Match : ${state.match.code} ${state.match.label}`);
  }));
  $('matchOv').classList.add('on');
}

// ----- toast -----
let tt;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 1500); }

// ----- service worker -----
async function registerSW() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  // En dev : désactiver le SW (cache-first casse le hot reload)
  if (process.env.NODE_ENV === 'development') {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (_) { /* ignore */ }
    return;
  }

  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Impératif DOM : un vrai reload quand app.ts est remplacé par HMR
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
  const hot =
    (typeof module !== 'undefined' && module.hot) ||
    (typeof import.meta !== 'undefined' && import.meta.hot) ||
    null;
  if (hot?.dispose) {
    hot.dispose(() => {
      window.location.reload();
    });
  }
}

export { toast };
