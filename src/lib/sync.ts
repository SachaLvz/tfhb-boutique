// @ts-nocheck — logique legacy migrée ; typage progressif
// Synchronisation Supabase — données dynamiques (source de vérité = cloud).
// Le navigateur ne parle jamais directement à Supabase : tout passe par
// /api/sync côté serveur, qui garde les identifiants hors du bundle client.
// Boot / auto-refresh : pull. Écritures locales : push différé.
import * as db from './db';

export async function getConfig() {
  return await db.kvGet('supabase', null);
}

export async function saveConfig(url, anonKey) {
  let clean = (url || '').trim().replace(/\/+$/, '');
  clean = clean.replace(/\/rest\/v1$/i, '');
  const cfg = { url: clean, anonKey: (anonKey || '').trim() };
  await db.kvSet('supabase', cfg);
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
  const saved = await getConfig();
  if (saved && saved.url && saved.anonKey) return true;
  try {
    const res = await fetch('/api/sync');
    const data = await res.json();
    return !!data.configured;
  } catch (e) {
    return false;
  }
}

export async function testConnection() {
  await callApi('test');
  return true;
}

/** Pousse le cache local vers Supabase (écritures hors-ligne → cloud). */
export async function pushAll() {
  const batch = await db.getSyncBatch();
  const meta = {
    active_season: await db.kvGet('active_season', null),
    categories: await db.kvGet('categories', null),
  };
  const { pushed } = await callApi('push', { batch, meta });
  return pushed;
}

/**
 * Charge les données dynamiques depuis Supabase et remplace le cache local.
 * Source de vérité = cloud. IndexedDB ne sert que d’offline cache.
 */
export async function pullAll() {
  const r = await callApi('pull');
  let pulled = 0;

  await db.replaceStore('seasons', r.seasons); pulled += r.seasons.length;
  await db.replaceStore('products', r.products); pulled += r.products.length;
  await db.replaceStore('stock', r.stock); pulled += r.stock.length;
  await db.replaceStore('matches', r.matches); pulled += r.matches.length;
  await db.replaceStore('sales', r.sales); pulled += r.sales.length;
  await db.replaceStore('invoices', r.invoices); pulled += r.invoices.length;
  await db.replaceStore('fin_adjust', r.finAdjust); pulled += r.finAdjust.length;
  await db.replaceStore('photos', r.photos); pulled += r.photos.length;

  for (const [key, m] of Object.entries(r.meta || {})) {
    await db.kvSet(key, m.value);
    await db.kvSet(`meta_updated_${key}`, m.updated_at || db.now());
    pulled++;
  }

  await db.kvSet('seeded', true); // empêche le seed local de réécraser le cloud
  await db.kvSet('last_sync', db.now());
  return { pulled, empty: r.products.length === 0 && r.matches.length === 0 };
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
