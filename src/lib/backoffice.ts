// @ts-nocheck — logique legacy migrée ; typage progressif
// Back-office (Lot 2) : catalogue & stock éditables, historique des ventes,
// factures & marquage, import/export Excel (SheetJS). Ordinateur d'abord.
import * as XLSX from 'xlsx';
import * as db from './db';
import { CATEGORIES, SIZE_SYSTEMS, sku } from './catalog';

// Impératif DOM : reload complet si ce module est remplacé en HMR
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
  const hot = (typeof module !== 'undefined' && module.hot)
    || (typeof import.meta !== 'undefined' && import.meta.hot)
    || null;
  if (hot?.dispose) hot.dispose(() => { window.location.reload(); });
}

const eur = (v) => (Math.round((v || 0) * 100) / 100).toLocaleString('fr-FR') + ' €';
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const LOCATIONS = [['physique', 'Physique'], ['en_ligne', 'En ligne'], ['salarie', 'Salariés'], ['archive', 'Archive']];
const PAY = { espece: 'Espèces', cb: 'CB', cheque: 'Chèque' };
const LINE_MODES = { abonne: 'Abonné', com: 'Imput. com', special: 'Demande spéciale' };

let ctx = { toast: () => {} };
let host = null;
let sub = 'catalogue';
let cache = { products: [], stock: {}, matches: [], invoices: [], sales: [] };

export async function renderBackoffice(container, context) {
  ctx = context || ctx;
  host = container;
  await reload();
  paint();
}

async function reload() {
  cache.seasonId = await db.activeSeasonId();
  cache.products = await db.listProducts();
  cache.categories = await db.getCategories();
  cache.photos = await db.photosMap();
  cache.stock = await db.stockMap();
  cache.matches = await db.listMatches();
  cache.invoices = await db.listInvoices();
  cache.sales = await db.allSales(cache.seasonId);
  cache.internes = await db.getVentesInternes(cache.seasonId);
  // agrégat des ventes par sku (saison active) : quantité + total €
  cache.sold = {};
  for (const s of cache.sales) for (const l of (s.lines || [])) {
    const a = (cache.sold[l.sku] = cache.sold[l.sku] || { qty: 0, euro: 0 });
    a.qty += l.qty || 0; a.euro += l.line_total || 0;
  }
}

const SUBS = [
  ['catalogue', 'Catalogue & Stock'],
  ['ventes', 'Historique ventes'],
  ['factures', 'Factures & Marquage'],
  ['io', 'Import / Export'],
];

