// @ts-nocheck — logique legacy migrée ; typage progressif
// Base de données locale hors-ligne (IndexedDB, sans dépendance).
// Structurée pour une future synchronisation Supabase (Lot 4) :
// chaque enregistrement porte un id + updated_at ; un journal `outbox`
// conserve les changements à pousser au serveur quand le réseau revient.

import { SEED_CATALOG, SEED_MATCHES, CATEGORIES, sku } from './catalog';

const DB_NAME = 'tfhb-boutique';
const DB_VERSION = 5;
const STORES = ['kv', 'products', 'stock', 'matches', 'sales', 'invoices', 'seasons', 'fin_adjust', 'photos', 'tombstones', 'outbox'];
// tables répliquées vers Supabase (Lot 4) : [store, clé primaire]
export const SYNC_TABLES = [
  ['products', 'id'], ['stock', 'sku'], ['matches', 'id'],
  ['sales', 'id'], ['invoices', 'id'], ['seasons', 'id'], ['fin_adjust', 'id'], ['photos', 'id'],
];

let _db = null;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stock')) db.createObjectStore('stock', { keyPath: 'sku' });
      if (!db.objectStoreNames.contains('matches')) db.createObjectStore('matches', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sales')) {
        const s = db.createObjectStore('sales', { keyPath: 'id' });
        s.createIndex('by_match', 'matchId');
      }
      if (!db.objectStoreNames.contains('invoices')) db.createObjectStore('invoices', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('seasons')) db.createObjectStore('seasons', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fin_adjust')) db.createObjectStore('fin_adjust', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function db() { return _db || (_db = await open()); }

function tx(store, mode = 'readonly') {
  return db().then((d) => d.transaction(store, mode).objectStore(store));
}
function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// --- helpers génériques ---
export async function kvGet(key, fallback = null) {
  const v = await done((await tx('kv')).get(key));
  return v === undefined ? fallback : v;
}
export async function kvSet(key, value) {
  return done((await tx('kv', 'readwrite')).put(value, key));
}
export async function getAll(store) { return done((await tx(store)).getAll()); }
export async function getOne(store, key) { return done((await tx(store)).get(key)); }

async function putMany(store, items) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    items.forEach((it) => os.put(it));
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/** Remplace entièrement un object store (source de vérité distante). */
export async function replaceStore(store, items) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    os.clear();
    (items || []).forEach((it) => os.put(it));
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

const now = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

/** Hook appelé après toute écriture locale (pour push Supabase). */
let _onWrite = null;
export function onLocalWrite(fn) { _onWrite = fn; }
function touch() { try { _onWrite && _onWrite(); } catch (_) {} }

// --- initialisation : import du catalogue + stock de départ ---
export async function ensureSeeded() {
  const seeded = await kvGet('seeded', false);
  if (seeded) return;

  const products = SEED_CATALOG.map((p) => ({ ...p, updated_at: now() }));
  await putMany('products', products);

  // Stock de démonstration (à remplacer par l'import Excel réel — Lot 2).
  const stock = [];
  for (const p of SEED_CATALOG) {
    for (const v of p.variants) {
      const demo = v.size === 'TU' ? 20 : (2 + ((p.name.length + v.size.length) % 6));
      stock.push({ sku: sku(p.id, v.size), physique: demo, reserve: demo, en_ligne: 0, archive: 0, updated_at: now() });
    }
  }
  await putMany('stock', stock);

  const matches = SEED_MATCHES.map((m) => ({
    id: uid(), code: m.code, label: m.label, date: null, channel: 'physique', updated_at: now(),
  }));
  // Canal "Boutique en ligne" toujours disponible
  matches.push({ id: uid(), code: 'WEB', label: 'Boutique en ligne', date: null, channel: 'en_ligne', updated_at: now() });
  await putMany('matches', matches);

  const seasonId = uid();
  await putMany('seasons', [{ id: seasonId, label: '26-27', closed_at: null, created_at: now(), updated_at: now() }]);
  await kvSet('active_season', seasonId);
  await kvSet('categories', CATEGORIES.slice());
  await kvSet('season', '26-27');
  await kvSet('fond_de_caisse', 0);
  await kvSet('seeded', true);
}

// ===================== CATÉGORIES (gérables par l'utilisateur) =====================
// Liste = catégories enregistrées ∪ catégories réellement utilisées par des produits.
export async function getCategories() {
  const saved = (await kvGet('categories', null)) || CATEGORIES.slice();
  const used = new Set((await getAll('products')).filter((p) => !p.deleted).map((p) => p.category));
  const out = saved.slice();
  for (const c of used) if (c && !out.includes(c)) out.push(c);
  return out;
}
export async function setCategories(arr) { await kvSet('categories', arr.slice()); touch(); }
export async function addCategory(name) {
  name = (name || '').trim();
  if (!name) return;
  const list = (await kvGet('categories', null)) || CATEGORIES.slice();
  if (!list.includes(name)) { list.push(name); await kvSet('categories', list); touch(); }
}
export async function removeCategory(name) {
  const used = (await getAll('products')).some((p) => !p.deleted && p.category === name);
  if (used) throw new Error('Catégorie utilisée par des articles — déplace-les d’abord.');
  const list = ((await kvGet('categories', null)) || CATEGORIES.slice()).filter((c) => c !== name);
  await kvSet('categories', list);
  touch();
}

// ===================== PHOTOS D'ARTICLES (importées par l'utilisateur) =====================
export async function savePhoto(productId, dataUrl) {
  const rec = { id: productId, dataUrl, updated_at: now() };
  await putMany('photos', [rec]);
  await logChange('photo', rec);
  return rec;
}
export async function deletePhoto(productId) {
  const p = await getOne('photos', productId);
  if (!p) return;
  await putMany('photos', [{ id: productId, dataUrl: null, deleted: true, updated_at: now() }]);
  await logChange('photo', { id: productId, deleted: true });
}
export async function photosMap() {
  const all = await getAll('photos');
  const m = {};
  for (const p of all) if (!p.deleted && p.dataUrl) m[p.id] = p.dataUrl;
  return m;
}

// ===================== SAISONS (Lot 4) =====================
export async function listSeasons() {
  const all = await getAll('seasons');
  return all.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}
export async function activeSeasonId() { return kvGet('active_season', null); }
export async function activeSeason() {
  const id = await activeSeasonId();
  return id ? getOne('seasons', id) : null;
}
export async function setActiveSeason(id) { await kvSet('active_season', id); touch(); }
export async function createSeason(label) {
  const rec = { id: uid(), label, closed_at: null, created_at: now(), updated_at: now() };
  await putMany('seasons', [rec]);
  await kvSet('active_season', rec.id);
  await logChange('season', rec);
  return rec;
}
export async function closeSeason(id) {
  const s = await getOne('seasons', id);
  if (!s) return;
  s.closed_at = now(); s.updated_at = now();
  await putMany('seasons', [s]);
  await logChange('season', s);
  return s;
}

// --- stock ---
export async function getStock(skuId) { return getOne('stock', skuId); }
export async function stockMap() {
  const all = await getAll('stock');
  const m = {};
  for (const s of all) if (!s.deleted) m[s.sku] = s;
  return m;
}
export async function adjustStock(skuId, location, delta) {
  const os = await tx('stock', 'readwrite');
  const rec = (await done(os.get(skuId))) || { sku: skuId, physique: 0, reserve: 0, en_ligne: 0, archive: 0 };
  rec[location] = (rec[location] || 0) + delta;
  rec.updated_at = now();
  await done(os.put(rec));
  touch();
  return rec;
}

// Retire les produits abandonnés (soft-delete) — marche sur install existante.
const DEPRECATED_PRODUCTS = ['peluche'];
export async function ensureRemovedProducts() {
  for (const id of DEPRECATED_PRODUCTS) {
    const p = await getOne('products', id);
    if (p && !p.deleted) await deleteProduct(id);
  }
}

// --- matchs ---
export async function listMatches() {
  const all = (await getAll('matches')).filter((m) => !m.deleted);
  return all.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));
}
export async function saveMatch(match) {
  const rec = { id: match.id || uid(), date: null, channel: 'physique', ...match, updated_at: now() };
  await putMany('matches', [rec]);
  await logChange('match', rec);
  return rec;
}
export async function deleteMatch(id) {
  const m = await getOne('matches', id);
  if (!m) return;
  m.deleted = true; m.updated_at = now();
  await putMany('matches', [m]);
  await logChange('match', m);
}
export async function setMatchLogo(id, dataUrl) {
  const m = await getOne('matches', id);
  if (!m) return;
  m.logo = dataUrl; m.updated_at = now();
  await putMany('matches', [m]);
  await logChange('match', m);
  return m;
}
// Ajoute les matchs/canaux standard manquants (idempotent, par code) —
// fonctionne aussi sur une install déjà initialisée.
export async function ensureMatches() {
  const existing = await getAll('matches');
  const codes = new Set(existing.map((m) => m.code));
  const want = [
    { code: 'J-0', label: 'Guiscard', channel: 'physique' },
    { code: 'SAL', label: 'Salariés', channel: 'salarie' },
  ];
  const toAdd = want.filter((w) => !codes.has(w.code))
    .map((w) => ({ id: uid(), date: null, updated_at: now(), ...w }));
  if (toAdd.length) await putMany('matches', toAdd);
}

