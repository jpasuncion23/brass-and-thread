-- =========================================================================
-- Brass & Thread — Fix: admin writes silently failing
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Why: newer Supabase projects enable Row Level Security by default on
-- every new table — including `admins`, which supabase-schema-optional-
-- login.sql created without an explicit policy. With RLS on and no
-- policy, the table is invisible to every query except ones run as the
-- Postgres superuser (like the SQL Editor) — so `select * from admins`
-- there looked fine, while the `exists (select 1 from admins ...)`
-- check inside every product/order policy silently saw nothing and
-- always evaluated to false. That's why Edit/Delete/Restock/Add all
-- looked like they worked (status 200/204, no error) but changed
-- nothing — Postgres just filtered the row out before the write could
-- match it.
-- =========================================================================

alter table admins enable row level security;

drop policy if exists "Authenticated can check admin membership" on admins;

create policy "Authenticated can check admin membership"
  on admins for select
  to authenticated
  using (true);

-- No insert/update/delete policy on purpose — only you, running SQL
-- directly in the dashboard (which bypasses RLS), should ever change
-- who's listed as admin.