function paint() {
  host.innerHTML = '';
  const wrap = el(`<div class="bo">
    <div class="bo-tabs">${SUBS.map(([id, l]) => `<button data-s="${id}" class="${id === sub ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="bo-body" id="boBody"></div>
  </div>`);
  host.appendChild(wrap);
  wrap.querySelectorAll('.bo-tabs button').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.s === sub) return;
    sub = b.dataset.s;
    wrap.querySelectorAll('.bo-tabs button').forEach((x) => x.classList.toggle('on', x.dataset.s === sub));
    const body = wrap.querySelector('#boBody');
    body.innerHTML = `<div class="page-loader page-loader-inline" role="status">
      <div class="page-loader-spin" aria-hidden="true"></div>
      <p>Chargement…</p>
    </div>`;
    // laisse le navigateur peindre le loader avant le rendu sync
    await new Promise((r) => requestAnimationFrame(() => r()));
    body.innerHTML = '';
    if (sub === 'catalogue') renderCatalogue(body);
    else if (sub === 'ventes') renderVentes(body);
    else if (sub === 'factures') renderFactures(body);
    else renderIO(body);
  }));
  const body = wrap.querySelector('#boBody');
  if (sub === 'catalogue') renderCatalogue(body);
  else if (sub === 'ventes') renderVentes(body);
  else if (sub === 'factures') renderFactures(body);
  else renderIO(body);
}

/* ============ CATALOGUE & STOCK ============ */
function renderCatalogue(body) {
  body.innerHTML = `
    <div class="bo-toolbar">
      <input id="boSearch" class="bo-input" placeholder="Rechercher un article…" />
      <div class="bo-transfer">
        <b>Transfert stock</b>
        <select id="tSku" class="bo-input"></select>
        <select id="tFrom" class="bo-input">${LOCATIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <span>→</span>
        <select id="tTo" class="bo-input">${LOCATIONS.map(([k, l]) => `<option value="${k}" ${k === 'physique' ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="tQty" class="bo-input qty" type="number" min="1" value="1" />
        <button id="tGo" class="bo-btn">Transférer</button>
      </div>
      <div class="bo-transfer">
        <b>Total ventes salariés</b>
        <span id="internesTotal" class="internes-total">${eur(cache.internes || 0)}</span>
        <span class="muted mini">(= somme de la colonne « Vente salariés € », comptée dans les recettes)</span>
      </div>
      <button id="addProd" class="bo-btn primary">＋ Ajouter un article</button>
    </div>
    <input type="file" id="photoFile" accept="image/*" hidden>
    <div class="bo-tablewrap"><table class="bo-table" id="catTable"></table></div>`;

  fillTransferSkus(body);
  drawCatTable(body, '');
  body.querySelector('#boSearch').addEventListener('input', (e) => drawCatTable(body, e.target.value.toLowerCase()));
  body.querySelector('#addProd').addEventListener('click', () => openProductModal());
  body.querySelector('#photoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file || !pendingPhotoPid) return;
    try {
      const dataUrl = await resizeImage(file, 640);
      await db.savePhoto(pendingPhotoPid, dataUrl);
      cache.photos = await db.photosMap();
      drawCatTable(body, body.querySelector('#boSearch').value.toLowerCase());
      ctx.toast('Photo importée ✓');
    } catch (err) { ctx.toast('Erreur photo : ' + err.message); }
    pendingPhotoPid = null;
  });
  body.querySelector('#tGo').addEventListener('click', async () => {
    const s = body.querySelector('#tSku').value, from = body.querySelector('#tFrom').value, to = body.querySelector('#tTo').value;
    const qty = +body.querySelector('#tQty').value;
    if (!s || from === to || qty <= 0) return ctx.toast('Transfert invalide');
    await db.transferStock(s, from, to, qty);
    await reload(); paint();
    ctx.toast('Stock transféré');
  });
}

function fillTransferSkus(body) {
  const opts = [];
  for (const p of cache.products) for (const v of p.variants) opts.push(`<option value="${sku(p.id, v.size)}">${p.name} · ${v.size}</option>`);
  body.querySelector('#tSku').innerHTML = opts.join('');
}

function drawCatTable(body, filter) {
  const t = body.querySelector('#catTable');
  const head = `<thead><tr>
    <th>Article</th><th>Taille</th><th>Prix vente €</th><th>Prix achat HT €</th><th>Marquage €</th>
    <th>Physique</th><th>En ligne</th><th>Total qté</th><th>Qté salariés</th><th>Vente salariés €</th><th>Ventes €</th><th></th></tr></thead>`;
  const rows = [];
  for (const p of cache.products) {
    if (filter && !p.name.toLowerCase().includes(filter)) continue;
    const hasPhoto = !!cache.photos[p.id];
    rows.push(`<tr class="prow"><td colspan="5"><span class="prow-main">
        ${hasPhoto ? `<img class="prow-thumb" src="${cache.photos[p.id]}" alt="">` : ''}
        <b>${p.name}</b> <span class="cat-badge">${p.category}</span>
        <button class="bo-btn mini" data-photo="${p.id}">📷 ${hasPhoto ? 'Changer la photo' : 'Ajouter une photo'}</button>
        ${hasPhoto ? `<button class="bo-btn mini" data-photodel="${p.id}">Retirer</button>` : ''}
      </span></td>
      <td colspan="6" class="muted">${p.variants.length} taille(s)</td>
      <td><button class="bo-x" data-del="${p.id}" title="Supprimer l'article">🗑</button></td></tr>`);
    for (const v of p.variants) {
      const s = cache.stock[sku(p.id, v.size)] || {};
      const tot = (s.physique || 0) + (s.en_ligne || 0);
      const sold = cache.sold[sku(p.id, v.size)] || { qty: 0, euro: 0 };
      const cell = (loc) => `<td><input class="bo-cell num" data-p="${p.id}" data-size="${enc(v.size)}" data-stock="${loc}" type="number" min="0" value="${s[loc] || 0}"></td>`;
      rows.push(`<tr>
        <td class="muted">${p.name}</td><td>${v.size}</td>
        <td><input class="bo-cell num" data-p="${p.id}" data-size="${enc(v.size)}" data-field="sale_price" type="number" min="0" step="0.5" value="${v.sale_price}"></td>
        <td><input class="bo-cell num" data-p="${p.id}" data-size="${enc(v.size)}" data-field="purchase_price_ht" type="number" min="0" step="0.01" value="${v.purchase_price_ht ?? ''}" placeholder="—"></td>
        <td><input class="bo-cell num" data-p="${p.id}" data-size="${enc(v.size)}" data-field="marking_cost" type="number" min="0" step="0.01" value="${v.marking_cost || 0}"></td>
        ${cell('physique')}${cell('en_ligne')}
        <td class="num total-cell"><b>${tot}</b></td>
        <td><input class="bo-cell num sal" data-p="${p.id}" data-size="${enc(v.size)}" data-stock="salarie" type="number" min="0" value="${s.salarie || 0}"></td>
        <td><input class="bo-cell num" data-p="${p.id}" data-size="${enc(v.size)}" data-saleuro="1" type="number" min="0" step="0.01" value="${s.sal_euro || 0}"></td>
        <td class="num">${sold.qty ? `<b>${eur(sold.euro)}</b> <span class="muted">(${sold.qty})</span>` : '<span class="muted">—</span>'}</td>
        <td></td></tr>`);
    }
  }
  t.innerHTML = head + `<tbody>${rows.join('')}</tbody>`;
  t.querySelectorAll('.bo-cell').forEach((inp) => inp.addEventListener('change', onCellChange));
  t.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => confirmDeleteProduct(b.dataset.del)));
  t.querySelectorAll('[data-photo]').forEach((b) => b.addEventListener('click', () => {
    pendingPhotoPid = b.dataset.photo; body.querySelector('#photoFile').click();
  }));
  t.querySelectorAll('[data-photodel]').forEach((b) => b.addEventListener('click', async () => {
    await db.deletePhoto(b.dataset.photodel); cache.photos = await db.photosMap();
    drawCatTable(body, filter); ctx.toast('Photo retirée');
  }));
}

let pendingPhotoPid = null;
function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w >= h && w > max) { h = Math.round(h * max / w); w = max; }
      else if (h > w && h > max) { w = Math.round(w * max / h); h = max; }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject; img.src = url;
  });
}

async function onCellChange(e) {
  const inp = e.target;
  const pid = inp.dataset.p, size = dec(inp.dataset.size);
  if (inp.dataset.saleuro) {
    const total = await db.setSalarieEuro(sku(pid, size), +inp.value);
    cache.internes = total;
    const disp = document.getElementById('internesTotal');
    if (disp) disp.textContent = eur(total);
    ctx.toast('Vente salariés enregistrée (comptée dans les recettes)');
  } else if (inp.dataset.stock) {
    await db.setStockValue(sku(pid, size), inp.dataset.stock, +inp.value);
    cache.stock = await db.stockMap();
    // maj de la colonne Total qté en direct
    const s = cache.stock[sku(pid, size)] || {};
    const tot = (s.physique || 0) + (s.en_ligne || 0);
    const cell = inp.closest('tr').querySelector('.total-cell b');
    if (cell) cell.textContent = tot;
    ctx.toast('Stock enregistré');
  } else {
    const p = cache.products.find((x) => x.id === pid);
    const v = p.variants.find((x) => x.size === size);
    const f = inp.dataset.field;
    v[f] = inp.value === '' ? (f === 'purchase_price_ht' ? null : 0) : +inp.value;
    await db.saveProduct(p);
    ctx.toast('Prix enregistré');
  }
}

