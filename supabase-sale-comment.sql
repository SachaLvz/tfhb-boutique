-- Commentaire libre sur une vente (n'importe quel statut, payée ou en attente).
-- À exécuter dans Supabase > SQL Editor si le projet existe déjà
-- (sans relancer supabase-schema.sql qui recrée toutes les tables).

alter table public.sales
  add column if not exists comment text;
