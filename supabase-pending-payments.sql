-- Paiement différé ("Paiement en attente" à la caisse, clos plus tard en back-office).
-- À exécuter dans Supabase > SQL Editor si le projet existe déjà
-- (sans relancer supabase-schema.sql qui recrée toutes les tables).

alter table public.sales
  alter column payment_method drop not null;

alter table public.sales
  drop constraint if exists sales_payment_method_check;
alter table public.sales
  add constraint sales_payment_method_check
  check (payment_method is null or payment_method in ('espece', 'cb', 'cheque'));

alter table public.sales
  add column if not exists payment_status text not null default 'paid'
  check (payment_status in ('paid', 'pending'));

alter table public.sales
  add column if not exists pending_reason text;

-- Corrige au passage la contrainte sur sale_lines.mode : le bouton "Salarié" du
-- panier a été renommé "Demande spéciale" (mode 'special'). 'salarie' est gardé
-- pour ne pas invalider les lignes déjà synchronisées avant ce renommage.
alter table public.sale_lines
  drop constraint if exists sale_lines_mode_check;
alter table public.sale_lines
  add constraint sale_lines_mode_check
  check (mode in ('plein', 'abonne', 'salarie', 'special', 'com'));