// --- ventes ---
export async function recordSale(sale) {
  const season_id = await kvGet('active_season', null);
  const rec = { id: uid(), created_at: now(), updated_at: now(), season_id, ...sale };
  await putMany('sales', [rec]);
  // décrément du stock (emplacement selon canal)
  const loc = sale.channel === 'en_ligne' ? 'en_ligne' : 'physique';
  for (const l of sale.lines) await adjustStock(l.sku, loc, -l.qty);
  touch();
  return rec;
}
export async function salesForMatch(matchId) {
  const idx = (await db()).transaction('sales').objectStore('sales').index('by_match');
  const rows = await done(idx.getAll(matchId));
  return rows.filter((r) => !r.deleted);
}
export async function allSales(seasonId) {
  const rows = (await getAll('sales')).filter((r) => !r.deleted);
  return seasonId ? rows.filter((r) => r.season_id === seasonId) : rows;
}

// ===================== BACK-OFFICE (Lot 2) =====================

// --- produits / variantes ---
export async function listProducts() {
  const all = (await getAll('products')).filter((p) => !p.deleted);
  return all.sort((a, b) => a.category.localeCompare(b.category, 'fr') || a.name.localeCompare(b.name, 'fr'));
}
export async function saveProduct(product) {
  product.updated_at = now();
  await putMany('products', [product]);
  // s'assurer qu'une ligne de stock existe pour chaque variante
  const os = await tx('stock', 'readwrite');
  for (const v of product.variants) {
    const id = sku(product.id, v.size);
    const rec = await done(os.get(id));
    if (!rec) await done(os.put({ sku: id, physique: 0, reserve: 0, en_ligne: 0, archive: 0, updated_at: now() }));
  }
  await logChange('product', product);
  return product;
}
export async function deleteProduct(productId) {
  const p = await getOne('products', productId);
  if (!p) return;
  p.deleted = true; p.updated_at = now();
  await putMany('products', [p]);
  const os = await tx('stock', 'readwrite');
  for (const v of p.variants) {
    const s = await done(os.get(sku(productId, v.size)));
    if (s) { s.deleted = true; s.updated_at = now(); await done(os.put(s)); }
  }
  await logChange('product', p);
}

