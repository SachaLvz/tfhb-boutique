// @ts-nocheck — logique legacy migrée ; typage progressif
// Synchronisation Supabase — données dynamiques (source de vérité = cloud).
// Boot / auto-refresh : pull. Écritures locales : push différé.
import * as db from './db';

let client = null;
let cfg = null;

function envConfig() {
  let url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  // Accepte une URL collée avec /rest/v1 (dashboard) — le client JS n’en veut pas.
  url = url.replace(/\/rest\/v1$/i, '');
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anonKey || url.includes('xxxx.supabase.co') || anonKey === 'eyJhbGciOi...') return null;
  return { url, anonKey };
}

export async function getConfig() {
  const saved = await db.kvGet('supabase', null);
  if (saved && saved.url && saved.anonKey) return saved;
  return envConfig();
}

export async function saveConfig(url, anonKey) {
  let clean = (url || '').trim().replace(/\/+$/, '');
  clean = clean.replace(/\/rest\/v1$/i, '');
  cfg = { url: clean, anonKey: (anonKey || '').trim() };
  await db.kvSet('supabase', cfg);
  client = null;
  return cfg;
}

export async function isConfigured() {
  const c = await getConfig();
  return !!(c && c.url && c.anonKey);
}

async function getClient() {
  if (client) return client;
  cfg = cfg || (await getConfig());
  if (!cfg || !cfg.url || !cfg.anonKey) throw new Error('Supabase non configuré (renseigne l’URL et la clé anon).');
  const { createClient } = await import('@supabase/supabase-js');
  client = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false } });
  return client;
}

export async function testConnection() {
  const c = await getClient();
  const { error } = await c.from('seasons').select('id').limit(1);
  if (error) throw new Error(error.message);
  return true;
}

const chunk = (arr, n = 500) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function upsert(c, table, rows, onConflict = 'id') {
  if (!rows.length) return 0;
  for (const part of chunk(rows)) {
    const { error } = await c.from(table).upsert(part, { onConflict });
    if (error) throw new Error(`push ${table} : ${error.message}`);
  }
  return rows.length;
}

async function fetchAll(c, table, select = '*') {
  const { data, error } = await c.from(table).select(select);
  if (error) throw new Error(`pull ${table} : ${error.message}`);
  return data || [];
}

// ---------- mapping local ↔ remote ----------

function splitSku(sku) {
  const i = String(sku).indexOf('|');
  if (i < 0) return { product_id: sku, size: '' };
  return { product_id: sku.slice(0, i), size: sku.slice(i + 1) };
}

function mapSeason(s) {
  return {
    id: s.id,
    label: s.label,
    closed_at: s.closed_at || null,
    created_at: s.created_at || s.updated_at || db.now(),
    updated_at: s.updated_at || db.now(),
  };
}

function mapProduct(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    deleted: !!p.deleted,
    updated_at: p.updated_at || db.now(),
  };
}

function mapVariants(p) {
  return (p.variants || []).map((v) => ({
    product_id: p.id,
    size: v.size,
    size_system: v.size_system,
    sale_price: v.sale_price ?? 0,
    purchase_price_ht: v.purchase_price_ht ?? null,
    marking_cost: v.marking_cost ?? 0,
  }));
}

function mapStock(s) {
  const { product_id, size } = splitSku(s.sku);
  return {
    sku: s.sku,
    product_id,
    size,
    physique: s.physique || 0,
    reserve: s.reserve || 0,
    en_ligne: s.en_ligne || 0,
    archive: s.archive || 0,
    salarie: s.salarie || 0,
    sal_euro: s.sal_euro || 0,
    deleted: !!s.deleted,
    updated_at: s.updated_at || db.now(),
  };
}

function mapMatch(m) {
  return {
    id: m.id,
    code: m.code,
    label: m.label,
    date: m.date || null,
    channel: m.channel || 'physique',
    logo: m.logo || null,
    deleted: !!m.deleted,
    updated_at: m.updated_at || db.now(),
  };
}

function mapSale(s) {
  return {
    id: s.id,
    season_id: s.season_id || null,
    match_id: s.matchId || null,
    match_label: s.matchLabel || null,
    channel: s.channel || 'physique',
    payment_method: s.payment_method || 'espece',
    total: s.total || 0,
    com_total: s.com_total || 0,
    deleted: !!s.deleted,
    created_at: s.created_at || s.updated_at || db.now(),
    updated_at: s.updated_at || db.now(),
  };
}

function mapSaleLines(s) {
  return (s.lines || []).map((l) => ({
    sale_id: s.id,
    sku: l.sku,
    name: l.name,
    size: l.size,
    qty: l.qty,
    unit: l.unit ?? 0,
    mode: l.mode || 'plein',
    line_total: l.line_total ?? 0,
  }));
}

