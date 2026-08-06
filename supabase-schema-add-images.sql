-- =========================================================================
-- Brass & Thread — Add product photos
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run (safe to run once).
-- Adds an image_url column to products, then updates your 3 real items
-- to point at the photos in site/images/ and gives them real names.
-- =========================================================================

alter table products add column if not exists image_url text;

-- Update the 3 seeded rows that now have real photos. If you've already
-- edited/renamed these in the admin dashboard, adjust the `where` clauses
-- below to match instead (or just do this part from the Inventory tab).
-- Leading slash matters: a relative path like "images/x.jpg" resolves
-- differently on the storefront (/) vs the admin dashboard (/admin/).
-- A leading slash makes it root-relative, so it works from either page.
update products
  set name = 'New York America Tee', image_url = '/images/newyork-tee.jpg'
  where name = 'Graphic Tee — Faded Print' and color = 'Black' and size = 'M';

update products
  set name = 'Brooklyn Tee', image_url = '/images/brooklyn-tee.jpg'
  where name = 'Plain Overrun Tee' and color = 'White' and size = 'S';

update products
  set name = 'Toyota 86 Tee', image_url = '/images/toyota-tee.jpg'
  where name = 'Streetwear Print Tee' and color = 'Olive' and size = 'L';