// --- stock : réglage direct, entrée/réassort, transfert ---
export async function setStockValue(skuId, location, value) {
  const os = await tx('stock', 'readwrite');
  const rec = (await done(os.get(skuId))) || { sku: skuId, physique: 0, reserve: 0, en_ligne: 0, archive: 0 };
  rec[location] = Math.max(0, Math.round(value));
  rec.updated_at = now();
  await done(os.put(rec));
  await logChange('stock', rec);
  return rec;
}

/** Met à 0 tous les emplacements de stock (physique, en_ligne, réserve, archive, salariés). */
export async function clearAllStock() {
  const all = await getAll('stock');
  const updated = [];
  let cleared = 0;
  for (const s of all) {
    if (s.deleted) continue;
    const before =
      (s.physique || 0) + (s.en_ligne || 0) + (s.reserve || 0) + (s.archive || 0) + (s.salarie || 0);
    const rec = {
      ...s,
      physique: 0,
      en_ligne: 0,
      reserve: 0,
      archive: 0,
      salarie: 0,
      sal_euro: 0,
      updated_at: now(),
    };
    updated.push(rec);
    if (before > 0) cleared++;
  }
  if (updated.length) {
    await putMany('stock', updated);
    for (const rec of updated) await logChange('stock', rec);
  }
  return cleared;
}
export async function transferStock(skuId, from, to, qty) {
  const os = await tx('stock', 'readwrite');
  const rec = (await done(os.get(skuId))) || { sku: skuId, physique: 0, reserve: 0, en_ligne: 0, archive: 0 };
  const move = Math.min(Math.round(qty), rec[from] || 0);
  rec[from] = (rec[from] || 0) - move;
  rec[to] = (rec[to] || 0) + move;
  rec.updated_at = now();
  await done(os.put(rec));
  await logChange('stock', rec);
  return rec;
}