function mapInvoice(i) {
  return {
    id: i.id,
    season_id: i.season_id || null,
    ref: i.ref || '',
    type: i.type || 'achat',
    amount: i.amount || 0,
    deleted: !!i.deleted,
    updated_at: i.updated_at || db.now(),
  };
}

function mapFinAdjust(a) {
  return {
    id: a.id,
    season_id: a.season_id || null,
    type: a.type,
    kind: a.kind || null,
    label: a.label || null,
    amount: a.amount ?? null,
    field: a.field || null,
    value: a.value ?? null,
    deleted: !!a.deleted,
    updated_at: a.updated_at || db.now(),
  };
}

function mapPhoto(p) {
  return {
    id: p.id,
    data_url: p.dataUrl ?? null,
    deleted: !!p.deleted,
    updated_at: p.updated_at || db.now(),
  };
}

// remote → local IndexedDB shapes
function fromSeason(r) {
  return {
    id: r.id,
    label: r.label,
    closed_at: r.closed_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function fromProduct(r, variants) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    variants: (variants || []).map((v) => ({
      size: v.size,
      size_system: v.size_system,
      sale_price: Number(v.sale_price) || 0,
      purchase_price_ht: v.purchase_price_ht == null ? null : Number(v.purchase_price_ht),
      marking_cost: Number(v.marking_cost) || 0,
    })),
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

function fromStock(r) {
  return {
    sku: r.sku,
    physique: r.physique || 0,
    reserve: r.reserve || 0,
    en_ligne: r.en_ligne || 0,
    archive: r.archive || 0,
    salarie: r.salarie || 0,
    sal_euro: Number(r.sal_euro) || 0,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

function fromMatch(r) {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    date: r.date || null,
    channel: r.channel || 'physique',
    logo: r.logo || null,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

function fromSale(r, lines) {
  return {
    id: r.id,
    season_id: r.season_id || null,
    matchId: r.match_id || null,
    matchLabel: r.match_label || '',
    channel: r.channel || 'physique',
    payment_method: r.payment_method || 'espece',
    total: Number(r.total) || 0,
    com_total: Number(r.com_total) || 0,
    lines: (lines || []).map((l) => ({
      sku: l.sku,
      name: l.name,
      size: l.size,
      qty: l.qty,
      unit: Number(l.unit) || 0,
      mode: l.mode || 'plein',
      line_total: Number(l.line_total) || 0,
    })),
    deleted: !!r.deleted,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function fromInvoice(r) {
  return {
    id: r.id,
    season_id: r.season_id || null,
    ref: r.ref || '',
    type: r.type || 'achat',
    amount: Number(r.amount) || 0,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

function fromFinAdjust(r) {
  return {
    id: r.id,
    season_id: r.season_id || null,
    type: r.type,
    kind: r.kind || undefined,
    label: r.label || undefined,
    amount: r.amount == null ? undefined : Number(r.amount),
    field: r.field || undefined,
    value: r.value == null ? null : Number(r.value),
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

function fromPhoto(r) {
  return {
    id: r.id,
    dataUrl: r.data_url || null,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

function groupBy(rows, key) {
  const m = {};
  for (const r of rows) {
    const k = r[key];
    (m[k] || (m[k] = [])).push(r);
  }
  return m;
}

// ---------- sync ----------

/** Pousse le cache local vers Supabase (écritures hors-ligne → cloud). */
export async function pushAll() {
  const c = await getClient();
  const batch = await db.getSyncBatch();
  let pushed = 0;

  pushed += await upsert(c, 'seasons', (batch.seasons || []).map(mapSeason));
  pushed += await upsert(c, 'products', (batch.products || []).map(mapProduct));

  const variants = (batch.products || []).flatMap(mapVariants);
  const productIds = (batch.products || []).map((p) => p.id);
  if (productIds.length) {
    for (const part of chunk(productIds)) {
      const { error: delErr } = await c.from('product_variants').delete().in('product_id', part);
      if (delErr) throw new Error(`push product_variants : ${delErr.message}`);
    }
  }
  pushed += await upsert(c, 'product_variants', variants, 'product_id,size');

  pushed += await upsert(c, 'stock', (batch.stock || []).map(mapStock), 'sku');
  pushed += await upsert(c, 'matches', (batch.matches || []).map(mapMatch));
  pushed += await upsert(c, 'sales', (batch.sales || []).map(mapSale));

  const saleIds = (batch.sales || []).map((s) => s.id);
  if (saleIds.length) {
    for (const part of chunk(saleIds)) {
      const { error: delErr } = await c.from('sale_lines').delete().in('sale_id', part);
      if (delErr) throw new Error(`push sale_lines : ${delErr.message}`);
    }
  }
  const saleLines = (batch.sales || []).flatMap(mapSaleLines);
  if (saleLines.length) {
    for (const part of chunk(saleLines)) {
      const { error } = await c.from('sale_lines').insert(part);
      if (error) throw new Error(`push sale_lines : ${error.message}`);
    }
    pushed += saleLines.length;
  }

  pushed += await upsert(c, 'invoices', (batch.invoices || []).map(mapInvoice));
  pushed += await upsert(c, 'fin_adjust', (batch.fin_adjust || []).map(mapFinAdjust));
  pushed += await upsert(c, 'photos', (batch.photos || []).map(mapPhoto));

  const metaRows = [
    { key: 'active_season', value: await db.kvGet('active_season', null), updated_at: db.now() },
    { key: 'categories', value: await db.kvGet('categories', null), updated_at: db.now() },
  ];
  pushed += await upsert(c, 'app_meta', metaRows, 'key');
  return pushed;
}

/**
 * Charge les données dynamiques depuis Supabase et remplace le cache local.
 * Source de vérité = cloud. IndexedDB ne sert que d’offline cache.
 */
export async function pullAll() {
  const c = await getClient();
  let pulled = 0;

  const remoteSeasons = (await fetchAll(c, 'seasons')).map(fromSeason);
  await db.replaceStore('seasons', remoteSeasons);
  pulled += remoteSeasons.length;

  const remoteProducts = await fetchAll(c, 'products');
  const remoteVariants = await fetchAll(c, 'product_variants');
  const variantsByProduct = groupBy(remoteVariants, 'product_id');
  const products = remoteProducts.map((p) => fromProduct(p, variantsByProduct[p.id] || []));
  await db.replaceStore('products', products);
  pulled += products.length;

  const stock = (await fetchAll(c, 'stock')).map(fromStock);
  await db.replaceStore('stock', stock);
  pulled += stock.length;

  const matches = (await fetchAll(c, 'matches')).map(fromMatch);
  await db.replaceStore('matches', matches);
  pulled += matches.length;

  const remoteSales = await fetchAll(c, 'sales');
  const remoteLines = await fetchAll(c, 'sale_lines');
  const linesBySale = groupBy(remoteLines, 'sale_id');
  const sales = remoteSales.map((s) => fromSale(s, linesBySale[s.id] || []));
  await db.replaceStore('sales', sales);
  pulled += sales.length;

  const invoices = (await fetchAll(c, 'invoices')).map(fromInvoice);
  await db.replaceStore('invoices', invoices);
  pulled += invoices.length;

  const finAdjust = (await fetchAll(c, 'fin_adjust')).map(fromFinAdjust);
  await db.replaceStore('fin_adjust', finAdjust);
  pulled += finAdjust.length;

  const photos = (await fetchAll(c, 'photos')).map(fromPhoto);
  await db.replaceStore('photos', photos);
  pulled += photos.length;

  const remoteMeta = await fetchAll(c, 'app_meta');
  for (const m of remoteMeta) {
    if (m.key !== 'active_season' && m.key !== 'categories') continue;
    await db.kvSet(m.key, m.value);
    await db.kvSet(`meta_updated_${m.key}`, m.updated_at || db.now());
    pulled++;
  }

  await db.kvSet('seeded', true); // empêche le seed local de réécraser le cloud
  await db.kvSet('last_sync', db.now());
  return { pulled, empty: products.length === 0 && matches.length === 0 };
}

/** Sync complète : envoie les écritures locales puis recharge depuis Supabase. */
export async function syncNow() {
  const pushed = await pushAll();
  const { pulled } = await pullAll();
  return { pushed, pulled };
}

/**
 * Au démarrage : charge uniquement depuis Supabase si configuré + en ligne.
 * Sinon conserve le cache IndexedDB (mode hors-ligne).
 * Ne seed plus le catalogue local quand Supabase est actif.
 */
export async function loadDynamicData() {
  if (!(await isConfigured())) return { source: 'local', pulled: 0 };
  if (!navigator.onLine) return { source: 'cache', pulled: 0 };
  const r = await pullAll();
  return { source: 'supabase', ...r };
}

export async function status() {
  return {
    configured: await isConfigured(),
    online: navigator.onLine,
    lastSync: await db.kvGet('last_sync', null),
  };
}

let autoTimer = null;
let pushTimer = null;

/** Déclenche un push différé après une écriture locale (vente, back-office…). */
export function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      if (navigator.onLine && (await isConfigured())) await pushAll();
    } catch (e) { console.warn('[sync] push', e); }
  }, 800);
}

export async function startAuto(onSync) {
  const tick = async () => {
    try {
      if (navigator.onLine && (await isConfigured())) {
        // Source de vérité = Supabase : on recharge le cache local
        const r = await pullAll();
        onSync && onSync(null, { pushed: 0, pulled: r.pulled });
      }
    } catch (e) { onSync && onSync(e); }
  };
  window.addEventListener('online', async () => {
    try {
      if (await isConfigured()) {
        await pushAll(); // envoie les ventes faites hors-ligne
        await tick();
      }
    } catch (e) { onSync && onSync(e); }
  });
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(tick, 60000);
}
