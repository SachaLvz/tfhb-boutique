import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { extractText } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 90;

const SIZE_SYSTEMS = ["maillot_enfant", "textile_enfant", "adulte", "tu"] as const;
const CATEGORIES_HINT = ["Maillot", "Textile", "Accessoire", "25/26"];

const SYSTEM_PROMPT = `Tu es un assistant d'import pour la boutique du club Tremblay Handball (TFHB).
Tu analyses le TEXTE extrait d'un PDF de devis (ex. 11teamsports) et tu extrais CHAQUE maillot
avec le DÉTAIL quantité × taille.

Réponds UNIQUEMENT en JSON valide (sans markdown) :
{
  "source_summary": "1 phrase",
  "products": [
    {
      "name": "Maillot Warm Up",
      "category": "Maillot",
      "source_line": "[JL8019] Handball 25 Jersey Men (35 S, 45 M, 45 L, 35 XL, 30 2XL)",
      "variants": [
        { "size": "S", "size_system": "adulte", "sale_price": 0, "purchase_price_ht": 41.67, "marking_cost": 0, "stock_physique": 35 },
        { "size": "M", "size_system": "adulte", "sale_price": 0, "purchase_price_ht": 41.67, "marking_cost": 0, "stock_physique": 45 },
        { "size": "L", "size_system": "adulte", "sale_price": 0, "purchase_price_ht": 41.67, "marking_cost": 0, "stock_physique": 45 },
        { "size": "XL", "size_system": "adulte", "sale_price": 0, "purchase_price_ht": 41.67, "marking_cost": 0, "stock_physique": 35 },
        { "size": "2XL", "size_system": "adulte", "sale_price": 0, "purchase_price_ht": 41.67, "marking_cost": 0, "stock_physique": 30 }
      ]
    }
  ]
}

FORMAT TYPIQUE :
MAILLOT WARM UP
[JL8019] Handball 25 Jersey Men (35 S, 45 M, 45 L, 35 XL, 30 2XL)

→ name = titre de section FR
→ source_line = ligne fournisseur AVEC les parenthèses
→ dans (…), schéma = (QUANTITÉ TAILLE, QUANTITÉ TAILLE, …)
→ 1 variante par taille. JAMAIS « S, M, L, XL » en une seule taille. JAMAIS le total seul.

Autres listes :
- (20 140, 25 152, 18 164, 16 176) → tailles 140, 152, 164, 176 (PAS 40, 52…)
- (10 5-6A, 12 7-8A, 8 9-10A, 6 15-16A) → garder 15-16A entier

Règles :
1. Un titre de section = un produit.
2. size = uniquement la taille. stock_physique = le nombre AVANT la taille.
3. size_system : adulte (S–2XL) ; maillot_enfant (140, 5-6A…) ; tu si unique.
4. Prix d'achat HT = 1er montant € après la qté (ex. 41,67 € = PV HT), PAS le prix après remise (25 €).
   sale_price (revente boutique) = 0.`;

const DETAIL_HINTS = /\b(domicile|ext[ée]rieur|exterior|home|away|warmup|warm[\s-]?up|gardien|rose|bleu|blanc|noir|vert)\b/i;

const LETTER_SIZES = String.raw`2XL|3XL|XXL|XS|S|M|L|XL|TU`;
const YOUTH_CM = String.raw`1\d{2}|2\d{2}`; // 140, 152, 164, 176…
const YOUTH_AGE = String.raw`\d{1,2}\s*[-/]\s*\d{1,2}A?|\d{1,2}A`; // 5-6A, 12A…

const SECTION_TITLE =
  /^(MAILLOT|SHORT|SURV[EÊ]TEMENT|SWEAT|POLO|T-?SHIRT|VESTE|PANTALON|BAS|CHAUSSETTES?|GANTS?|SAC|BONNET|HOODIE|ZIP)\b/i;

function inferSizeSystem(size: string, hinted?: string) {
  const hint = String(hinted || "");
  if (SIZE_SYSTEMS.includes(hint as (typeof SIZE_SYSTEMS)[number])) return hint;
  const s = size.trim().toUpperCase();
  if (s === "TU" || s.startsWith("TU ")) return "tu";
  if (/(\d+\s*[-/]\s*\d+|\d+A\b|5-6|7\/8|9\/10|11\/12|13\/14|15\/16|140|152|164|176|\d{3})/i.test(size)) {
    return "maillot_enfant";
  }
  if (/^(XS|S|M|L|XL|2XL|3XL|XXL)\b/.test(s)) return "adulte";
  return "adulte";
}

