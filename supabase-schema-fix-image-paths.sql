-- =========================================================================
-- Brass & Thread — Fix broken image paths
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Why: image_url values were saved as "images/xxx.jpg" (no leading
-- slash). That works from the storefront (which lives at /), but
-- resolves to the WRONG place from the admin dashboard (which lives at
-- /admin/) — the browser looks for /admin/images/xxx.jpg, a 404. Adding
-- a leading slash makes the path work from any page on the site.
-- =========================================================================

update products
set image_url = '/' || image_url
where image_url is not null
  and image_url not like '/%'
  and image_url not like 'http%';