// --- factures (achats HT) & marquage ---
export async function listInvoices(seasonId) {
  let all = (await getAll('invoices')).filter((i) => !i.deleted);
  if (seasonId) all = all.filter((i) => i.season_id === seasonId);
  return all.sort((a, b) => (a.ref || '').localeCompare(b.ref || '', 'fr'));
}
export async function saveInvoice(inv) {
  const season_id = inv.season_id || (await kvGet('active_season', null));
  const rec = { id: inv.id || uid(), updated_at: now(), season_id, ...inv };
  await putMany('invoices', [rec]);
  await logChange('invoice', rec);
  return rec;
}
export async function deleteInvoice(id) {
  const inv = await getOne('invoices', id);
  if (!inv) return;
  inv.deleted = true; inv.updated_at = now();
  await putMany('invoices', [inv]);
  await logChange('invoice', inv);
}

// --- ventes : annulation (remet le stock) ---
export async function voidSale(saleId) {
  const sale = await getOne('sales', saleId);
  if (!sale || sale.deleted) return;
  const loc = sale.channel === 'en_ligne' ? 'en_ligne' : 'physique';
  for (const l of sale.lines) await adjustStock(l.sku, loc, +l.qty);
  sale.deleted = true; sale.updated_at = now();
  await putMany('sales', [sale]);
  await logChange('sale', sale);
}

async function logChange(type, payload) {
  await done((await tx('outbox', 'readwrite')).add({ type, payload, at: now() }));
  touch();
}

// --- export / import complet (round-trip Excel hors-ligne) ---
export async function exportState() {
  return {
    season: await kvGet('season', ''),
    products: await getAll('products'),
    stock: await getAll('stock'),
    matches: await getAll('matches'),
    sales: await getAll('sales'),
    invoices: await getAll('invoices'),
  };
}
// Remplace catalogue + stock (import depuis un classeur édité hors-ligne).
export async function replaceCatalog(products, stockRows) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(['products', 'stock'], 'readwrite');
    t.objectStore('products').clear();
    t.objectStore('stock').clear();
    products.forEach((p) => t.objectStore('products').put({ ...p, updated_at: now() }));
    stockRows.forEach((s) => t.objectStore('stock').put({ ...s, updated_at: now() }));
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
  await logChange('import_catalog', { count: products.length });
  touch();
}
export async function importInvoices(rows, replace = true) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction('invoices', 'readwrite');
    if (replace) t.objectStore('invoices').clear();
    rows.forEach((r) => t.objectStore('invoices').put({ id: r.id || uid(), ...r }));
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
  touch();
}