function normalizeSizeLabel(size: string) {
  return String(size)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

type ParsedVariant = {
  size: string;
  size_system: string;
  sale_price: number;
  purchase_price_ht: number | null;
  marking_cost: number;
  stock_physique: number;
};

type ParsedProduct = {
  name: string;
  category: string;
  source_line?: string;
  variants: ParsedVariant[];
};

type ParsedPayload = {
  source_summary?: string;
  products: ParsedProduct[];
};

/**
 * Parse uniquement les listes « (35 S, 45 M, …) » ou « (20 140, 25 152, …) ».
 * Exige un ESPACE entre quantité et taille pour ne jamais couper 140 → 1+40.
 */
function parseQtySizeList(text: string): { size: string; stock_physique: number }[] {
  const raw = String(text || "");
  if (!/[,(]/.test(raw) && !new RegExp(String.raw`\d+\s+(?:${LETTER_SIZES})\b`, "i").test(raw)) {
    return [];
  }
  const chunks: string[] = [];
  const parens = raw.match(/\(([^)]*)\)/g);
  if (parens?.length) chunks.push(...parens.map((x) => x.slice(1, -1)));
  else chunks.push(raw);

  const re = new RegExp(
    String.raw`(\d+)\s+(${LETTER_SIZES}|${YOUTH_CM}|${YOUTH_AGE})\b`,
    "gi",
  );
  const out: { size: string; stock_physique: number }[] = [];
  for (const chunk of chunks) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(chunk)) !== null) {
      const qty = Math.max(0, parseInt(m[1], 10) || 0);
      const size = normalizeSizeLabel(m[2].replace(/\s+/g, ""));
      if (!size || !qty) continue;
      const existing = out.find((x) => x.size.toUpperCase() === size.toUpperCase());
      if (existing) existing.stock_physique += qty;
      else out.push({ size, stock_physique: qty });
    }
  }
  return out;
}

function isCleanSizeToken(size: string) {
  const s = normalizeSizeLabel(size);
  return new RegExp(
    String.raw`^(?:${LETTER_SIZES}|${YOUTH_CM}|${YOUTH_AGE})$`,
    "i",
  ).test(s);
}

