-- ============================================================
--  Schéma Supabase — Caisse Boutique TFHB
--  À exécuter dans : Supabase > SQL Editor > New query > Run
--
--  ⚠️ Remplace l’ancien modèle (key + data jsonb).
--  Si tu avais déjà créé les tables génériques, ce script les
--  recrée avec des colonnes métier (données sync précédentes perdues).
-- ============================================================

drop table if exists public.photos cascade;
drop table if exists public.stock_moves cascade;
drop table if exists public.fin_adjust cascade;
drop table if exists public.invoices cascade;
drop table if exists public.sale_lines cascade;
drop table if exists public.sales cascade;
drop table if exists public.matches cascade;
drop table if exists public.stock cascade;
drop table if exists public.product_variants cascade;
drop table if exists public.products cascade;
drop table if exists public.seasons cascade;
drop table if exists public.app_meta cascade;

-- ------------------------------------------------------------
--  Saisons
-- ------------------------------------------------------------
create table public.seasons (
  id          text primary key,
  label       text not null,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
--  Catalogue
-- ------------------------------------------------------------
create table public.products (
  id          text primary key,
  name        text not null,
  category    text not null,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table public.product_variants (
  product_id         text not null references public.products(id) on delete cascade,
  size               text not null,
  size_system        text not null,
  sale_price         numeric(12,2) not null default 0,
  purchase_price_ht  numeric(12,2),
  marking_cost       numeric(12,2) not null default 0,
  primary key (product_id, size)
);

create index product_variants_product_idx on public.product_variants(product_id);

-- ------------------------------------------------------------
--  Stock (1 ligne par SKU = productId|size)
-- ------------------------------------------------------------
create table public.stock (
  sku         text primary key,
  product_id  text,                          -- dérivé du sku (avant |)
  size        text,                          -- dérivé du sku (après |)
  physique    integer not null default 0,
  reserve     integer not null default 0,
  en_ligne    integer not null default 0,
  archive     integer not null default 0,
  salarie     integer not null default 0,
  sal_euro    numeric(12,2) not null default 0,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index stock_product_idx on public.stock(product_id);

-- ------------------------------------------------------------
--  Matchs / canaux
-- ------------------------------------------------------------
create table public.matches (
  id          text primary key,
  code        text not null,
  label       text not null,
  date        date,
  channel     text not null default 'physique'
              check (channel in ('physique', 'en_ligne', 'salarie')),
  logo        text,                          -- data URL (ou URL Storage)
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create unique index matches_code_alive_idx
  on public.matches(code) where deleted = false;

-- ------------------------------------------------------------
--  Ventes
-- ------------------------------------------------------------
create table public.sales (
  id              text primary key,
  season_id       text references public.seasons(id),
  match_id        text references public.matches(id),
  match_label     text,
  channel         text not null default 'physique',
  payment_method  text not null default 'espece'
                  check (payment_method in ('espece', 'cb', 'cheque')),
  total           numeric(12,2) not null default 0,
  com_total       numeric(12,2) not null default 0,
  deleted         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sales_match_idx on public.sales(match_id);
create index sales_season_idx on public.sales(season_id);

create table public.sale_lines (
  id          bigserial primary key,
  sale_id     text not null references public.sales(id) on delete cascade,
  sku         text not null,
  name        text not null,
  size        text not null,
  qty         integer not null check (qty > 0),
  unit        numeric(12,2) not null default 0,
  mode        text not null default 'plein'
              check (mode in ('plein', 'abonne', 'salarie', 'com')),
  line_total  numeric(12,2) not null default 0
);

create index sale_lines_sale_idx on public.sale_lines(sale_id);

-- ------------------------------------------------------------
--  Factures (achats HT / marquage)
-- ------------------------------------------------------------
create table public.invoices (
  id          text primary key,
  season_id   text references public.seasons(id),
  ref         text not null default '',
  type        text not null default 'achat'
              check (type in ('achat', 'marquage')),
  amount      numeric(12,2) not null default 0,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index invoices_season_idx on public.invoices(season_id);

-- ------------------------------------------------------------
--  Ajustements financiers (entrées manuelles + overrides KPI)
-- ------------------------------------------------------------
create table public.fin_adjust (
  id          text primary key,
  season_id   text references public.seasons(id),
  type        text not null check (type in ('entry', 'override')),
  kind        text,                          -- entry: 'recette' | 'cout'
  label       text,
  amount      numeric(12,2),                 -- entry
  field       text,                          -- override: recettes|couts|benefices|valo_pv
  value       numeric(12,2),                 -- override
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index fin_adjust_season_idx on public.fin_adjust(season_id);

-- ------------------------------------------------------------
--  Photos articles (1 par produit)
-- ------------------------------------------------------------
create table public.photos (
  id          text primary key,              -- = products.id
  data_url    text,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
--  Méta partagée entre postes (catégories, saison active…)
-- ------------------------------------------------------------
create table public.app_meta (
  key         text primary key,
  value       jsonb not null default 'null'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
--  Journal d'entrées / sorties (maillots & stock)
-- ------------------------------------------------------------
create table public.stock_moves (
  id            text primary key,
  sku           text not null,
  product_id    text,
  product_name  text,
  size          text,
  category      text,
  direction     text not null check (direction in ('in', 'out')),
  reason        text not null,
  qty           integer not null check (qty > 0),
  location      text not null default 'physique',
  location_to   text,
  sale_id       text,
  match_id      text,
  match_label   text,
  note          text,
  season_id     text,
  deleted       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index stock_moves_sku_idx on public.stock_moves(sku);
create index stock_moves_product_idx on public.stock_moves(product_id);
create index stock_moves_season_idx on public.stock_moves(season_id);
create index stock_moves_created_idx on public.stock_moves(created_at desc);

-- ------------------------------------------------------------
--  Sécurité (RLS) — clé anon partagée entre les postes du club
--  ⚠️ Ne diffuse pas URL + clé anon hors du club.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'seasons','products','product_variants','stock','matches',
    'sales','sale_lines','invoices','fin_adjust','photos','app_meta','stock_moves'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists tfhb_all on public.%I;', t);
    execute format(
      'create policy tfhb_all on public.%I for all to anon using (true) with check (true);', t);
  end loop;
end $$;

-- ------------------------------------------------------------
--  (Optionnel) Temps réel
-- ------------------------------------------------------------
-- alter publication supabase_realtime add table
--   public.products, public.stock, public.matches,
--   public.sales, public.invoices, public.seasons;
