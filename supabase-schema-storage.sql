-- =========================================================================
-- Brass & Thread — Product Image Uploads
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run (safe to run once).
-- Creates a public storage bucket for product photos and lets the admin
-- (anyone listed in the `admins` table — see supabase-schema-optional-login.sql,
-- must be run BEFORE this one) upload/replace/delete images there.
-- Public visitors can only view — never upload or delete.
-- =========================================================================

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "Public can view product images" on storage.objects;
drop policy if exists "Admin can upload product images" on storage.objects;
drop policy if exists "Admin can update product images" on storage.objects;
drop policy if exists "Admin can delete product images" on storage.objects;

create policy "Public can view product images"
  on storage.objects for select
  using (bucket_id = 'product-images');

create policy "Admin can upload product images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy "Admin can update product images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'product-images'
    and exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy "Admin can delete product images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and exists (select 1 from admins a where a.user_id = auth.uid())
  );