/** « S, M, L, XL » ou « 40, 52, 64, 76 » — taille agrégée invalide. */
function isAggregatedSizeLabel(size: string) {
  const parts = String(size)
    .split(/[,|;/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => isCleanSizeToken(p) || /^\d{2,3}$/.test(p));
}

function explodeVariants(variants: ParsedVariant[], fallbackText = ""): ParsedVariant[] {
  const result: ParsedVariant[] = [];
  const pushPair = (size: string, qty: number, template?: ParsedVariant) => {
    const clean = normalizeSizeLabel(size);
    if (!clean || isAggregatedSizeLabel(clean)) return;
    const size_system = inferSizeSystem(clean, template?.size_system);
    const existing = result.find((x) => x.size.toUpperCase() === clean.toUpperCase());
    if (existing) {
      if (qty > 0) existing.stock_physique = Math.max(existing.stock_physique, qty);
      return;
    }
    result.push({
      size: clean,
      size_system,
      sale_price: template?.sale_price || 0,
      purchase_price_ht: template?.purchase_price_ht ?? null,
      marking_cost: template?.marking_cost || 0,
      stock_physique: Math.max(0, qty),
    });
  };

  const fromFallback = parseQtySizeList(fallbackText);
  if (fromFallback.length >= 2) {
    const template = variants[0];
    for (const p of fromFallback) pushPair(p.size, p.stock_physique, template);
    return result;
  }

  for (const v of variants) {
    if (isAggregatedSizeLabel(v.size)) continue;
    if (/[,(]/.test(v.size) || /^\d+\s+(?:S|M|L|XL|2XL|3XL|XXL|TU)\b/i.test(v.size)) {
      const packed = parseQtySizeList(v.size);
      if (packed.length >= 1) {
        for (const p of packed) pushPair(p.size, p.stock_physique, v);
        continue;
      }
    }
    if (isCleanSizeToken(v.size) || v.size) {
      pushPair(v.size, Number(v.stock_physique) || 0, v);
    }
  }

  return result;
}

function parseSizeDetail(rawSize: string) {
  const label = normalizeSizeLabel(rawSize);
  const paren = label.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    return { size: paren[1].trim(), detail: paren[2].trim() };
  }
  const dashed = label.match(/^(XS|S|M|L|XL|2XL|3XL|XXL|\d[\d\s/.-]*\w*)\s*[-–:]\s*(.+)$/i);
  if (dashed && DETAIL_HINTS.test(dashed[2])) {
    return { size: dashed[1].trim(), detail: dashed[2].trim() };
  }
  const spaced = label.match(/^(XS|S|M|L|XL|2XL|3XL|XXL)\s+(.+)$/i);
  if (spaced && DETAIL_HINTS.test(spaced[2])) {
    return { size: spaced[1].trim(), detail: spaced[2].trim() };
  }
  return { size: label, detail: null as string | null };
}

function titleCaseDetail(d: string) {
  return d
    .replace(/\bdomicile\b/gi, "Domicile")
    .replace(/\bext[ée]rieurs?\b/gi, "Extérieur")
    .replace(/\bexterior\b/gi, "Extérieur")
    .replace(/\bhome\b/gi, "Domicile")
    .replace(/\baway\b/gi, "Extérieur")
    .replace(/\bwarm[\s-]?up\b/gi, "WarmUp")
    .replace(/\bgardien\b/gi, "Gardien")
    .replace(/\b\w+/g, (w) => (w === "WarmUp" ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .replace(/\bWarmup\b/g, "WarmUp");
}

function expandMaillotDetails(products: ParsedProduct[]): ParsedProduct[] {
  const out: ParsedProduct[] = [];

  for (const p of products) {
    const groups = new Map<string, ParsedVariant[]>();

    for (const v of p.variants || []) {
      const { size, detail } = parseSizeDetail(v.size);
      const key = detail ? titleCaseDetail(detail) : "";
      const clean: ParsedVariant = {
        ...v,
        size: size || v.size,
        size_system: inferSizeSystem(size || v.size, v.size_system),
      };
      if (!groups.has(key)) groups.set(key, []);
      const list = groups.get(key)!;
      const existing = list.find((x) => x.size === clean.size);
      if (existing) {
        existing.stock_physique += clean.stock_physique;
        if (!existing.sale_price && clean.sale_price) existing.sale_price = clean.sale_price;
        if (existing.purchase_price_ht == null && clean.purchase_price_ht != null) {
          existing.purchase_price_ht = clean.purchase_price_ht;
        }
      } else {
        list.push(clean);
      }
    }

    const baseName = String(p.name || "Article").replace(/\s*\((Domicile|Extérieur|Exterior|Home|Away)\)\s*$/i, "").trim();

    if (groups.size === 1 && groups.has("")) {
      out.push({ ...p, name: p.name, variants: groups.get("")! });
      continue;
    }

    for (const [detail, variants] of groups) {
      if (!variants.length) continue;
      let name = baseName;
      if (detail) {
        const already = new RegExp(`\\(\\s*${detail}\\s*\\)$`, "i").test(baseName);
        name = already ? baseName : `${baseName} (${detail})`;
      }
      out.push({
        name,
        category: p.category || "Maillot",
        variants,
      });
    }
  }

  return out;
}

function stripJsonFence(text: string) {
  const t = text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

function prettyProductName(raw: string) {
  return String(raw)
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => {
      if (/^(JR|XL|XXL|2XL|3XL)$/i.test(w)) return w.toUpperCase();
      if (/^\d/.test(w)) return w;
      const lower = w.toLocaleLowerCase("fr-FR");
      return lower.charAt(0).toLocaleUpperCase("fr-FR") + lower.slice(1);
    })
    .join(" ");
}

function inferCategory(name: string) {
  if (/maillot/i.test(name)) return "Maillot";
  if (/short|surv|sweat|polo|shirt|veste|pantalon|hoodie|zip/i.test(name)) return "Textile";
  if (/ballon|sac|gant|bonnet|chaussette|access/i.test(name)) return "Accessoire";
  return "Maillot";
}

/**
 * Prix d'achat HT = 1er montant € après la qté (= colonne PV HT du devis).
 * Ex. « … 2XL) 190 41,67 € 40.0 % 25,00 € 4 750,00 € »
 * → achat = 41,67 € (pas 25 € après remise, ni le total ligne).
 */
function parsePurchasePriceHt(text: string): number | null {
  const afterParen = String(text).match(/\)\s*(\d[\d\s.]*)\s+(\d+(?:[.,]\d{1,2})?)\s*€/);
  if (afterParen) {
    const n = Number(afterParen[2].replace(",", "."));
    return n > 0 ? n : null;
  }
  // Repli : premier montant € de la ligne
  const first = String(text).match(/(\d+(?:[.,]\d{1,2})?)\s*€/);
  if (first) {
    const n = Number(first[1].replace(",", "."));
    return n > 0 && n < 500 ? n : null;
  }
  return null;
}

/**
 * Le PDF coupe souvent les parenthèses sur 2 lignes :
 *   (35 S, 45 M, 45 L, 35 XL, 30
 *   2XL) 190 41,67 € …
 * On fusionne tant qu'une parenthèse est ouverte.
 * Corrige aussi « 1516A » → « 15-16A ».
 */
function normalizePdfText(text: string): string {
  const lines = String(text || "").split(/\r?\n/);
  const out: string[] = [];
  let buf = "";
  let depth = 0;

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (!buf) {
      buf = line;
      depth = (buf.match(/\(/g) || []).length - (buf.match(/\)/g) || []).length;
      if (depth <= 0) {
        out.push(buf);
        buf = "";
        depth = 0;
      }
      continue;
    }
    buf += ` ${line}`;
    depth = (buf.match(/\(/g) || []).length - (buf.match(/\)/g) || []).length;
    if (depth <= 0) {
      out.push(buf);
      buf = "";
      depth = 0;
    }
  }
  if (buf) out.push(buf);

  return out
    .join("\n")
    .replace(/\b(\d{2})(\d{2})A\b/g, "$1-$2A");
}

type QtyBlock = {
  name: string;
  source_line: string;
  pairs: { size: string; stock_physique: number }[];
  purchase_price_ht: number | null;
};

/** Extraction déterministe des blocs « TITRE + (35 S, 45 M, …) » depuis le texte PDF. */
function extractQtyBlocks(pdfText: string): QtyBlock[] {
  const lines = normalizePdfText(pdfText)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const blocks: QtyBlock[] = [];
  let currentTitle = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_TITLE.test(line) && !/\(\s*\d+\s+\S+/.test(line)) {
      currentTitle = prettyProductName(line);
      continue;
    }

    const pairs = parseQtySizeList(line);
    if (pairs.length < 2) continue;

    let name = currentTitle;
    if (!name) {
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        if (SECTION_TITLE.test(lines[j])) {
          name = prettyProductName(lines[j]);
          break;
        }
        if (!/^\[/.test(lines[j]) && lines[j].length > 3 && lines[j].length < 80) {
          name = prettyProductName(lines[j]);
          break;
        }
      }
    }
    if (!name) name = "Article";

    blocks.push({
      name,
      source_line: line,
      pairs: pairs.map((p) => ({ size: p.size, stock_physique: p.stock_physique })),
      purchase_price_ht: parsePurchasePriceHt(line),
    });
  }

  return blocks;
}

