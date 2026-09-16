// @ts-nocheck — logique legacy migrée ; typage progressif
// Écran Réglages (Lot 4) : configuration Supabase + synchronisation + saisons.
import * as db from './db';
import * as sync from './sync';

let ctx = { toast: () => {} };
let pendingLogoMatch = null;

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
      <p class="muted">Les données dynamiques (catalogue, stock, ventes, matchs…) sont chargées depuis Supabase.
      IndexedDB sert de cache hors-ligne. Renseigne l'<b>URL</b> et la <b>clé anon</b> ici ou via <code>.env</code>.
      Avant la 1ʳᵉ synchro, exécute <code>supabase-schema.sql</code>
      (tables <code>products</code>, <code>stock</code>, <code>sales</code>, <code>sale_lines</code>…).</p>

      <div class="reg-status">
        <span class="badge ${st.online ? 'ok' : 'off'}">${st.online ? 'En ligne' : 'Hors-ligne'}</span>
        <span class="badge ${st.configured ? 'ok' : 'warn'}">${st.configured ? 'Configuré' : 'Non configuré'}</span>
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
        <thead><tr><th>Logo</th><th>Code</th><th>Nom</th><th>Type</th><th></th></tr></thead>
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
      <p class="muted">Les onglets de la caisse (Maillots, Textiles…). Ajoute une catégorie ; on ne peut supprimer qu'une catégorie sans article.</p>
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
    <td><b>${m.code || '—'}</b></td><td>${m.label || '—'}</td><td>${CHAN[m.channel] || 'Soir de match'}</td>
    <td class="match-acts">
      <button class="bo-btn mini" data-logo="${m.id}">${m.logo ? 'Changer' : '＋ Logo'}</button>
      ${m.logo ? `<button class="bo-btn mini" data-logodel="${m.id}">Retirer</button>` : ''}
      <button class="bo-x" data-delmatch="${m.id}">🗑</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">Aucun match</td></tr>';
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
    `<span class="cat-chip">${c}<button data-delcat="${encodeURIComponent(c)}" title="Supprimer">×</button></span>`).join('');
  host.querySelectorAll('[data-delcat]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await db.removeCategory(decodeURIComponent(b.dataset.delcat));
      ctx.toast('Catégorie supprimée'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
    } catch (e) { ctx.toast(e.message); }
  }));
  host.querySelector('#addCat').addEventListener('click', async () => {
    const name = host.querySelector('#newCat').value.trim();
    if (!name) return ctx.toast('Nom de catégorie requis');
    await db.addCategory(name);
    ctx.toast('Catégorie « ' + name + ' » ajoutée'); ctx.onChanged && ctx.onChanged(); renderReglages(host, ctx);
  });
}
