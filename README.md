# Caisse Boutique TFHB

Caisse enregistreuse + gestion de stock de la boutique du **Tremblay Handball**, pensée
tablette pour le soir de match. Application **Next.js (TypeScript)**, **installable** (PWA)
et **fonctionnant hors-ligne** (IndexedDB + service worker).

## Lot 1 — la Caisse
- Sélection article → taille en 2 taps, gros boutons.
- Quantité + / −, **Annuler** (undo).
- Remises **Abonné −20 %**, **Salarié**, et **Imputation com** (dotation : sort du stock, 0 € de recette).
- **Décrément automatique du stock** par taille, affiché en direct.
- Encaissement avec **moyen de paiement** (Espèces / CB / Chèque) et **reçu PDF** optionnel.
- Rattachement des ventes à un **match** (J01…J30 + Boutique en ligne).
- KPIs temps réel : **Total ventes, Nbr de ventes, Panier moyen, Imputation com**.
- Persistance locale **IndexedDB**.
- Catalogue, tailles et prix issus des fichiers Excel.

## Lot 2 — le Back-office
Onglet **Back-office** : catalogue & stock, historique ventes, factures & marquage,
import/export Excel (SheetJS).

## Lot 3 — Finances
Onglet **Finances** : recettes, coûts, bénéfices, valorisation stock, Valo Com.

## Lot 4 — Synchronisation & multi-saisons
Onglet **Réglages** : synchro Supabase (last-write-wins) + gestion des saisons.

### Activer la synchronisation
1. Crée un projet gratuit sur [supabase.com](https://supabase.com).
2. Dans **SQL Editor**, exécute [`supabase-schema.sql`](supabase-schema.sql) (tables métier typées).
3. Dans **Project Settings → API**, copie l’**URL** et la **clé anon** dans `.env`.
4. Dans l’app → **Réglages**, **Tester la connexion** puis **Synchroniser**.

## Lancer en local

```bash
npm install
npm run dev
```

Ouvrir http://localhost:3000

## Build production

```bash
npm run build
npm start
```

## Structure

```
src/app/                 App Router Next.js (layout, page, CSS)
src/components/          Coquille React client
src/lib/                 Logique métier TypeScript (caisse, db, sync…)
public/assets|fonts|icons  Assets statiques + PWA (manifest, sw.js)
supabase-schema.sql      Schéma Supabase
```