function catalogFromQtyBlocks(blocks: QtyBlock[]): ParsedProduct[] {
  return blocks.map((b) => ({
    name: b.name,
    category: inferCategory(b.name),
    source_line: b.source_line,
    variants: b.pairs.map((pair) => ({
      size: pair.size,
      size_system: inferSizeSystem(pair.size),
      sale_price: 0,
      purchase_price_ht: b.purchase_price_ht,
      marking_cost: 0,
      stock_physique: pair.stock_physique,
    })),
  }));
}

function nameKey(name: string) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesSimilar(a: string, b: string) {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.includes(kb) || kb.includes(ka)) return true;
  const ta = new Set(ka.split(" ").filter((t) => t.length > 1));
  const tb = kb.split(" ").filter((t) => t.length > 1);
  if (!tb.length) return false;
  const hit = tb.filter((t) => ta.has(t)).length;
  return hit >= Math.min(2, tb.length);
}

/** Les tailles/qté du texte PDF écrasent toujours celles de l'IA. */
function mergeTextWins(aiProducts: ParsedProduct[], textProducts: ParsedProduct[]): ParsedProduct[] {
  if (!textProducts.length) return aiProducts;
  if (!aiProducts.length) return textProducts;

  const usedAi = new Set<number>();
  const out: ParsedProduct[] = [];

  for (const tp of textProducts) {
    let bestIdx = -1;
    for (let i = 0; i < aiProducts.length; i++) {
      if (usedAi.has(i)) continue;
      if (namesSimilar(tp.name, aiProducts[i].name)) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx < 0) {
      out.push(tp);
      continue;
    }
    usedAi.add(bestIdx);
    const ai = aiProducts[bestIdx];
    // Prix PDF = achat ; la revente reste celle de l'IA seulement si déjà renseignée
    const purchase =
      tp.variants.find((v) => v.purchase_price_ht != null)?.purchase_price_ht ??
      ai.variants.find((v) => v.purchase_price_ht != null)?.purchase_price_ht ??
      null;
    const resale = ai.variants.find((v) => v.sale_price > 0)?.sale_price || 0;
    const marking = ai.variants.find((v) => v.marking_cost > 0)?.marking_cost || 0;

    out.push({
      name: ai.name?.length > tp.name.length ? ai.name : tp.name,
      category: ai.category || tp.category,
      source_line: tp.source_line || ai.source_line,
      variants: tp.variants.map((v) => ({
        ...v,
        sale_price: resale,
        purchase_price_ht: v.purchase_price_ht ?? purchase,
        marking_cost: marking,
      })),
    });
  }

  for (let i = 0; i < aiProducts.length; i++) {
    if (usedAi.has(i)) continue;
    const ai = aiProducts[i];
    const ok = ai.variants.filter((v) => isCleanSizeToken(v.size) && !isAggregatedSizeLabel(v.size));
    if (ok.length >= 2 && ok.some((v) => v.stock_physique > 0)) {
      out.push({ ...ai, variants: ok.map(coercePdfPriceAsPurchase) });
    }
  }

  return out;
}