function confirmDeleteProduct(pid) {
  const p = cache.products.find((x) => x.id === pid);
  if (!p) return;
  openModal(`<h3>Supprimer « ${p.name} » ?</h3>
    <p class="muted">L'article et son stock seront retirés du catalogue. Les ventes déjà enregistrées ne sont pas modifiées.</p>
    <div class="modal-actions"><button class="bo-btn" data-close>Annuler</button>
    <button class="bo-btn danger" id="doDel">Supprimer</button></div>`, (m) => {
    m.querySelector('#doDel').addEventListener('click', async () => {
      await db.deleteProduct(pid); closeModal(); await reload(); paint(); ctx.toast('Article supprimé');
    });
  });
}

/* ----- modal ajout / édition d'article ----- */
function openProductModal() {
  const sysOpts = Object.keys(SIZE_SYSTEMS).map((k) => `<option value="${k}">${k}</option>`).join('');
  openModal(`<h3>Nouvel article</h3>
    <div class="form-grid">
      <label>Nom<input id="pName" class="bo-input" placeholder="Ex : Maillot Bleu"></label>
      <label>Catégorie<select id="pCat" class="bo-input">${cache.categories.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label>Système de tailles<select id="pSys" class="bo-input">${sysOpts}</select></label>
      <label>Prix de vente enfant €<input id="pChild" class="bo-input" type="number" step="0.5" placeholder="ex 60"></label>
      <label>Prix de vente adulte €<input id="pAdult" class="bo-input" type="number" step="0.5" placeholder="ex 70"></label>
      <label>Prix d'achat HT €<input id="pAchat" class="bo-input" type="number" step="0.01" placeholder="optionnel"></label>
    </div>
    <p class="muted mini" id="pHint"></p>
    <div class="modal-actions"><button class="bo-btn" data-close>Annuler</button>
    <button class="bo-btn primary" id="pSave">Créer l'article</button></div>`, (m) => {
    const hint = () => {
      const sys = m.querySelector('#pSys').value;
      const childRow = m.querySelector('#pChild').closest('label');
      const hasChild = sys === 'maillot_enfant' || sys === 'textile_enfant';
      childRow.style.opacity = hasChild ? 1 : .4;
      m.querySelector('#pChild').disabled = !hasChild;
      m.querySelector('#pHint').textContent = `Tailles : ${SIZE_SYSTEMS[sys].join(', ')}`;
    };
    m.querySelector('#pSys').addEventListener('change', hint); hint();
    m.querySelector('#pSave').addEventListener('click', async () => {
      const name = m.querySelector('#pName').value.trim();
      if (!name) return ctx.toast('Nom requis');
      const sys = m.querySelector('#pSys').value;
      const child = parseFloat(m.querySelector('#pChild').value) || 0;
      const adult = parseFloat(m.querySelector('#pAdult').value) || 0;
      const achat = m.querySelector('#pAchat').value === '' ? null : +m.querySelector('#pAchat').value;
      const hasChild = sys === 'maillot_enfant' || sys === 'textile_enfant';
      const id = slug(name) + '_' + Math.random().toString(16).slice(2, 6);
      const variants = [];
      if (hasChild) for (const s of SIZE_SYSTEMS[sys]) variants.push(mkVar(s, sys, child, achat));
      const adultSys = hasChild ? 'adulte' : sys;
      for (const s of SIZE_SYSTEMS[adultSys]) variants.push(mkVar(s, adultSys, hasChild ? adult : (adult || child), achat));
      await db.saveProduct({ id, name, category: m.querySelector('#pCat').value, variants });
      closeModal(); await reload(); paint(); ctx.toast('Article créé');
    });
  });
}
const mkVar = (size, size_system, price, achat) => ({ size, size_system, sale_price: price, purchase_price_ht: achat, marking_cost: 0 });

