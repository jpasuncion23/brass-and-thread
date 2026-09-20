-- =========================================================================
-- Brass & Thread — One login form for everyone (customer, admin, driver)
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Before this: the storefront, the admin dashboard, and the driver
-- portal each had their own separate login form. Now there's just one —
-- the "Log In" button on the storefront (site/index.html) — and after
-- signing in, the site asks the database "what is this account?" via
-- get_my_role() below, then sends admin accounts to /admin/, driver
-- accounts to /driver/, and leaves everyone else logged in as a regular
-- customer right where they are.
--
-- This doesn't change who can do what — that's still entirely enforced
-- by the `admins`/`drivers` tables and the RLS policies/functions that
-- check them. This function just tells the frontend where to send
-- someone after they log in; it isn't a security boundary itself.
-- =========================================================================

create or replace function get_my_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select case
    when exists (select 1 from admins where user_id = auth.uid()) then 'admin'
    when exists (select 1 from drivers where user_id = auth.uid()) then 'driver'
    else 'customer'
  end;
$$;

grant execute on function get_my_role() to authenticated;