/** Si l'IA a mis le prix devis dans sale_price, le basculer en achat HT. */
function coercePdfPriceAsPurchase(v: ParsedVariant): ParsedVariant {
  if (v.purchase_price_ht != null && v.purchase_price_ht > 0) {
    return { ...v, sale_price: 0 };
  }
  if (v.sale_price > 0) {
    return { ...v, purchase_price_ht: v.sale_price, sale_price: 0 };
  }
  return v;
}

/** Si l'IA a mal découpé, rattache chaque produit à un bloc (qté taille) du PDF. */
function repairFromPdfText(products: ParsedProduct[], pdfText: string): ParsedProduct[] {
  const blocks = extractQtyBlocks(pdfText);
  if (!blocks.length) return products;

  const used = new Set<number>();
  return products.map((p) => {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (used.has(i)) continue;
      if (!namesSimilar(p.name, blocks[i].name)) continue;
      const score = nameKey(blocks[i].name).split(" ").length;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const broken =
      p.variants.length <= 1 ||
      p.variants.some((v) => isAggregatedSizeLabel(v.size)) ||
      p.variants.every((v) => !v.stock_physique);
    if (best < 0 && broken) {
      for (let i = 0; i < blocks.length; i++) {
        if (!used.has(i)) {
          best = i;
          break;
        }
      }
    }
    if (best < 0) return { ...p, variants: p.variants.map(coercePdfPriceAsPurchase) };
    used.add(best);
    const b = blocks[best];
    const purchase =
      b.purchase_price_ht ??
      p.variants.find((v) => v.purchase_price_ht != null)?.purchase_price_ht ??
      null;
    const marking = p.variants.find((v) => v.marking_cost > 0)?.marking_cost || 0;
    return {
      ...p,
      name: p.name || b.name,
      source_line: b.source_line,
      variants: b.pairs.map((pair) => ({
        size: pair.size,
        size_system: inferSizeSystem(pair.size),
        sale_price: 0,
        purchase_price_ht: purchase,
        marking_cost: marking,
        stock_physique: pair.stock_physique,
      })),
    };
  });
}