/* ============ HISTORIQUE VENTES ============ */
let vMode = 'detail';
function renderVentes(body) {
  const matchOpts = ['<option value="">Tous les matchs</option>']
    .concat(cache.matches.map((m) => `<option value="${m.id}">${m.code} ${m.label}</option>`)).join('');
  const chanLabel = (c) => c === 'en_ligne' ? 'En ligne' : c === 'salarie' ? 'Salariés' : 'Physique';
  body.innerHTML = `
    <div class="bo-toolbar">
      <div class="bo-subtabs">
        <button id="vDetail" class="bo-btn ${vMode === 'detail' ? 'on' : ''}">Ventes détaillées</button>
        <button id="vResume" class="bo-btn ${vMode === 'resume' ? 'on' : ''}">Résumé par match</button>
      </div>
      <select id="vMatch" class="bo-input">${matchOpts}</select>
      <div class="bo-kpis" id="vKpis"></div>
      <button id="vExport" class="bo-btn" title="Exporter le résumé par match (Excel)">⬇ Résumé Excel</button>
    </div>
    <div class="bo-tablewrap"><table class="bo-table" id="vTable"></table></div>`;

  const getSales = () => {
    const mid = body.querySelector('#vMatch').value;
    let sales = cache.sales.slice();
    if (mid) sales = sales.filter((s) => s.matchId === mid);
    return sales;
  };
  // agrégat par match
  const byMatch = (sales) => {
    const m = {};
    for (const s of sales) {
      const k = s.matchLabel || '—';
      (m[k] = m[k] || { match: k, code: (s.matchLabel || '').split(' ')[0], nb: 0, total: 0, com: 0, arts: 0 });
      m[k].nb += 1; m[k].total += s.total; m[k].com += (s.com_total || 0);
      m[k].arts += s.lines.reduce((a, l) => a + l.qty, 0);
    }
    return Object.values(m).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'fr', { numeric: true }));
  };

  const drawKpis = (sales) => {
    const total = sales.reduce((a, s) => a + s.total, 0);
    const com = sales.reduce((a, s) => a + (s.com_total || 0), 0);
    body.querySelector('#vKpis').innerHTML =
      `<span><b>${sales.length}</b> ventes</span><span><b>${eur(total)}</b> recettes</span><span><b>${eur(com)}</b> imputation com</span>`;
  };

  const drawDetail = () => {
    const sales = getSales().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    drawKpis(sales);
    const rows = sales.map((s) => {
      const detail = s.lines.map((l) =>
        `<div class="sale-item"><b>${l.qty}×</b> ${l.name} <span class="sz-badge">${l.size}</span>${l.mode !== 'plein' ? ` <span class="muted">(${LINE_MODES[l.mode] || l.mode})</span>` : ''} <span class="muted">— ${eur(l.line_total)}</span></div>`).join('');
      return `<tr>
        <td>${s.created_at ? new Date(s.created_at).toLocaleString('fr-FR') : '—'}</td>
        <td>${s.matchLabel || '—'}</td><td>${chanLabel(s.channel)}</td><td>${PAY[s.payment_method] || '—'}</td>
        <td>${detail}</td><td class="num">${eur(s.total)}</td>
        <td><button class="bo-x" data-void="${s.id}" title="Annuler la vente (remet le stock)">Annuler</button></td></tr>`;
    }).join('');
    body.querySelector('#vTable').innerHTML =
      `<thead><tr><th>Date</th><th>Match</th><th>Canal</th><th>Paiement</th><th>Articles achetés</th><th>Total</th><th></th></tr></thead>`
      + `<tbody>${rows || '<tr><td colspan="7" class="muted">Aucune vente</td></tr>'}</tbody>`;
    body.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', async () => {
      await db.voidSale(b.dataset.void); cache.sales = await db.allSales(cache.seasonId); cache.stock = await db.stockMap();
      drawDetail(); ctx.toast('Vente annulée, stock rétabli');
    }));
  };

  const drawResume = () => {
    const sales = getSales();
    drawKpis(sales);
    const rows = byMatch(sales).map((r) => `<tr>
      <td><b>${r.match}</b></td><td class="num">${r.nb}</td><td class="num">${r.arts}</td>
      <td class="num">${eur(r.total)}</td><td class="num">${eur(r.com)}</td>
      <td class="num">${eur(r.nb ? r.total / r.nb : 0)}</td></tr>`).join('');
    body.querySelector('#vTable').innerHTML =
      `<thead><tr><th>Match</th><th>Ventes</th><th>Articles</th><th>Recettes</th><th>Imput. com</th><th>Panier moyen</th></tr></thead>`
      + `<tbody>${rows || '<tr><td colspan="6" class="muted">Aucune vente</td></tr>'}</tbody>`;
  };

  const draw = () => (vMode === 'detail' ? drawDetail() : drawResume());
  const setMode = (mode) => {
    vMode = mode;
    body.querySelector('#vDetail').classList.toggle('on', mode === 'detail');
    body.querySelector('#vResume').classList.toggle('on', mode === 'resume');
    draw();
  };
  body.querySelector('#vDetail').addEventListener('click', () => setMode('detail'));
  body.querySelector('#vResume').addEventListener('click', () => setMode('resume'));
  body.querySelector('#vMatch').addEventListener('change', draw);
  body.querySelector('#vExport').addEventListener('click', () => {
    const rows = byMatch(getSales()).map((r) => ({
      Match: r.match, Ventes: r.nb, Articles: r.arts,
      Recettes: Math.round(r.total * 100) / 100, 'Imputation com': Math.round(r.com * 100) / 100,
      'Panier moyen': r.nb ? Math.round(r.total / r.nb * 100) / 100 : 0,
    }));
    
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Match: 'Aucune vente' }]), 'Résumé par match');
    XLSX.writeFile(wb, 'Resume_ventes_par_match.xlsx');
    ctx.toast('Résumé exporté');
  });
  draw();
}

/* ============ FACTURES & MARQUAGE ============ */
function renderFactures(body) {
  body.innerHTML = `
    <div class="bo-toolbar">
      <b>Ajouter</b>
      <input id="fRef" class="bo-input" placeholder="Réf facture (ex FAC/2025/15652)">
      <select id="fType" class="bo-input"><option value="achat">Achat HT</option><option value="marquage">Marquage</option></select>
      <input id="fAmount" class="bo-input qty" type="number" step="0.01" placeholder="Montant €">
      <button id="fAdd" class="bo-btn primary">Ajouter</button>
    </div>
    <div class="bo-kpis big" id="fKpis"></div>
    <div class="bo-tablewrap"><table class="bo-table" id="fTable"></table></div>`;
  const draw = () => {
    const achat = cache.invoices.filter((i) => i.type === 'achat').reduce((a, i) => a + (+i.amount || 0), 0);
    const marq = cache.invoices.filter((i) => i.type === 'marquage').reduce((a, i) => a + (+i.amount || 0), 0);
    body.querySelector('#fKpis').innerHTML =
      `<span>Coûts d'achat HT<b>${eur(achat)}</b></span><span>Coûts marquage<b>${eur(marq)}</b></span>`
      + `<span>Total coûts<b>${eur(achat + marq)}</b></span>`;
    const rows = cache.invoices.map((i) =>
      `<tr><td>${i.ref || '—'}</td><td>${i.type === 'achat' ? 'Achat HT' : 'Marquage'}</td>
        <td class="num">${eur(+i.amount || 0)}</td>
        <td><button class="bo-x" data-di="${i.id}">🗑</button></td></tr>`).join('');
    body.querySelector('#fTable').innerHTML =
      `<thead><tr><th>Référence</th><th>Type</th><th>Montant</th><th></th></tr></thead>`
      + `<tbody>${rows || '<tr><td colspan="4" class="muted">Aucune facture</td></tr>'}</tbody>`;
    body.querySelectorAll('[data-di]').forEach((b) => b.addEventListener('click', async () => {
      await db.deleteInvoice(b.dataset.di); cache.invoices = await db.listInvoices(); draw();
    }));
  };
  body.querySelector('#fAdd').addEventListener('click', async () => {
    const ref = body.querySelector('#fRef').value.trim();
    const amount = parseFloat(body.querySelector('#fAmount').value);
    if (!amount) return ctx.toast('Montant requis');
    await db.saveInvoice({ ref, type: body.querySelector('#fType').value, amount });
    cache.invoices = await db.listInvoices();
    body.querySelector('#fRef').value = ''; body.querySelector('#fAmount').value = '';
    draw(); ctx.toast('Facture ajoutée');
  });
  draw();
}

