// @ts-nocheck — logique legacy migrée ; typage progressif
// Écran Réglages (Lot 4) : configuration Supabase + synchronisation + saisons.
import * as db from './db';
import * as sync from './sync';
import { formatMatchDate } from './catalog';

let ctx = { toast: () => {} };
let pendingLogoMatch = null;

function flashOk(node) {
  if (!node) return;
  node.classList.remove('flash-ok');
  void node.offsetWidth;
  node.classList.add('flash-ok');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const eur = (v) => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('fr-FR') + ' €';

function closeCacheModal() {
  const h = document.getElementById('modalHost');
  if (h) h.innerHTML = '';
}

function openCacheModal(html, after) {
  const hostEl = document.getElementById('modalHost');
  if (!hostEl) return;
  closeCacheModal();
  const ov = document.createElement('div');
  ov.className = 'ov on';
  ov.innerHTML = `<div class="sheet modal import-wide">${html}</div>`;
  hostEl.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov) closeCacheModal(); });
  ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeCacheModal));
  if (after) after(ov);
}

function renderCacheDiff(diff) {
  const matchRows = (diff.missingMatches || []).map((m) =>
    `<tr><td><b>${escHtml(m.code || '—')}</b></td><td>${escHtml(m.label || '—')}</td></tr>`).join('')
    || '<tr><td colspan="2" class="muted">Aucun match manquant</td></tr>';
  const saleRows = (diff.salesByMatch || []).map((g) =>
    `<tr><td>${escHtml(g.label)}</td><td class="num">${g.n}</td><td class="num">${g.qty}</td><td class="num">${eur(g.total)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">Aucune vente manquante</td></tr>';
  return `
    <div class="cache-diff-kpis">
      <div><span>Déjà en base</span><b>${diff.alreadyMatches} matchs · ${diff.alreadySales} ventes · ${diff.alreadyMoves} mvts</b></div>
      <div class="add"><span>À réimporter</span><b>${diff.missingMatches.length} matchs · ${diff.salesToImport.length} ventes · ${diff.missingMoves.length} mvts</b></div>
    </div>
    <h4>Matchs absents de Supabase</h4>
    <div class="bo-tablewrap cache-diff-wrap"><table class="bo-table import-recap">
      <thead><tr><th>Code</th><th>Nom</th></tr></thead>
      <tbody>${matchRows}</tbody>
    </table></div>
    <h4>Ventes absentes de Supabase</h4>
    <div class="bo-tablewrap cache-diff-wrap"><table class="bo-table import-recap">
      <thead><tr><th>Match</th><th class="num">Tickets</th><th class="num">Articles</th><th class="num">Total estimé</th></tr></thead>
      <tbody>${saleRows}</tbody>
    </table></div>
    <p class="muted mini">Les totaux des ventes recréées depuis le journal utilisent le prix catalogue actuel (paiement noté « espèces »). Le stock n’est pas rejoué.</p>`;
}

// Redimensionne un logo (garde la transparence -> PNG), max px.
function resizeLogo(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w >= h && w > max) { h = Math.round(h * max / w); w = max; }
      else if (h > w && h > max) { w = Math.round(w * max / h); h = max; }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject; img.src = url;
  });
}

export async function renderReglages(host, context) {
  ctx = context || ctx;
  const cfg = (await sync.getConfig()) || { url: '', anonKey: '' };
  const st = await sync.status();
  const seasons = await db.listSeasons();
  const activeId = await db.activeSeasonId();
  const matches = await db.listMatches();
  const categories = await db.getCategories();
  const CHAN = { physique: 'Soir de match', en_ligne: 'Boutique en ligne', salarie: 'Salariés' };

  const lastSync = st.lastSync ? new Date(st.lastSync).toLocaleString('fr-FR') : 'jamais';

  host.innerHTML = `
  <div class="reg">
    <section class="reg-card">
      <h3>Synchronisation multi-poste (Supabase)</h3>
      <p class="muted">Catalogue, stock, ventes et matchs vivent dans <b>Supabase</b> : l’app les charge au démarrage
      et enregistre chaque modification tout de suite. Renseigne l'<b>URL</b> et la <b>clé anon</b> ici ou via <code>.env</code>.
      Avant la 1ʳᵉ synchro, exécute <code>supabase-schema.sql</code>
      (tables <code>products</code>, <code>stock</code>, <code>sales</code>, <code>sale_lines</code>, <code>stock_moves</code>…).</p>

      <div class="reg-status">
        <span class="badge ${st.online ? 'ok' : 'off'}">${st.online ? 'En ligne' : 'Hors-ligne'}</span>
        <span class="badge ${st.configured ? 'ok' : 'warn'}">${st.configured ? 'Configuré' : 'Non configuré'}</span>
        ${st.pendingPush ? '<span class="badge warn">Cache non poussé</span>' : ''}
        <span class="muted">Dernière synchro : <b>${lastSync}</b></span>
      </div>

      <div class="form-grid">
        <label>URL du projet<input id="sbUrl" class="bo-input" placeholder="https://xxxx.supabase.co" value="${cfg.url || ''}"></label>
        <label>Clé anon (public)<input id="sbKey" class="bo-input" placeholder="eyJhbGciOi..." value="${cfg.anonKey || ''}"></label>
      </div>
      <div class="reg-actions">
        <button id="sbSave" class="bo-btn">Enregistrer</button>
        <button id="sbTest" class="bo-btn">Tester la connexion</button>
        <button id="sbSync" class="bo-btn primary">↻ Synchroniser maintenant</button>
      </div>
      <p class="muted mini">Avant de réimporter un cache, un comparatif montre ce qui est déjà dans Supabase et ce qui sera ajouté. Seul le manquant est envoyé.</p>
      <div class="reg-actions">
        <button id="sbPushCache" class="bo-btn">Comparer / réimporter le cache local</button>
        <button id="sbImportCache" class="bo-btn">Importer un dump JSON</button>
        <input type="file" id="sbImportCacheFile" accept="application/json,.json" hidden>
        <button id="sbRestoreMatches" class="bo-btn">Réinjecter le calendrier 26/27</button>
        <button id="sbDumpCache" class="bo-btn">Télécharger le cache (JSON)</button>
      </div>
      <p id="sbMsg" class="reg-msg"></p>
    </section>

    <section class="reg-card">
      <h3>Saisons</h3>
      <p class="muted">Les ventes et les factures sont rattachées à une saison. Le stock et le catalogue sont
      conservés d'une saison à l'autre (comme le passage 25-26 → 26-27).</p>
      <div class="bo-tablewrap"><table class="bo-table">
        <thead><tr><th>Saison</th><th>Statut</th><th></th></tr></thead>
        <tbody id="seasonRows"></tbody>
      </table></div>
      <div class="reg-actions">
        <input id="newSeason" class="bo-input" placeholder="Nouvelle saison (ex : 27-28)">
        <button id="addSeason" class="bo-btn primary">＋ Créer & activer</button>
      </div>
    </section>

    <section class="reg-card">
      <h3>Matchs / Journées</h3>
      <p class="muted">Ajoute ou supprime les journées et canaux qui apparaissent dans le sélecteur de match de la caisse.</p>
      <input type="file" id="matchLogoFile" accept="image/*" hidden>
      <div class="bo-tablewrap"><table class="bo-table">
        <thead><tr><th>Logo</th><th>Code</th><th>Nom</th><th>Date</th><th>Type</th><th></th></tr></thead>
        <tbody id="matchRows"></tbody>
      </table></div>
      <div class="reg-actions">
        <input id="mCode" class="bo-input" style="max-width:110px" placeholder="Code (ex : J31)">
        <input id="mLabel" class="bo-input" placeholder="Adversaire / nom (ex : Créteil)">
        <select id="mChan" class="bo-input">${Object.entries(CHAN).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button id="addMatch" class="bo-btn primary">＋ Ajouter le match</button>
      </div>
    </section>

    <section class="reg-card">
      <h3>Catégories d'articles</h3>
      <p class="muted">Onglets de la caisse. Tu peux ajouter, <b>renommer</b> (les articles suivent) ou supprimer une catégorie vide.</p>
      <div class="cat-chips" id="catChips"></div>
      <div class="reg-actions">
        <input id="newCat" class="bo-input" placeholder="Nouvelle catégorie (ex : Goodies)">
        <button id="addCat" class="bo-btn primary">＋ Ajouter</button>
      </div>
    </section>
  </div>`;

  // --- Supabase ---
  const msg = (txt, kind = '') => { const m = host.querySelector('#sbMsg'); m.textContent = txt; m.className = 'reg-msg ' + kind; };
  host.querySelector('#sbSave').addEventListener('click', async () => {
    await sync.saveConfig(host.querySelector('#sbUrl').value, host.querySelector('#sbKey').value);
    msg('Configuration enregistrée.', 'ok'); ctx.toast('Config Supabase enregistrée');
  });
  host.querySelector('#sbTest').addEventListener('click', async () => {
    msg('Test en cours…');
    try {
      await sync.saveConfig(host.querySelector('#sbUrl').value, host.querySelector('#sbKey').value);
      await sync.testConnection();
      msg('Connexion réussie ✓ (table « seasons » accessible).', 'ok');
    } catch (e) { msg('Échec : ' + e.message + ' — as-tu exécuté supabase-schema.sql ?', 'err'); }
  });
  host.querySelector('#sbSync').addEventListener('click', async () => {
    msg('Synchronisation…');
    try {
      await sync.saveConfig(host.querySelector('#sbUrl').value, host.querySelector('#sbKey').value);
      const r = await sync.syncNow();
      msg(`Synchro OK ✓ — ${r.pushed} envoyés, ${r.pulled} reçus.`, 'ok');
      ctx.toast('Synchronisé ✓');
      ctx.onChanged && ctx.onChanged();
      renderReglages(host, ctx);
    } catch (e) { msg('Erreur de synchro : ' + e.message, 'err'); }
  });
  const previewThenImport = async (cache, title) => {
    msg('Comparaison avec Supabase…');
    const remote = await sync.fetchRemote({ omitPhotos: true });
    const diff = db.diffCacheToRemote(cache, remote);
    msg('');
    openCacheModal(`
      <h3>${escHtml(title)}</h3>
      <p class="muted">Voici ce qui manque dans Supabase, et ce qui sera réimporté. Rien d’autre n’est écrasé.</p>
      ${renderCacheDiff(diff)}
      <div class="modal-actions">
        <button type="button" class="bo-btn" data-close>Annuler</button>
        <button type="button" class="bo-btn primary" id="cacheImportGo" ${diff.totalToImport ? '' : 'disabled'}>
          ${diff.totalToImport ? `Réimporter le manquant (${diff.totalToImport})` : 'Rien à importer'}
        </button>
      </div>`, (ov) => {
      const go = ov.querySelector('#cacheImportGo');
      if (!go || !diff.totalToImport) return;
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = 'Import…';
        try {
          await db.applyCacheImport(diff);
          const n = await sync.pushPartial({
            matches: diff.missingMatches,
            sales: diff.salesToImport,
            stock_moves: diff.missingMoves,
          });
          closeCacheModal();
          msg(`Import OK ✓ — ${diff.salesToImport.length} vente(s), ${diff.missingMoves.length} mouvement(s), ${n} envoyés.`, 'ok');
          ctx.toast('Manquant réimporté vers Supabase');
          ctx.onChanged && ctx.onChanged();
        } catch (e) {
          go.disabled = false;
          go.textContent = `Réimporter le manquant (${diff.totalToImport})`;
          msg('Erreur : ' + e.message, 'err');
        }
      });
    });
  };

  host.querySelector('#sbPushCache').addEventListener('click', async () => {
    try {
      const state = await db.exportState();
      await previewThenImport(state, 'Comparatif cache local → Supabase');
    } catch (e) { msg('Erreur : ' + e.message, 'err'); }
  });
  host.querySelector('#sbImportCache').addEventListener('click', () => {
    host.querySelector('#sbImportCacheFile').click();
  });
  host.querySelector('#sbImportCacheFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || typeof payload !== 'object') throw new Error('Fichier cache invalide');
      await previewThenImport(payload, 'Comparatif dump JSON → Supabase');
    } catch (err) { msg('Erreur : ' + err.message, 'err'); }
  });
  host.querySelector('#sbRestoreMatches').addEventListener('click', async () => {
    msg('Réinjection du calendrier domicile…');
    try {
      await db.ensureMatches();
      const n = await sync.pushAll();
      msg(`Calendrier 26/27 réinjecté et poussé ✓ — ${n} enregistrements.`, 'ok');
      ctx.toast('Matchs du calendrier envoyés');
      ctx.onChanged && ctx.onChanged();
      renderReglages(host, ctx);
    } catch (e) { msg('Erreur : ' + e.message, 'err'); }
  });
  host.querySelector('#sbDumpCache').addEventListener('click', async () => {
    try {
      const state = await db.exportState();
      const payload = {
        exported_at: new Date().toISOString(),
        matches: state.matches || [],
        sales: state.sales || [],
        stock_moves: state.stock_moves || [],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tfhb-cache-matches.json';
      a.click();
      URL.revokeObjectURL(a.href);
      msg(`Cache téléchargé — ${(payload.matches || []).length} matchs, ${(payload.sales || []).length} ventes.`, 'ok');
      ctx.toast('Cache JSON téléchargé');
    } catch (e) { msg('Erreur : ' + e.message, 'err'); }
  });

  // --- Saisons ---
  const drawSeasons = () => {
    host.querySelector('#seasonRows').innerHTML = seasons.map((s) => {
      const active = s.id === activeId;
      const closed = !!s.closed_at;
      return `<tr>
        <td><b>${s.label}</b>${active ? ' <span class="cat-badge">active</span>' : ''}</td>
        <td>${closed ? 'Clôturée le ' + new Date(s.closed_at).toLocaleDateString('fr-FR') : 'En cours'}</td>
        <td>${active ? '' : `<button class="bo-btn" data-act="${s.id}">Activer</button>`}
            ${closed ? '' : `<button class="bo-btn" data-close="${s.id}">Clôturer</button>`}</td></tr>`;
    }).join('');
    host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      await db.setActiveSeason(b.dataset.act); ctx.toast('Saison activée'); ctx.onChanged && ctx.onChanged();
      renderReglages(host, ctx);
    }));
    host.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', async () => {
      await db.closeSeason(b.dataset.close); ctx.toast('Saison clôturée'); renderReglages(host, ctx);
    }));
  };
  drawSeasons();
  host.querySelector('#addSeason').addEventListener('click', async () => {
    const label = host.querySelector('#newSeason').value.trim();
    if (!label) return ctx.toast('Nom de saison requis');
    await db.createSeason(label);
    ctx.toast('Saison « ' + label + ' » créée et activée');
    ctx.onChanged && ctx.onChanged();
    renderReglages(host, ctx);
  });

  // --- Matchs ---
  host.querySelector('#matchRows').innerHTML = matches.map((m) => `<tr>
    <td>${m.logo ? `<img class="match-logo" src="${m.logo}" alt="">` : '<span class="match-logo empty"></span>'}</td>
    <td><b>${m.code || '—'}</b></td><td>${m.label || '—'}</td>
    <td>${formatMatchDate(m.date) || '—'}</td>
    <td>${CHAN[m.channel] || 'Soir de match'}</td>
    <td class="match-acts">
      <button class="bo-btn mini" data-logo="${m.id}">${m.logo ? 'Changer' : '＋ Logo'}</button>
      ${m.logo ? `<button class="bo-btn mini" data-logodel="${m.id}">Retirer</button>` : ''}
      <button class="bo-x" data-delmatch="${m.id}">🗑</button></td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Aucun match</td></tr>';
  host.querySelectorAll('[data-delmatch]').forEach((b) => b.addEventListener('click', async () => {
    await db.deleteMatch(b.dataset.delmatch); ctx.toast('Match supprimé'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
  }));
  host.querySelectorAll('[data-logo]').forEach((b) => b.addEventListener('click', () => {
    pendingLogoMatch = b.dataset.logo; host.querySelector('#matchLogoFile').click();
  }));
  host.querySelectorAll('[data-logodel]').forEach((b) => b.addEventListener('click', async () => {
    await db.setMatchLogo(b.dataset.logodel, null); ctx.toast('Logo retiré'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
  }));
  host.querySelector('#matchLogoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file || !pendingLogoMatch) return;
    try {
      const dataUrl = await resizeLogo(file, 128);
      await db.setMatchLogo(pendingLogoMatch, dataUrl);
      ctx.toast('Logo importé ✓'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
    } catch (err) { ctx.toast('Erreur logo : ' + err.message); }
    pendingLogoMatch = null;
  });
  host.querySelector('#addMatch').addEventListener('click', async () => {
    const code = host.querySelector('#mCode').value.trim();
    const label = host.querySelector('#mLabel').value.trim();
    if (!code && !label) return ctx.toast('Code ou nom requis');
    await db.saveMatch({ code, label, channel: host.querySelector('#mChan').value });
    ctx.toast('Match ajouté'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
  });

  // --- Catégories ---
  host.querySelector('#catChips').innerHTML = categories.map((c) =>
    `<span class="cat-chip" data-chip="${encodeURIComponent(c)}">
      <span class="cat-chip-label">${c}</span>
      <button type="button" class="cat-ren" data-rencat="${encodeURIComponent(c)}" title="Renommer">✎</button>
      <button type="button" data-delcat="${encodeURIComponent(c)}" title="Supprimer">×</button>
    </span>`).join('');
  host.querySelectorAll('[data-delcat]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await db.removeCategory(decodeURIComponent(b.dataset.delcat));
      ctx.toast('Catégorie supprimée'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
    } catch (e) { ctx.toast(e.message); }
  }));
  host.querySelectorAll('[data-rencat]').forEach((b) => b.addEventListener('click', () => {
    const old = decodeURIComponent(b.dataset.rencat);
    const chip = b.closest('.cat-chip');
    const label = chip.querySelector('.cat-chip-label');
    if (chip.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'bo-input cat-chip-input';
    input.value = old;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (!save || !next || next === old) {
        renderReglages(host, ctx);
        return;
      }
      try {
        await db.renameCategory(old, next);
        ctx.toast('Catégorie « ' + next + ' »');
        ctx.onChanged && ctx.onChanged();
        renderReglages(host, ctx);
        flashOk(host.querySelector(`[data-chip="${encodeURIComponent(next)}"]`));
      } catch (e) {
        ctx.toast(e.message);
        renderReglages(host, ctx);
      }
    };
    input.addEventListener('blur', () => void finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    });
  }));
  host.querySelector('#addCat').addEventListener('click', async () => {
    const name = host.querySelector('#newCat').value.trim();
    if (!name) return ctx.toast('Nom de catégorie requis');
    await db.addCategory(name);
    ctx.toast('Catégorie « ' + name + ' » ajoutée'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
  });
}
