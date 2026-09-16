// @ts-nocheck — logique legacy migrée ; typage progressif
// Synchronisation Supabase — données dynamiques (source de vérité = cloud).
// Le navigateur ne parle jamais directement à Supabase : tout passe par
// /api/sync côté serveur, qui garde les identifiants hors du bundle client.
// Boot / auto-refresh : pull. Écritures locales : push différé.
import * as db from './db';

let _cfgMem = undefined;
let _configured = null;
let _configuredAt = 0;
const CONFIGURED_TTL_MS = 60_000;

export async function getConfig() {
  if (_cfgMem !== undefined) return _cfgMem;
  _cfgMem = await db.kvGet('supabase', null);
  return _cfgMem;
}

export async function saveConfig(url, anonKey) {
  let clean = (url || '').trim().replace(/\/+$/, '');
  clean = clean.replace(/\/rest\/v1$/i, '');
  const cfg = { url: clean, anonKey: (anonKey || '').trim() };
  await db.kvSet('supabase', cfg);
  _cfgMem = cfg;
  _configured = null;
  return cfg;
}

async function callApi(action, extra = {}) {
  const saved = await getConfig();
  const config = saved && saved.url && saved.anonKey ? saved : undefined;
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, config, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur de synchronisation');
  return data;
}

export async function isConfigured() {
  if (_configured !== null && Date.now() - _configuredAt < CONFIGURED_TTL_MS) return _configured;
  const saved = await getConfig();
  if (saved && saved.url && saved.anonKey) {
    _configured = true;
    _configuredAt = Date.now();
    return true;
  }
  try {
    const res = await fetch('/api/sync');
    const data = await res.json();
    _configured = !!data.configured;
  } catch (e) {
    _configured = false;
  }
  _configuredAt = Date.now();
  return _configured;
}

export async function testConnection() {
  await callApi('test');
  return true;
}

let syncChain = Promise.resolve();
function enqueueSync(fn) {
  const run = syncChain.then(fn, fn);
  syncChain = run.catch(() => {});
  return run;
}

const syncListeners = new Set();
export function onSyncing(fn) {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
}
function emitSyncing(on) {
  for (const fn of syncListeners) {
    try { fn(on); } catch (_) { /* ignore */ }
  }
}

async function withSyncing(fn) {
  emitSyncing(true);
  try {
    return await fn();
  } finally {
    emitSyncing(false);
  }
}

/** Pousse le cache local vers Supabase (écritures hors-ligne → cloud). */
export function pushAll() {
  return enqueueSync(() => withSyncing(pushAllNow));
}

async function pushAllNow() {
  const [batch, active_season, categories] = await Promise.all([
    db.getSyncBatch(),
    db.kvGet('active_season', null),
    db.kvGet('categories', null),
  ]);
  const { pushed } = await callApi('push', { batch, meta: { active_season, categories } });
  return pushed;
}

/**
 * Charge les données dynamiques depuis Supabase et remplace le cache local.
 * Source de vérité = cloud. IndexedDB ne sert que d’offline cache.
 * omitPhotos : 1er paint plus rapide (les photos arrivent ensuite).
 * photosOnly : ne met à jour que le store photos.
 */
export function pullAll(opts = {}) {
  return enqueueSync(() => withSyncing(() => pullAllNow(opts)));
}

async function pullAllNow(opts = {}) {
  const r = await callApi('pull', opts);

  if (opts.photosOnly) {
    await db.replaceStore('photos', r.photos || []);
    await db.kvSet('last_sync', db.now());
    return { pulled: (r.photos || []).length, empty: false };
  }

  const stores = {
    seasons: r.seasons,
    products: r.products,
    stock: r.stock,
    matches: r.matches,
    sales: r.sales,
    invoices: r.invoices,
    fin_adjust: r.finAdjust,
  };
  if (!opts.omitPhotos && r.photos) stores.photos = r.photos;
  await db.replaceStores(stores);

  let pulled = Object.values(stores).reduce((n, rows) => n + (rows?.length || 0), 0);
  const kvEntries = [['seeded', true], ['last_sync', db.now()]];
  for (const [key, m] of Object.entries(r.meta || {})) {
    kvEntries.push([key, m.value]);
    kvEntries.push([`meta_updated_${key}`, m.updated_at || db.now()]);
    pulled++;
  }
  await db.kvSetMany(kvEntries);

  return { pulled, empty: (r.products || []).length === 0 && (r.matches || []).length === 0 };
}

/** Sync complète : envoie les écritures locales puis recharge depuis Supabase. */
export function syncNow(opts = {}) {
  return enqueueSync(() => withSyncing(async () => {
    const pushed = await pushAllNow();
    const { pulled } = await pullAllNow(opts);
    return { pushed, pulled };
  }));
}

/**
 * Au démarrage : charge uniquement depuis Supabase si configuré + en ligne.
 * Sinon conserve le cache IndexedDB (mode hors-ligne).
 * Ne seed plus le catalogue local quand Supabase est actif.
 */
export async function loadDynamicData(opts = {}) {
  if (!(await isConfigured())) return { source: 'local', pulled: 0 };
  if (!navigator.onLine) return { source: 'cache', pulled: 0 };
  const r = await pullAll(opts);
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
        const r = await pullAll();
        onSync && onSync(null, { pushed: 0, pulled: r.pulled });
      }
    } catch (e) { onSync && onSync(e); }
  };
  window.addEventListener('online', async () => {
    try {
      if (await isConfigured()) {
        await pushAll();
        await tick();
      }
    } catch (e) { onSync && onSync(e); }
  });
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(tick, 60000);
}