/* ============ IMPORT / EXPORT ============ */
function renderIO(body) {
  body.innerHTML = `
    <div class="io-cards">
      <div class="io-card">
        <h3>Exporter</h3>
        <p class="muted">Classeur Excel complet : catalogue, stock, ventes, factures. Archivage fin de saison et édition hors-ligne.</p>
        <button type="button" id="expBtn" class="bo-btn primary">Exporter le classeur (.xlsx)</button>
      </div>
      <div class="io-card io-card-wide">
        <h3>Importer</h3>
        <p class="muted">
          Importe un <b>PDF</b> (catalogue / devis / facture — analysé par l’IA) ou un <b>Excel</b> (.xlsx)
          précédemment exporté. Les articles détectés s’ajoutent au catalogue ; une fenêtre récapitule l’import PDF.
        </p>
        <div class="pdf-drop" id="importDrop" tabindex="0" role="button" aria-label="Choisir ou déposer un fichier à importer">
          <strong>Glisser-déposer un PDF ou un Excel ici</strong>
          <span class="muted mini">Formats : .pdf · .xlsx · .xls</span>
          <button type="button" class="bo-btn primary" id="importBtn">Choisir un fichier…</button>
          <input id="importFile" type="file"
            accept=".pdf,.xlsx,.xls,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            hidden>
        </div>
        <span id="importName" class="muted mini"></span>
        <p id="importStatus" class="muted mini"></p>
      </div>
      <div class="io-card">
        <h3>Test</h3>
        <p class="muted">Remet à zéro tout le stock (physique, en ligne, réserve, archive, salariés). Les articles du catalogue restent.</p>
        <button type="button" id="clearStockBtn" class="bo-btn danger">Vider tout le stock</button>
      </div>
    </div>
    <p class="muted mini">PDF : document textuel lisible de préférence. Excel : réimporte un classeur exporté puis modifié (feuilles Catalogue / Stock / Factures).</p>`;

  body.querySelector('#expBtn').addEventListener('click', exportWorkbook);
  body.querySelector('#clearStockBtn').addEventListener('click', () => confirmClearAllStock());

  const importFile = body.querySelector('#importFile');
  const importDrop = body.querySelector('#importDrop');
  const pickFile = () => importFile.click();

  body.querySelector('#importBtn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pickFile();
  });
  importDrop.addEventListener('click', (e) => {
    if (e.target.closest('#importBtn')) return;
    pickFile();
  });
  importDrop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); }
  });
  importDrop.addEventListener('dragover', (e) => { e.preventDefault(); importDrop.classList.add('on'); });
  importDrop.addEventListener('dragleave', () => importDrop.classList.remove('on'));
  importDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    importDrop.classList.remove('on');
    const f = e.dataTransfer?.files?.[0];
    if (f) void handleImportFile(f, body);
  });
  importFile.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) void handleImportFile(f, body);
  });
}

function confirmClearAllStock() {
  openModal(`<h3>Vider tout le stock ?</h3>
    <p class="muted">Toutes les quantités (physique, en ligne, réserve, archive, salariés) passeront à <b>0</b>.
      Le catalogue (articles et prix) n’est pas modifié. Action de test — irréversible sans réimport.</p>
    <div class="modal-actions">
      <button class="bo-btn" data-close>Annuler</button>
      <button class="bo-btn danger" id="clearStockOk">Oui, tout vider</button>
    </div>`, (ov) => {
    ov.querySelector('#clearStockOk').addEventListener('click', async () => {
      closeModal();
      try {
        const n = await db.clearAllStock();
        await reload();
        paint();
        if (typeof ctx.refreshApp === 'function') await ctx.refreshApp();
        if (typeof ctx.onChanged === 'function') ctx.onChanged();
        ctx.toast(`Stock vidé — ${n} SKU remis à 0`);
      } catch (err) {
        console.error(err);
        ctx.toast('Erreur : ' + (err.message || err));
      }
    });
  });
}

function isPdfFile(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.pdf') || type === 'application/pdf' || type === 'application/x-pdf';
}

function isExcelFile(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.xlsx') || name.endsWith('.xls')
    || type.includes('spreadsheet') || type === 'application/vnd.ms-excel';
}

async function handleImportFile(file, body) {
  if (!file) return;
  const nameEl = body.querySelector('#importName');
  const statusEl = body.querySelector('#importStatus');
  if (nameEl) nameEl.textContent = file.name;

  if (isPdfFile(file)) {
    await importPdfCatalog(file, body);
    return;
  }
  if (isExcelFile(file)) {
    if (statusEl) {
      statusEl.className = 'muted mini';
      statusEl.textContent = 'Import Excel…';
    }
    await importWorkbook(file);
    if (statusEl) statusEl.textContent = '';
    return;
  }

  ctx.toast('Choisis un PDF (.pdf) ou un Excel (.xlsx)');
  if (statusEl) {
    statusEl.className = 'reg-msg err';
    statusEl.textContent = 'Format non supporté. Utilise un .pdf ou un .xlsx.';
  }
}

