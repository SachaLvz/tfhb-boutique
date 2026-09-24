// @ts-nocheck — logique legacy migrée ; typage progressif
// Synchronisation Supabase — source de vérité unique.
// IndexedDB n’est qu’un miroir de la dernière réponse cloud, jamais une base locale.
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

let writeEpoch = 0;
let dirty = false;
let autoTimer = null;

/** Pousse le miroir vers Supabase. */
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
  dirty = false;
  return pushed;
}

/**
 * Charge les données depuis Supabase et remplace le miroir.
 * Un pull périmé (écriture en cours) n’est pas appliqué.
 */
export function pullAll(opts = {}) {
  return enqueueSync(() => withSyncing(() => pullAllNow(opts)));
}

async function pullAllNow(opts = {}) {
  if (dirty) {
    try {
      await pushAllNow();
    } catch (e) {
      console.warn('[sync] push avant pull', e);
      return { pulled: 0, empty: false, skipped: true };
    }
  }

  const epoch = writeEpoch;
  const r = await callApi('pull', opts);
  if (dirty || writeEpoch !== epoch) {
    return { pulled: 0, empty: false, skipped: true };
  }

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
  if (Array.isArray(r.stock_moves)) {
    try {
      await db.applyRemoteRows('stock_moves', r.stock_moves);
    } catch (e) {
      console.warn('[sync] stock_moves', e);
    }
  }

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

/** Envoie les écritures puis recharge depuis Supabase. */
export function syncNow(opts = {}) {
  return enqueueSync(() => withSyncing(async () => {
    const pushed = await pushAllNow();
    const { pulled, skipped } = await pullAllNow(opts);
    return { pushed, pulled, skipped };
  }));
}

/** Au démarrage : charge uniquement depuis Supabase. */
export async function loadDynamicData(opts = {}) {
  if (!(await isConfigured())) throw new Error('Supabase non configuré');
  if (!navigator.onLine) throw new Error('Hors-ligne — Supabase injoignable');
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

/** Écriture utilisateur : push immédiat vers Supabase. */
export function schedulePush() {
  writeEpoch++;
  dirty = true;
  return pushAll().catch((e) => { console.warn('[sync] push', e); });
}

export async function startAuto(onSync) {
  const tick = async () => {
    try {
      if (navigator.onLine && (await isConfigured())) {
        const r = await pullAll();
        onSync && onSync(null, { pushed: 0, pulled: r.pulled, skipped: r.skipped });
      }
    } catch (e) { onSync && onSync(e); }
  };
  window.addEventListener('online', async () => {
    try {
      if (await isConfigured()) await tick();
    } catch (e) { onSync && onSync(e); }
  });
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(tick, 60000);
}
