// Synchronisation Supabase — exécutée côté serveur uniquement.
// Les identifiants Supabase (SUPABASE_URL / SUPABASE_ANON_KEY) ne sont jamais
// exposés au bundle client : le navigateur ne parle qu'à cette route.
import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type SupaConfig = { url: string; anonKey: string };

function resolveConfig(override?: Partial<SupaConfig> | null): SupaConfig | null {
  if (override?.url && override?.anonKey) {
    const url = override.url.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
    const anonKey = override.anonKey.trim();
    if (url && anonKey) return { url, anonKey };
  }
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  const anonKey = (process.env.SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

function getClient(cfg: SupaConfig) {
  return createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false } });
}

const now = () => new Date().toISOString();

function chunk<T>(arr: T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function upsert(c: SupabaseClient, table: string, rows: unknown[], onConflict = "id") {
  if (!rows.length) return 0;
  for (const part of chunk(rows)) {
    const { error } = await c.from(table).upsert(part, { onConflict });
    if (error) throw new Error(`push ${table} : ${error.message}`);
  }
  return rows.length;
}

async function fetchAll(c: SupabaseClient, table: string, select = "*", pageSize = 1000) {
  const out: unknown[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await c.from(table).select(select).range(from, from + pageSize - 1);
    if (error) throw new Error(`pull ${table} : ${error.message}`);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function isMissingTable(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist|schema cache|Could not find the table/i.test(msg);
}

async function fetchAllOptional(c: SupabaseClient, table: string, select = "*", pageSize = 1000) {
  try {
    return await fetchAll(c, table, select, pageSize);
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

// ---------- mapping local ↔ remote ----------

function splitSku(sku: string) {
  const s = String(sku);
  const i = s.indexOf("|");
  if (i < 0) return { product_id: s, size: "" };
  return { product_id: s.slice(0, i), size: s.slice(i + 1) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSeason(s: any) {
  return {
    id: s.id,
    label: s.label,
    closed_at: s.closed_at || null,
    created_at: s.created_at || s.updated_at || now(),
    updated_at: s.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapProduct(p: any) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    deleted: !!p.deleted,
    updated_at: p.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapVariants(p: any) {
  return (p.variants || []).map((v: any) => ({
    product_id: p.id,
    size: v.size,
    size_system: v.size_system,
    sale_price: v.sale_price ?? 0,
    purchase_price_ht: v.purchase_price_ht ?? null,
    marking_cost: v.marking_cost ?? 0,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapStock(s: any) {
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
    updated_at: s.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapMatch(m: any) {
  return {
    id: m.id,
    code: m.code,
    label: m.label,
    date: m.date || null,
    channel: m.channel || "physique",
    logo: m.logo || null,
    deleted: !!m.deleted,
    updated_at: m.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSale(s: any) {
  return {
    id: s.id,
    season_id: s.season_id || null,
    match_id: s.matchId || null,
    match_label: s.matchLabel || null,
    channel: s.channel || "physique",
    payment_method: s.payment_method || "espece",
    total: s.total || 0,
    com_total: s.com_total || 0,
    deleted: !!s.deleted,
    created_at: s.created_at || s.updated_at || now(),
    updated_at: s.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSaleLines(s: any) {
  return (s.lines || []).map((l: any) => ({
    sale_id: s.id,
    sku: l.sku,
    name: l.name,
    size: l.size,
    qty: l.qty,
    unit: l.unit ?? 0,
    mode: l.mode || "plein",
    line_total: l.line_total ?? 0,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapInvoice(i: any) {
  return {
    id: i.id,
    season_id: i.season_id || null,
    ref: i.ref || "",
    type: i.type || "achat",
    amount: i.amount || 0,
    deleted: !!i.deleted,
    updated_at: i.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapFinAdjust(a: any) {
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
    updated_at: a.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapStockMove(m: any) {
  return {
    id: m.id,
    sku: m.sku,
    product_id: m.product_id || null,
    product_name: m.product_name || null,
    size: m.size || null,
    category: m.category || null,
    direction: m.direction === "in" ? "in" : "out",
    reason: m.reason || "ajustement",
    qty: m.qty || 0,
    location: m.location || "physique",
    location_to: m.location_to || null,
    sale_id: m.sale_id || null,
    match_id: m.match_id || null,
    match_label: m.match_label || null,
    note: m.note || null,
    season_id: m.season_id || null,
    deleted: !!m.deleted,
    created_at: m.created_at || m.updated_at || now(),
    updated_at: m.updated_at || now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPhoto(p: any) {
  return {
    id: p.id,
    data_url: p.dataUrl ?? null,
    deleted: !!p.deleted,
    updated_at: p.updated_at || now(),
  };
}

// remote → local IndexedDB shapes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromSeason(r: any) {
  return {
    id: r.id,
    label: r.label,
    closed_at: r.closed_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromProduct(r: any, variants: any[]) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    variants: (variants || []).map((v: any) => ({
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromStock(r: any) {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromMatch(r: any) {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    date: r.date || null,
    channel: r.channel || "physique",
    logo: r.logo || null,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromSale(r: any, lines: any[]) {
  return {
    id: r.id,
    season_id: r.season_id || null,
    matchId: r.match_id || null,
    matchLabel: r.match_label || "",
    channel: r.channel || "physique",
    payment_method: r.payment_method || "espece",
    total: Number(r.total) || 0,
    com_total: Number(r.com_total) || 0,
    lines: (lines || []).map((l: any) => ({
      sku: l.sku,
      name: l.name,
      size: l.size,
      qty: l.qty,
      unit: Number(l.unit) || 0,
      mode: l.mode || "plein",
      line_total: Number(l.line_total) || 0,
    })),
    deleted: !!r.deleted,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromInvoice(r: any) {
  return {
    id: r.id,
    season_id: r.season_id || null,
    ref: r.ref || "",
    type: r.type || "achat",
    amount: Number(r.amount) || 0,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromFinAdjust(r: any) {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromStockMove(r: any) {
  return {
    id: r.id,
    sku: r.sku,
    product_id: r.product_id || "",
    product_name: r.product_name || "",
    size: r.size || "",
    category: r.category || "",
    direction: r.direction === "in" ? "in" : "out",
    reason: r.reason || "ajustement",
    qty: Number(r.qty) || 0,
    location: r.location || "physique",
    location_to: r.location_to || null,
    sale_id: r.sale_id || null,
    match_id: r.match_id || null,
    match_label: r.match_label || "",
    note: r.note || "",
    season_id: r.season_id || null,
    deleted: !!r.deleted,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromPhoto(r: any) {
  return {
    id: r.id,
    dataUrl: r.data_url || null,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function groupBy(rows: any[], key: string) {
  const m: Record<string, any[]> = {};
  for (const r of rows) {
    const k = r[key];
    (m[k] || (m[k] = [])).push(r);
  }
  return m;
}

/** Indique si Supabase est configuré côté serveur (sans révéler l'URL/la clé). */
export async function GET() {
  const cfg = resolveConfig(null);
  return NextResponse.json({ configured: !!cfg });
}

export async function POST(req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }

  const { action, config } = body || {};
  if (action === "status") {
    return NextResponse.json({ configured: !!resolveConfig(config) });
  }

  const cfg = resolveConfig(config);
  if (!cfg) {
    return NextResponse.json(
      { error: "Supabase non configuré (renseigne l’URL et la clé anon)." },
      { status: 400 },
    );
  }

  try {
    const c = getClient(cfg);

    if (action === "test") {
      const { error } = await c.from("seasons").select("id").limit(1);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    if (action === "push") {
      const batch = body.batch || {};
      const meta = body.meta || {};
      let pushed = 0;

      pushed += await upsert(c, "seasons", (batch.seasons || []).map(mapSeason));
      pushed += await upsert(c, "products", (batch.products || []).map(mapProduct));

      const variants = (batch.products || []).flatMap(mapVariants);
      const productIds = (batch.products || []).map((p: any) => p.id);
      if (productIds.length) {
        for (const part of chunk(productIds)) {
          const { error: delErr } = await c.from("product_variants").delete().in("product_id", part);
          if (delErr) throw new Error(`push product_variants : ${delErr.message}`);
        }
      }
      pushed += await upsert(c, "product_variants", variants, "product_id,size");

      pushed += await upsert(c, "stock", (batch.stock || []).map(mapStock), "sku");
      pushed += await upsert(c, "matches", (batch.matches || []).map(mapMatch));
      pushed += await upsert(c, "sales", (batch.sales || []).map(mapSale));

      const saleIds = (batch.sales || []).map((s: any) => s.id);
      if (saleIds.length) {
        for (const part of chunk(saleIds)) {
          const { error: delErr } = await c.from("sale_lines").delete().in("sale_id", part);
          if (delErr) throw new Error(`push sale_lines : ${delErr.message}`);
        }
      }
      const saleLines = (batch.sales || []).flatMap(mapSaleLines);
      if (saleLines.length) {
        for (const part of chunk(saleLines)) {
          const { error } = await c.from("sale_lines").insert(part);
          if (error) throw new Error(`push sale_lines : ${error.message}`);
        }
        pushed += saleLines.length;
      }

      pushed += await upsert(c, "invoices", (batch.invoices || []).map(mapInvoice));
      pushed += await upsert(c, "fin_adjust", (batch.fin_adjust || []).map(mapFinAdjust));
      pushed += await upsert(c, "photos", (batch.photos || []).map(mapPhoto));
      try {
        pushed += await upsert(c, "stock_moves", (batch.stock_moves || []).map(mapStockMove));
      } catch (e) {
        if (!isMissingTable(e)) throw e;
      }

      const metaRows = [
        { key: "active_season", value: meta.active_season ?? null, updated_at: now() },
        { key: "categories", value: meta.categories ?? null, updated_at: now() },
      ];
      pushed += await upsert(c, "app_meta", metaRows, "key");

      return NextResponse.json({ pushed });
    }

    if (action === "pull") {
      const photosOnly = !!body.photosOnly;
      const omitPhotos = !!body.omitPhotos || photosOnly;

      if (photosOnly) {
        const remotePhotos = await fetchAll(c, "photos", "*", 50);
        return NextResponse.json({ photos: remotePhotos.map(fromPhoto) });
      }

      const [
        remoteSeasons,
        remoteProducts,
        remoteVariants,
        remoteStock,
        remoteMatches,
        remoteSales,
        remoteLines,
        remoteInvoices,
        remoteFinAdjust,
        remoteMeta,
        remotePhotos,
        remoteMoves,
      ] = await Promise.all([
        fetchAll(c, "seasons"),
        fetchAll(c, "products"),
        fetchAll(c, "product_variants"),
        fetchAll(c, "stock"),
        fetchAll(c, "matches"),
        fetchAll(c, "sales"),
        fetchAll(c, "sale_lines"),
        fetchAll(c, "invoices"),
        fetchAll(c, "fin_adjust"),
        fetchAll(c, "app_meta"),
        omitPhotos ? Promise.resolve([]) : fetchAll(c, "photos", "*", 50),
        fetchAllOptional(c, "stock_moves"),
      ]);

      const variantsByProduct = groupBy(remoteVariants as any[], "product_id");
      const products = (remoteProducts as any[]).map((p: any) => fromProduct(p, variantsByProduct[p.id] || []));
      const linesBySale = groupBy(remoteLines as any[], "sale_id");
      const sales = (remoteSales as any[]).map((s: any) => fromSale(s, linesBySale[s.id] || []));

      const meta: Record<string, { value: unknown; updated_at: string }> = {};
      for (const m of remoteMeta as any[]) {
        if (m.key !== "active_season" && m.key !== "categories") continue;
        meta[m.key] = { value: m.value, updated_at: m.updated_at || now() };
      }

      return NextResponse.json({
        seasons: (remoteSeasons as any[]).map(fromSeason),
        products,
        stock: (remoteStock as any[]).map(fromStock),
        matches: (remoteMatches as any[]).map(fromMatch),
        sales,
        invoices: (remoteInvoices as any[]).map(fromInvoice),
        finAdjust: (remoteFinAdjust as any[]).map(fromFinAdjust),
        photos: omitPhotos ? undefined : (remotePhotos as any[]).map(fromPhoto),
        stock_moves: remoteMoves ? (remoteMoves as any[]).map(fromStockMove) : undefined,
        meta,
      });
    }

    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur de synchronisation";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