async function importPdfCatalog(file, body) {
  if (!file) return;
  if (!isPdfFile(file)) {
    ctx.toast('Choisis un fichier PDF (.pdf)');
    const statusEl = body.querySelector('#importStatus') || body.querySelector('#pdfStatus');
    if (statusEl) {
      statusEl.className = 'reg-msg err';
      statusEl.textContent = 'Fichier refusé : seuls les PDF (.pdf) sont acceptés.';
    }
    return;
  }
  const nameEl = body.querySelector('#importName') || body.querySelector('#pdfName');
  const statusEl = body.querySelector('#importStatus') || body.querySelector('#pdfStatus');
  const input = body.querySelector('#importFile') || body.querySelector('#pdfFile');
  if (nameEl) nameEl.textContent = file.name;
  if (statusEl) {
    statusEl.textContent = 'Analyse du PDF en cours…';
    statusEl.className = 'reg-msg';
  }
  if (input) input.disabled = true;

  openModal(`<h3>Analyse du PDF</h3>
    <div class="page-loader page-loader-inline" role="status">
      <div class="page-loader-spin" aria-hidden="true"></div>
      <p>Analyse de « ${escHtml(file.name)} »…</p>
    </div>
    <p class="muted mini" style="text-align:center">Cela peut prendre 15–60 secondes selon le document.</p>
    <div class="modal-actions"><button class="bo-btn" data-close disabled>Annuler</button></div>`);

  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/import-pdf', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);

    closeModal();
    const preview = await showPdfImportPreview(data);
    if (!preview?.products?.length) {
      if (statusEl) statusEl.textContent = 'Import annulé.';
      return;
    }

    if (statusEl) statusEl.textContent = 'Enregistrement des articles…';
    const report = await applyPdfImport(preview.products);
    await reload();
    sub = 'io';
    paint();
    showPdfImportRecap({ ...report, source_summary: data.source_summary, fileName: data.fileName || file.name });
    ctx.toast(`Import PDF ✓ — ${report.created + report.updated} article(s)`);
  } catch (err) {
    console.error(err);
    closeModal();
    if (statusEl) {
      statusEl.className = 'reg-msg err';
      statusEl.textContent = 'Échec : ' + (err.message || err);
    }
    ctx.toast('Erreur import PDF : ' + (err.message || err));
  } finally {
    if (input) {
      input.disabled = false;
      input.value = '';
    }
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Normalise un nom pour matching PDF ↔ boutique. */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreNameMatch(pdfName, shopName) {
  const a = normName(pdfName);
  const b = normName(shopName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const ta = new Set(a.split(' ').filter((t) => t.length > 1));
  const tb = b.split(' ').filter((t) => t.length > 1);
  if (!tb.length) return 0;
  const hit = tb.filter((t) => ta.has(t)).length;
  return Math.round((hit / tb.length) * 70);
}

function suggestProductId(pdfName, catalog) {
  let bestId = '';
  let best = 0;
  for (const p of catalog) {
    const s = scoreNameMatch(pdfName, p.name);
    if (s > best) { best = s; bestId = p.id; }
  }
  return best >= 45 ? bestId : '';
}

/**
 * Modal : pour chaque titre PDF, choisir l’article boutique cible
 * (+ détail tailles × quantités).
 * Résout { products } avec targetProductId (ou null = créer).
 */
function showPdfImportPreview(data) {
  const pdfProducts = data.products || [];
  const catalog = [...(cache.products || [])].sort((a, b) =>
    String(a.name).localeCompare(b.name, 'fr'),
  );

  const totalQty = pdfProducts.reduce(
    (a, p) => a + (p.variants || []).reduce((b, v) => b + (Number(v.stock_physique) || 0), 0),
    0,
  );
  const nVar = pdfProducts.reduce((a, p) => a + (p.variants?.length || 0), 0);

  const catalogOpts = catalog.map((p) =>
    `<option value="${escHtml(p.id)}">${escHtml(p.name)}${p.category ? ` · ${escHtml(p.category)}` : ''}</option>`,
  ).join('');

  const cards = pdfProducts.map((p, idx) => {
    const variants = p.variants || [];
    const subtotal = variants.reduce((a, v) => a + (Number(v.stock_physique) || 0), 0);
    const purchase = variants.find((v) => Number(v.purchase_price_ht) > 0)?.purchase_price_ht
      ?? null;
    const rows = variants.map((v) => {
      const q = Number(v.stock_physique) || 0;
      const achat = Number(v.purchase_price_ht) > 0 ? Number(v.purchase_price_ht) : purchase;
      return `<tr class="${q <= 0 ? 'qty-missing' : ''}">
        <td><span class="sz-badge">${escHtml(v.size)}</span></td>
        <td class="num import-qty-cell"><b>${q}</b></td>
        <td class="num">${achat != null ? eur(achat) : '—'}</td>
        <td class="num import-resale" data-size="${escHtml(v.size)}">—</td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" class="muted">Aucune taille</td></tr>`;

    return `<section class="import-product-card" data-pdf-idx="${idx}">
      <header>
        <div>
          <h4>${escHtml(p.name)}</h4>
          <p class="muted mini">PDF · ${escHtml(p.category || 'Maillot')} · ${variants.length} taille(s) · sous-total <b>${subtotal}</b>
            ${purchase != null ? ` · PV HT <b>${eur(purchase)}</b>` : ' · <span class="reg-msg err">PV HT manquant</span>'}</p>
        </div>
      </header>
      <label class="import-map-label">
        <span>Article boutique</span>
        <select class="bo-input import-map-select" data-map="${idx}">
          <option value="">＋ Créer « ${escHtml(p.name)} »</option>
          ${catalogOpts}
        </select>
      </label>
      <p class="muted mini import-map-hint" data-hint="${idx}"></p>
      <table class="bo-table import-size-table">
        <thead><tr><th>Taille</th><th class="num">Quantité</th><th class="num">Achat (PV HT)</th><th class="num">Prix revente</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join('');

  return new Promise((resolve) => {
    let done = false;
    const finish = (payload) => { if (done) return; done = true; closeModal(); resolve(payload); };

    openModal(`<h3>Associer PDF → boutique</h3>
      <p class="muted">${escHtml(data.source_summary || 'Pour chaque titre du PDF, choisis l’article boutique correspondant (ou crée-en un nouveau).')}</p>
      <p class="muted mini">Fichier : <b>${escHtml(data.fileName || '')}</b> ·
        <b>${pdfProducts.length}</b> ligne(s) PDF · <b>${nVar}</b> taille(s) · <b>${totalQty}</b> pièce(s).
        <b>Achat (PV HT)</b> = 1er prix € du devis · <b>Revente</b> = prix boutique (conservé).</p>
      <div class="import-product-grid">${cards || '<p class="muted">Aucun article</p>'}</div>
      <div class="modal-actions">
        <button class="bo-btn" type="button" id="pdfCancel">Annuler</button>
        <button class="bo-btn primary" type="button" id="pdfConfirm">Importer</button>
      </div>`, (ov) => {
      const modal = ov.querySelector('.modal') || ov.querySelector('.sheet');
      if (modal) modal.classList.add('import-wide');

      const resaleLabel = (shop, size) => {
        if (!shop) return '—';
        const v = (shop.variants || []).find((x) => String(x.size) === String(size))
          || (shop.variants || [])[0];
        const p = v?.sale_price;
        return p > 0 ? eur(p) : '—';
      };

      const refreshResale = (card, shopId) => {
        const shop = shopId ? catalog.find((x) => x.id === shopId) : null;
        card.querySelectorAll('.import-resale').forEach((cell) => {
          cell.textContent = resaleLabel(shop, cell.dataset.size);
        });
      };

      const updateHints = () => {
        const used = new Map();
        ov.querySelectorAll('.import-map-select').forEach((sel) => {
          const id = sel.value;
          if (!id) return;
          used.set(id, (used.get(id) || 0) + 1);
        });
        ov.querySelectorAll('.import-map-select').forEach((sel) => {
          const idx = sel.dataset.map;
          const hint = ov.querySelector(`[data-hint="${idx}"]`);
          const card = ov.querySelector(`[data-pdf-idx="${idx}"]`);
          const id = sel.value;
          if (card) refreshResale(card, id);
          if (!hint) return;
          if (!id) {
            hint.textContent = 'Nouvel article : PV HT enregistré en achat · revente à saisir ensuite dans le catalogue.';
            hint.className = 'muted mini import-map-hint';
            return;
          }
          const p = catalog.find((x) => x.id === id);
          const dup = (used.get(id) || 0) > 1;
          hint.textContent = dup
            ? `⚠ Plusieurs lignes PDF pointent vers « ${p?.name || id} » — les tailles seront fusionnées.`
            : `Stock + PV HT (achat) sur « ${p?.name || id} » — la revente boutique est conservée.`;
          hint.className = dup ? 'reg-msg err import-map-hint' : 'muted mini import-map-hint';
        });
      };

      ov.querySelectorAll('.import-map-select').forEach((sel) => {
        const idx = +sel.dataset.map;
        const suggested = suggestProductId(pdfProducts[idx]?.name, catalog);
        if (suggested) sel.value = suggested;
        sel.addEventListener('change', updateHints);
      });
      updateHints();

      ov.querySelector('#pdfCancel').addEventListener('click', () => finish(null));
      ov.querySelector('#pdfConfirm').addEventListener('click', () => {
        const products = pdfProducts.map((p, idx) => {
          const sel = ov.querySelector(`select[data-map="${idx}"]`);
          const targetProductId = sel?.value || '';
          return {
            ...p,
            pdfName: p.name,
            targetProductId: targetProductId || null,
          };
        });
        finish({ products });
      });
      ov.addEventListener('click', (e) => { if (e.target === ov) finish(null); });
    });
  });
}

async function applyPdfImport(products) {
  const existing = await db.listProducts();
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));
  const report = { created: 0, updated: 0, variants: 0, stockSet: 0, items: [] };

  for (const raw of products) {
    const pdfName = String(raw.pdfName || raw.name || '').trim();
    if (!pdfName || !raw.variants?.length) continue;

    let product = null;
    if (raw.targetProductId) product = byId.get(raw.targetProductId) || null;
    if (!product) product = byName.get(pdfName.toLowerCase()) || null;

    const isNew = !product;
    const id = product?.id || uniqueProductId(pdfName, existing);
    // Conserve le nom boutique si mapping ; sinon titre PDF
    const name = product?.name || pdfName;

    // PV HT du devis : un prix pour toute la ligne, appliqué à chaque taille
    const linePurchase = (() => {
      const fromVar = raw.variants
        .map((v) => +v.purchase_price_ht)
        .find((n) => n > 0);
      if (fromVar > 0) return fromVar;
      // Repli si l’API a laissé le montant dans sale_price / source_line
      const fromSale = raw.variants.map((v) => +v.sale_price).find((n) => n > 0);
      if (fromSale > 0) return fromSale;
      const m = String(raw.source_line || '').match(/\)\s*\d[\d\s.]*\s+(\d+(?:[.,]\d{1,2})?)\s*€/);
      if (m) return Number(m[1].replace(',', '.')) || null;
      return null;
    })();

    const variants = raw.variants.map((v) => {
      let purchase = v.purchase_price_ht == null || v.purchase_price_ht === ''
        ? null
        : +v.purchase_price_ht;
      if (!(purchase > 0)) purchase = linePurchase;
      return {
        size: String(v.size),
        size_system: v.size_system || 'adulte',
        sale_price: 0,
        purchase_price_ht: purchase > 0 ? purchase : null,
        marking_cost: +v.marking_cost || 0,
      };
    });

    if (product) {
      const map = new Map(product.variants.map((v) => [v.size, { ...v }]));
      for (const v of variants) {
        const prev = map.get(v.size) || {};
        map.set(v.size, {
          ...prev,
          size: v.size,
          size_system: v.size_system || prev.size_system || 'adulte',
          // Revente boutique conservée ; achat = PV HT du devis pour toutes les tailles
          sale_price: prev.sale_price || 0,
          purchase_price_ht: v.purchase_price_ht != null ? v.purchase_price_ht : (prev.purchase_price_ht ?? null),
          marking_cost: prev.marking_cost || 0,
        });
      }
      product = {
        ...product,
        id,
        name,
        category: product.category || raw.category || 'Textile',
        variants: [...map.values()],
      };
    } else {
      product = { id, name, category: raw.category || 'Textile', variants };
      existing.push(product);
    }

    byId.set(id, product);
    byName.set(name.toLowerCase(), product);

    await db.saveProduct(product);
    if (raw.category && isNew) {
      try { await db.addCategory(raw.category); } catch (_) { /* ignore */ }
    }

    let stockLines = 0;
    for (const v of raw.variants) {
      const qty = Math.max(0, Math.round(+v.stock_physique || 0));
      if (qty > 0) {
        await db.setStockValue(sku(id, v.size), 'physique', qty);
        stockLines++;
      }
    }

    if (isNew) report.created++; else report.updated++;
    report.variants += variants.length;
    report.stockSet += stockLines;
    report.items.push({
      name,
      category: product.category,
      action: isNew ? 'créé' : 'mis à jour',
      pdfName: pdfName !== name ? pdfName : '',
      variants: variants.length,
      stock: stockLines,
      sizes: raw.variants.map((v) => `${v.size} ×${Math.max(0, Math.round(+v.stock_physique || 0))}`).join(', '),
    });
  }

  return report;
}

function uniqueProductId(name, existing) {
  let base = slug(name) || 'article';
  let id = base;
  let n = 2;
  const ids = new Set(existing.map((p) => p.id));
  while (ids.has(id)) { id = `${base}_${n++}`; }
  return id;
}

/** Modal finale après écriture en base. */
function showPdfImportRecap(report) {
  const rows = (report.items || []).map((it) => `<tr>
    <td><b>${escHtml(it.name)}</b>
      <div class="muted mini">${escHtml(it.category)}${it.pdfName ? ` · PDF : ${escHtml(it.pdfName)}` : ''}</div></td>
    <td><span class="cat-badge">${escHtml(it.action)}</span></td>
    <td class="mini">${escHtml(it.sizes || `${it.variants} variante(s)`)}</td>
    <td class="num">${it.stock}</td>
  </tr>`).join('');

  openModal(`<h3>Import terminé ✓</h3>
    <p class="muted">${escHtml(report.source_summary || 'Articles enregistrés dans le catalogue.')}</p>
    <p class="muted mini">Fichier : <b>${escHtml(report.fileName || '')}</b> ·
      <b>${report.created}</b> créé(s) · <b>${report.updated}</b> mis à jour ·
      <b>${report.variants}</b> taille(s) · <b>${report.stockSet}</b> stock(s) renseigné(s)</p>
    <div class="bo-tablewrap import-recap-wrap">
      <table class="bo-table import-recap">
        <thead><tr><th>Article</th><th>Action</th><th>Tailles × qté</th><th class="num">Stocks</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">Aucun article</td></tr>'}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button class="bo-btn primary" data-close>Fermer</button>
    </div>`);
}

async function exportWorkbook() {
  
  const state = await db.exportState();
  const catRows = [], stockRows = [];
  for (const p of state.products) for (const v of p.variants) {
    catRows.push({ product_id: p.id, Article: p.name, Catégorie: p.category, Taille: v.size,
      Systeme: v.size_system, PV: v.sale_price, PA_HT: v.purchase_price_ht ?? '', Marquage: v.marking_cost || 0 });
  }
  const smap = Object.fromEntries(state.stock.map((s) => [s.sku, s]));
  for (const p of state.products) for (const v of p.variants) {
    const s = smap[sku(p.id, v.size)] || {};
    stockRows.push({ sku: sku(p.id, v.size), Article: p.name, Taille: v.size,
      Physique: s.physique || 0, Réserve: s.reserve || 0, En_ligne: s.en_ligne || 0, Archive: s.archive || 0 });
  }
  const venteRows = [];
  for (const s of state.sales) for (const l of s.lines) venteRows.push({
    Date: s.created_at, Match: s.matchLabel, Canal: s.channel, Paiement: s.payment_method,
    Article: l.name, Taille: l.size, Qté: l.qty, Mode: l.mode, PU: l.unit, Total: l.line_total });
  const factRows = state.invoices.map((i) => ({ Référence: i.ref, Type: i.type, Montant: +i.amount || 0 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'Catalogue');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stockRows), 'Stock');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(venteRows), 'Ventes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(factRows), 'Factures');
  XLSX.writeFile(wb, `Boutique_TFHB_${state.season || 'export'}.xlsx`);
  ctx.toast('Classeur exporté');
}

async function importWorkbook(file) {
  if (!file) return;
  const nameEl = host.querySelector('#importName') || host.querySelector('#impName');
  if (nameEl) nameEl.textContent = file.name;
  
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf);
  const sheet = (name) => wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name]) : null;
  const cat = sheet('Catalogue'), stk = sheet('Stock'), fac = sheet('Factures');
  if (!cat && !stk && !fac) return ctx.toast('Feuilles Catalogue/Stock/Factures introuvables');

  try {
    if (cat) {
      // reconstruit les produits (regroupe les variantes par product_id/Article)
      const byId = new Map();
      for (const r of cat) {
        const id = String(r.product_id || slug(r.Article || 'article'));
        if (!byId.has(id)) byId.set(id, { id, name: r.Article || id, category: r.Catégorie || 'Textile', variants: [] });
        byId.get(id).variants.push({
          size: String(r.Taille), size_system: r.Systeme || 'adulte',
          sale_price: +r.PV || 0, purchase_price_ht: r.PA_HT === '' || r.PA_HT == null ? null : +r.PA_HT,
          marking_cost: +r.Marquage || 0,
        });
      }
      const products = [...byId.values()];
      const stockRows = [];
      const stkByKey = stk ? Object.fromEntries(stk.map((s) => [String(s.sku), s])) : {};
      for (const p of products) for (const v of p.variants) {
        const s = stkByKey[sku(p.id, v.size)] || {};
        stockRows.push({ sku: sku(p.id, v.size), physique: +s.Physique || 0, reserve: +s.Réserve || 0,
          en_ligne: +s.En_ligne || 0, archive: +s.Archive || 0 });
      }
      await db.replaceCatalog(products, stockRows);
    }
    if (fac) {
      await db.importInvoices(fac.map((r) => ({ ref: r.Référence || '', type: r.Type === 'marquage' ? 'marquage' : 'achat', amount: +r.Montant || 0 })));
    }
    await reload(); paint();
    ctx.toast('Import terminé ✓');
  } catch (err) {
    console.error(err); ctx.toast('Erreur d\'import : ' + err.message);
  }
}

/* ============ modal utilitaire ============ */
function openModal(html, after) {
  const hostEl = document.getElementById('modalHost');
  const ov = el(`<div class="ov on"><div class="sheet modal">${html}</div></div>`);
  hostEl.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(); });
  ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  if (after) after(ov);
}
function closeModal() { const h = document.getElementById('modalHost'); h.innerHTML = ''; }

const enc = (s) => encodeURIComponent(s);
const dec = (s) => decodeURIComponent(s);
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