// ===================== AJUSTEMENTS FINANCES =====================
// Deux types dans le store 'fin_adjust' :
//  - {type:'entry', kind:'recette'|'cout', label, amount}  → entrées manuelles
//  - {type:'override', field, value}                        → montant forcé
export async function listFinAdjust(seasonId) {
  const all = (await getAll('fin_adjust')).filter((a) => !a.deleted);
  return seasonId ? all.filter((a) => a.season_id === seasonId) : all;
}
export async function addFinEntry({ kind, label, amount }) {
  const season_id = await kvGet('active_season', null);
  const rec = { id: uid(), type: 'entry', kind, label: label || '', amount: +amount || 0, season_id, updated_at: now() };
  await putMany('fin_adjust', [rec]);
  await logChange('fin_adjust', rec);
  return rec;
}
export async function deleteFinAdjust(id) {
  const a = await getOne('fin_adjust', id);
  if (!a) return;
  a.deleted = true; a.updated_at = now();
  await putMany('fin_adjust', [a]);
  await logChange('fin_adjust', a);
}
// Forcer (ou effacer si value==null) un montant d'un KPI pour la saison active.
export async function setFinOverride(field, value) {
  const season_id = await kvGet('active_season', null);
  const id = `ovr_${season_id}_${field}`;
  const rec = { id, type: 'override', field, value: value == null ? null : +value,
    season_id, updated_at: now(), deleted: value == null };
  await putMany('fin_adjust', [rec]);
  await logChange('fin_adjust', rec);
  return rec;
}

// Montant des ventes salariés pour un article (prix internes ≠ boutique), saisi à la main.
// Recalcule le total interne = Σ des montants salariés, qui compte dans les recettes.
export async function setSalarieEuro(skuId, value) {
  const os = await tx('stock', 'readwrite');
  const rec = (await done(os.get(skuId))) || { sku: skuId, physique: 0, reserve: 0, en_ligne: 0, archive: 0 };
  rec.sal_euro = Math.max(0, Math.round((+value || 0) * 100) / 100);
  rec.updated_at = now();
  await done(os.put(rec));
  await logChange('stock', rec);
  const all = (await getAll('stock')).filter((s) => !s.deleted);
  const total = all.reduce((a, s) => a + (+s.sal_euro || 0), 0);
  await setVentesInternes(total);
  return total;
}

// Total des ventes internes salariés (Σ des montants par article), par saison.
// Stocké comme une entrée recette dédiée (id fixe) → compte dans les recettes des Finances.
export async function getVentesInternes(seasonId) {
  const r = await getOne('fin_adjust', `internes_${seasonId}`);
  return r && !r.deleted ? (+r.amount || 0) : 0;
}
export async function setVentesInternes(amount) {
  const season_id = await kvGet('active_season', null);
  const rec = { id: `internes_${season_id}`, type: 'entry', kind: 'recette',
    label: 'Ventes internes salariés', amount: +amount || 0, season_id, updated_at: now(), deleted: false };
  await putMany('fin_adjust', [rec]);
  await logChange('fin_adjust', rec);
  return rec;
}

// ===================== SYNCHRONISATION (Lot 4) =====================
// Full-sync last-write-wins : on pousse tout le local, on tire tout le distant,
// et pour chaque enregistrement on garde le plus récent (updated_at ISO).

// Toutes les lignes locales à pousser, par table.
export async function getSyncBatch() {
  const batch = {};
  for (const [store] of SYNC_TABLES) batch[store] = await getAll(store);
  return batch;
}

// Applique des lignes distantes en local ; renvoie le nombre d'écritures.
export async function applyRemoteRows(store, rows) {
  if (!rows || !rows.length) return 0;
  const key = SYNC_TABLES.find(([s]) => s === store)[1];
  const d = await db();
  let n = 0;
  await new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    rows.forEach((remote) => {
      const req = os.get(remote[key]);
      req.onsuccess = () => {
        const local = req.result;
        if (!local || (remote.updated_at || '') >= (local.updated_at || '')) { os.put(remote); n++; }
      };
    });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return n;
}

export { uid, now, sku };
