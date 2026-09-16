// @ts-nocheck — logique legacy migrée ; typage progressif
// Vues financières (Lot 3) : valorisation stock (PV & PA HT), Valo Com,
// recettes par canal/match, coûts (achat + marquage), bénéfices.
// + Ajustements manuels : entrées libres (recette/dépense) et montants forcés.
import * as db from './db';
import { sku } from './catalog';

const eur = (v) => (Math.round((v || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 0 }) + ' €';
const CHANNELS = { physique: 'Boutique physique', en_ligne: 'Boutique en ligne', salarie: 'Salariés' };
const STOCK_LOCS = ['physique', 'en_ligne']; // « stock restant » (réserve & archive exclues)

export async function renderFinances(host, ctx = {}) {
  const seasonId = await db.activeSeasonId();
  const season = await db.activeSeason();
  const [products, stockArr, sales, invoices, adjust] = await Promise.all([
    db.listProducts(), db.getAll('stock'), db.allSales(seasonId), db.listInvoices(seasonId), db.listFinAdjust(seasonId),
  ]);
  const stock = Object.fromEntries(stockArr.filter((s) => !s.deleted).map((s) => [s.sku, s]));

  // ---- valorisation du stock ----
  const valo = { pv: 0, pa: 0, units: 0, paMissing: 0 };
  const valoRows = [];
  for (const p of products) {
    let qty = 0, pv = 0, pa = 0, missing = false;
    for (const v of p.variants) {
      const s = stock[sku(p.id, v.size)] || {};
      const q = STOCK_LOCS.reduce((a, k) => a + (s[k] || 0), 0);
      qty += q; pv += q * (v.sale_price || 0);
      if (v.purchase_price_ht == null) { if (q > 0) missing = true; } else pa += q * v.purchase_price_ht;
    }
    valo.units += qty; valo.pv += pv; valo.pa += pa; if (missing) valo.paMissing++;
    if (qty > 0) valoRows.push({ name: p.name, qty, pv, pa, missing });
  }
  valoRows.sort((a, b) => b.pv - a.pv);

  // ---- recettes (ventes) ----
  const recettesVentes = sales.reduce((a, s) => a + (s.total || 0), 0);
  const nbVentes = sales.length;
  const valoCom = sales.reduce((a, s) => a + (s.com_total || 0), 0);
  const panierMoyen = nbVentes ? recettesVentes / nbVentes : 0;
  const byChannel = {}, byMatch = {};
  for (const s of sales) {
    const c = s.channel || 'physique';
    byChannel[c] = (byChannel[c] || 0) + s.total;
    const key = s.matchLabel || '—';
    (byMatch[key] = byMatch[key] || { total: 0, nb: 0, com: 0 });
    byMatch[key].total += s.total; byMatch[key].nb += 1; byMatch[key].com += (s.com_total || 0);
  }
  const matchRows = Object.entries(byMatch).map(([m, v]) => ({ m, ...v })).sort((a, b) => b.total - a.total);
  const caMoyenMatch = matchRows.length ? recettesVentes / matchRows.length : 0;

  // ---- coûts (factures) ----
  const coutAchat = invoices.filter((i) => i.type === 'achat').reduce((a, i) => a + (+i.amount || 0), 0);
  const coutMarquage = invoices.filter((i) => i.type === 'marquage').reduce((a, i) => a + (+i.amount || 0), 0);

  // ---- ajustements manuels ----
  const entries = adjust.filter((a) => a.type === 'entry');
  const overrides = {};
  adjust.filter((a) => a.type === 'override' && a.value != null).forEach((o) => { overrides[o.field] = o.value; });
  const manualRecettes = entries.filter((e) => e.kind === 'recette').reduce((a, e) => a + (+e.amount || 0), 0);
  const manualCouts = entries.filter((e) => e.kind === 'cout').reduce((a, e) => a + (+e.amount || 0), 0);

  // valeurs calculées (ventes/factures + manuel)
  const recettesCalc = recettesVentes + manualRecettes;
  const coutsCalc = coutAchat + coutMarquage + manualCouts;
  // valeurs affichées (avec forçage éventuel)
  const dRecettes = overrides.recettes ?? recettesCalc;
  const dCouts = overrides.couts ?? coutsCalc;
  const dBenef = overrides.benefices ?? (dRecettes - dCouts);
  const dValo = overrides.valo_pv ?? valo.pv;

  const tag = (f, adjusted) => overrides[f] != null
    ? '<span class="fin-flag forced">forcé</span>'
    : (adjusted ? '<span class="fin-flag">ajusté</span>' : '');

  const maxChannel = Math.max(1, ...Object.values(byChannel));
  const maxMatch = Math.max(1, ...matchRows.map((r) => r.total));

  host.innerHTML = `
  <div class="fin">
    <div class="fin-season">Saison <b>${season ? season.label : '—'}</b><span class="muted"> · indicateurs de la saison active</span></div>
    <div class="fin-kpis">
      ${kpi('Total recettes', eur(dRecettes), `${nbVentes} ventes${manualRecettes ? ' + ' + eur(manualRecettes) + ' manuel' : ''} · panier moyen ${eur(panierMoyen)}`, 'blue', tag('recettes', manualRecettes))}
      ${kpi('Coûts (achat + marquage)', eur(dCouts), `Achat ${eur(coutAchat)} · Marquage ${eur(coutMarquage)}${manualCouts ? ' · +' + eur(manualCouts) + ' manuel' : ''}`, 'amber', tag('couts', manualCouts))}
      ${kpi('Bénéfices', eur(dBenef), 'Recettes − coûts', dBenef >= 0 ? 'green' : 'red', tag('benefices', false))}
      ${kpi('Valorisation stock', eur(dValo), `au prix de vente · ${valo.units} articles`, 'violet', tag('valo_pv', false))}
    </div>

    <div class="fin-cols">
      <section class="fin-card">
        <h3>Valorisation du stock restant</h3>
        <div class="fin-sub">
          <div><span>Au prix de vente</span><b>${eur(valo.pv)}</b></div>
          <div><span>Au prix d'achat HT</span><b>${eur(valo.pa)}${valo.paMissing ? ` <em>(${valo.paMissing} article(s) sans PA HT)</em>` : ''}</b></div>
          <div><span>Marge potentielle</span><b>${eur(valo.pv - valo.pa)}</b></div>
        </div>
        <div class="bo-tablewrap"><table class="bo-table">
          <thead><tr><th>Article</th><th>Qté</th><th>Valo PV</th><th>Valo PA HT</th></tr></thead>
          <tbody>${valoRows.map((r) => `<tr><td>${r.name}</td><td class="num">${r.qty}</td>
            <td class="num">${eur(r.pv)}</td><td class="num">${r.missing ? '<span class="muted">incomplet</span>' : eur(r.pa)}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>

      <section class="fin-card">
        <h3>Recettes par canal</h3>
        <div class="bars">
          ${Object.entries(byChannel).sort((a, b) => b[1] - a[1]).map(([c, v]) => bar(CHANNELS[c] || c, v, maxChannel)).join('') || '<p class="muted">Aucune vente</p>'}
        </div>
        <h3 style="margin-top:18px">Valorisation Com (dotations)</h3>
        <p class="fin-com">${eur(valoCom)} <span class="muted">— manque à gagner (articles offerts / imputation commerciale, sortis du stock sans recette)</span></p>
        <h3 style="margin-top:18px">Coûts</h3>
        <div class="fin-sub">
          <div><span>Coûts d'achat HT (factures)</span><b>${eur(coutAchat)}</b></div>
          <div><span>Coûts de marquage / flocage</span><b>${eur(coutMarquage)}</b></div>
          <div><span>Total des coûts</span><b>${eur(dCouts)}</b></div>
        </div>
      </section>
    </div>

    <section class="fin-card">
      <h3>Recettes par match</h3>
      <div class="fin-sub"><div><span>CA moyen par match</span><b>${eur(caMoyenMatch)}</b></div>
        <div><span>Panier moyen global</span><b>${eur(panierMoyen)}</b></div></div>
      <div class="bo-tablewrap"><table class="bo-table">
        <thead><tr><th>Match</th><th>Ventes</th><th>Recettes</th><th>Imputation com</th><th></th></tr></thead>
        <tbody>${matchRows.map((r) => `<tr><td>${r.m}</td><td class="num">${r.nb}</td>
          <td class="num">${eur(r.total)}</td><td class="num">${eur(r.com)}</td>
          <td style="width:34%"><div class="minibar"><span style="width:${Math.round(r.total / maxMatch * 100)}%"></span></div></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Aucune vente enregistrée</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="fin-card">
      <h3>Ajustements manuels</h3>
      <p class="muted">Ajoute une recette ou une dépense qui ne vient pas de la caisse (don, buvette, frais divers…), ou force un montant affiché.</p>
      <div class="reg-actions">
        <select id="adjKind" class="bo-input"><option value="recette">Recette (+)</option><option value="cout">Dépense (−)</option></select>
        <input id="adjLabel" class="bo-input" placeholder="Libellé (ex : don, buvette…)">
        <input id="adjAmount" class="bo-input qty" type="number" step="0.01" placeholder="Montant €">
        <button id="adjAdd" class="bo-btn primary">Ajouter</button>
      </div>
      <div class="bo-tablewrap"><table class="bo-table">
        <thead><tr><th>Type</th><th>Libellé</th><th>Montant</th><th></th></tr></thead>
        <tbody>${entries.length ? entries.map((e) => `<tr>
          <td>${e.kind === 'recette' ? 'Recette +' : 'Dépense −'}</td><td>${e.label || '—'}</td>
          <td class="num">${eur(e.amount)}</td>
          <td><button class="bo-x" data-del="${e.id}">🗑</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">Aucune entrée manuelle</td></tr>'}</tbody>
      </table></div>

      <h3 style="margin-top:18px">Forcer un montant</h3>
      <p class="muted">Remplace la valeur calculée par une valeur saisie. Laisse vide et « ↺ Auto » pour revenir au calcul.</p>
      <div class="bo-tablewrap"><table class="bo-table">
        <thead><tr><th>Indicateur</th><th>Calculé</th><th>Forcer à</th><th></th></tr></thead>
        <tbody>
          ${forceRow('recettes', 'Total recettes', recettesCalc, overrides.recettes)}
          ${forceRow('couts', 'Coûts totaux', coutsCalc, overrides.couts)}
          ${forceRow('benefices', 'Bénéfices', recettesCalc - coutsCalc, overrides.benefices)}
          ${forceRow('valo_pv', 'Valorisation stock', valo.pv, overrides.valo_pv)}
        </tbody>
      </table></div>
    </section>
  </div>`;

  // ---- interactions ----
  const rerender = () => renderFinances(host, ctx);
  host.querySelector('#adjAdd').addEventListener('click', async () => {
    const amount = parseFloat(host.querySelector('#adjAmount').value);
    if (!amount) return ctx.toast && ctx.toast('Montant requis');
    await db.addFinEntry({ kind: host.querySelector('#adjKind').value, label: host.querySelector('#adjLabel').value.trim(), amount });
    ctx.toast && ctx.toast('Ajustement ajouté'); rerender();
  });
  host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await db.deleteFinAdjust(b.dataset.del); rerender();
  }));
  host.querySelectorAll('[data-force]').forEach((b) => b.addEventListener('click', async () => {
    const field = b.dataset.force;
    const val = parseFloat(host.querySelector(`#force_${field}`).value);
    if (isNaN(val)) return ctx.toast && ctx.toast('Entre un montant');
    await db.setFinOverride(field, val); ctx.toast && ctx.toast('Montant forcé'); rerender();
  }));
  host.querySelectorAll('[data-auto]').forEach((b) => b.addEventListener('click', async () => {
    await db.setFinOverride(b.dataset.auto, null); ctx.toast && ctx.toast('Retour au calcul auto'); rerender();
  }));
}

const kpi = (label, value, sub, color, flag = '') => `<div class="fin-kpi ${color}">
  <div class="k">${label} ${flag}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

const bar = (label, value, max) => `<div class="barrow">
  <div class="bl">${label}</div><div class="bt"><span style="width:${Math.round(value / max * 100)}%"></span></div>
  <div class="bv">${eur(value)}</div></div>`;

const forceRow = (field, label, calc, current) => `<tr>
  <td><b>${label}</b>${current != null ? ' <span class="fin-flag forced">forcé</span>' : ''}</td>
  <td class="num">${eur(calc)}</td>
  <td><input id="force_${field}" class="bo-cell num" type="number" step="0.01" value="${current != null ? current : ''}" placeholder="—"></td>
  <td><button class="bo-btn" data-force="${field}">Forcer</button>
      ${current != null ? `<button class="bo-btn" data-auto="${field}">↺ Auto</button>` : ''}</td></tr>`;