function normalizePayload(raw: unknown, pdfText = ""): ParsedPayload {
  const obj = (
    typeof raw === "string" ? JSON.parse(stripJsonFence(raw)) : raw
  ) as ParsedPayload & {
    products: Array<ParsedProduct & { source_line?: string; line?: string; raw?: string }>;
  };
  if (!obj || !Array.isArray(obj.products)) {
    throw new Error("Réponse IA invalide (pas de liste products).");
  }

  const products: ParsedProduct[] = [];
  for (const p of obj.products) {
    if (!p?.name) continue;
    const category = String(p.category || "Maillot").trim() || "Maillot";
    const source_line = String(p.source_line || p.line || p.raw || "").trim();
    const name = String(p.name)
      .trim()
      .replace(/^\[.*?\]\s*/, "")
      .replace(/\s+/g, " ");

    const baseVariants: ParsedVariant[] = [];
    for (const v of p.variants || []) {
      if (!v?.size && !source_line) continue;
      const size = normalizeSizeLabel(String(v?.size || ""));
      if (isAggregatedSizeLabel(size)) continue;
      const qtyRaw =
        v?.stock_physique ??
        (v as { quantity?: number })?.quantity ??
        (v as { qty?: number })?.qty ??
        0;
      baseVariants.push({
        size: size || "TU",
        size_system: inferSizeSystem(size || "TU", v?.size_system),
        sale_price: Math.max(0, Number(v?.sale_price) || 0),
        purchase_price_ht:
          v?.purchase_price_ht == null || (v.purchase_price_ht as unknown) === ""
            ? null
            : Math.max(0, Number(v.purchase_price_ht) || 0),
        marking_cost: Math.max(0, Number(v?.marking_cost) || 0),
        stock_physique: Math.max(0, Math.round(Number(qtyRaw) || 0)),
      });
    }

    const lineBlob = [
      source_line,
      ...(p.variants || []).map((v) => String(v?.size || "")),
    ].join(" ");
    let variants = explodeVariants(baseVariants, lineBlob);

    if (!variants.length && source_line) {
      variants = explodeVariants([], source_line);
    }

    const fromLine = parseQtySizeList(lineBlob);
    if (fromLine.length >= 2) {
      const template = baseVariants[0] || variants[0];
      variants = fromLine.map((pair) => ({
        size: pair.size,
        size_system: inferSizeSystem(pair.size, template?.size_system),
        sale_price: template?.sale_price || 0,
        purchase_price_ht: template?.purchase_price_ht ?? null,
        marking_cost: template?.marking_cost || 0,
        stock_physique: pair.stock_physique,
      }));
    }

    if (!variants.length) continue;
    products.push({ name, category, source_line, variants });
  }

  const textProducts = catalogFromQtyBlocks(extractQtyBlocks(pdfText));
  const merged = mergeTextWins(products, textProducts);
  const repaired = repairFromPdfText(merged.length ? merged : textProducts, pdfText);
  const finalProducts = repaired.length ? repaired : products;

  if (!finalProducts.length) {
    throw new Error("Aucun article reconnu dans le PDF.");
  }

  const expanded = expandMaillotDetails(finalProducts).map((p) => ({
    ...p,
    variants: p.variants.map(coercePdfPriceAsPurchase),
  }));
  if (!expanded.length) {
    throw new Error("Aucun article reconnu dans le PDF.");
  }

  return {
    source_summary: obj.source_summary || "",
    products: expanded,
  };
}

function resolveProvider() {
  const anthropic =
    process.env.ANTHROPIC_API_KEY?.trim() ||
    (process.env.OPENAI_API_KEY?.trim()?.startsWith("sk-ant-")
      ? process.env.OPENAI_API_KEY.trim()
      : "");
  const openai = process.env.OPENAI_API_KEY?.trim();

  if (anthropic && anthropic.startsWith("sk-ant-")) {
    return { provider: "anthropic" as const, apiKey: anthropic };
  }
  if (openai && openai.startsWith("sk-") && !openai.startsWith("sk-xxxx")) {
    return { provider: "openai" as const, apiKey: openai };
  }
  return null;
}

async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const result = await extractText(new Uint8Array(buf), { mergePages: true });
    return String(result.text || "").trim();
  } catch (e) {
    console.warn("[import-pdf] extractText failed", e);
    return "";
  }
}

