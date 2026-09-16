-- Journal d'entrées / sorties de stock (vente, remboursement, réassort).
-- À exécuter dans Supabase > SQL Editor si le projet existe déjà
-- (sans relancer supabase-schema.sql qui recrée toutes les tables).

create table if not exists public.stock_moves (
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

create index if not exists stock_moves_sku_idx on public.stock_moves(sku);
create index if not exists stock_moves_product_idx on public.stock_moves(product_id);
create index if not exists stock_moves_season_idx on public.stock_moves(season_id);
create index if not exists stock_moves_created_idx on public.stock_moves(created_at desc);

alter table public.stock_moves enable row level security;
drop policy if exists tfhb_all on public.stock_moves;
create policy tfhb_all on public.stock_moves for all to anon using (true) with check (true);