async function analyzeWithAnthropic(apiKey: string, pdfText: string, base64: string, fileName: string) {
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

  const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];
  if (pdfText && pdfText.length > 40) {
    const clipped = pdfText.length > 100_000 ? pdfText.slice(0, 100_000) : pdfText;
    content.push({
      type: "text",
      text:
        `Texte extrait du PDF « ${fileName} » :\n\n${clipped}\n\n` +
        `Extrais CHAQUE maillot avec 1 variante par taille (ex. S:35, M:45…). ` +
        `Copie source_line avec les parenthèses. JSON strict.`,
    });
  } else {
    content.push(
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64,
        },
      },
      {
        type: "text",
        text:
          `Format : MAILLOT WARM UP puis ligne (35 S, 45 M, …). ` +
          `1 variante par taille. Fichier « ${fileName} ». JSON strict.`,
      },
    );
  }

  const msg = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
  if (!text) throw new Error("Réponse vide de Claude");
  return { text, model: msg.model };
}

async function analyzeWithOpenAI(apiKey: string, pdfText: string, dataUrl: string, fileName: string) {
  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o";

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (pdfText && pdfText.length > 40) {
    const clipped = pdfText.length > 100_000 ? pdfText.slice(0, 100_000) : pdfText;
    userContent.push({
      type: "text",
      text:
        `Texte extrait du PDF « ${fileName} » :\n\n${clipped}\n\n` +
        `1 variante par taille avec stock_physique. Catégories : ${CATEGORIES_HINT.join(", ")}. JSON strict.`,
    });
  } else {
    userContent.push(
      {
        type: "file",
        file: {
          filename: fileName || "catalogue.pdf",
          file_data: dataUrl,
        },
      },
      {
        type: "text",
        text:
          `Pour CHAQUE maillot, chaque taille avec SA quantité. Fichier « ${fileName} ». JSON strict.`,
      },
    );
  }

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("Réponse vide de ChatGPT");
  return { text, model: completion.model };
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Formulaire invalide" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Fichier PDF requis (champ « file »)" }, { status: 400 });
  }
  const lower = file.name.toLowerCase();
  const mime = (file.type || "").toLowerCase();
  const looksPdf =
    lower.endsWith(".pdf") ||
    mime === "application/pdf" ||
    mime === "application/x-pdf";
  if (!looksPdf) {
    return NextResponse.json({ error: "Le fichier doit être un PDF (.pdf)" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "PDF trop volumineux (max 20 Mo)" }, { status: 400 });
  }
  if (file.size < 64) {
    return NextResponse.json({ error: "Fichier PDF vide ou invalide" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;
  const fileName = file.name || "catalogue.pdf";
  const pdfText = await extractPdfText(buf);

  // Source de vérité : listes « (35 S, 45 M, …) » dans le texte PDF (une variante = une taille)
  const textOnly = catalogFromQtyBlocks(extractQtyBlocks(pdfText));
  const textExpanded = textOnly.length ? expandMaillotDetails(textOnly) : [];

  if (textExpanded.length >= 1) {
    const nVar = textExpanded.reduce((a, p) => a + p.variants.length, 0);
    const nQty = textExpanded.reduce(
      (a, p) => a + p.variants.reduce((b, v) => b + (v.stock_physique || 0), 0),
      0,
    );
    return NextResponse.json({
      ok: true,
      fileName,
      provider: "text",
      model: "pdf-text",
      parse_mode: "text",
      source_summary: `${textExpanded.length} maillot(s), ${nVar} taille(s), ${nQty} pièce(s) — détail extrait du PDF.`,
      products: textExpanded,
    });
  }

  // Repli IA si le PDF n'a pas de listes (qté taille) exploitables
  const creds = resolveProvider();
  if (!creds) {
    return NextResponse.json(
      {
        error:
          "Aucune liste (qté taille) trouvée dans le PDF, et pas de clé API. Ajoute ANTHROPIC_API_KEY ou OPENAI_API_KEY dans .env.",
      },
      { status: 500 },
    );
  }

  try {
    const { text, model } =
      creds.provider === "anthropic"
        ? await analyzeWithAnthropic(creds.apiKey, pdfText, base64, fileName)
        : await analyzeWithOpenAI(creds.apiKey, pdfText, dataUrl, fileName);

    const parsed = normalizePayload(text, pdfText);
    return NextResponse.json({
      ok: true,
      fileName,
      provider: creds.provider,
      model,
      parse_mode: "ai",
      ...parsed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erreur d'analyse PDF";
    console.error("[import-pdf]", e);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
