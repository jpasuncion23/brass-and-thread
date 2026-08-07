-- =========================================================================
-- Brass & Thread — Track My Order (guest-friendly, no login needed)
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Most customers use guest checkout, so "My Orders" (which needs an
-- account) doesn't help them. This function lets anyone look up their
-- order(s) using the contact number or email they gave at checkout —
-- proof they actually placed it — without exposing the rest of the
-- orders table to the public.
--
-- The order code is OPTIONAL: if the customer remembers it, it narrows
-- the search to that one order. If they forgot it, they can leave it
-- blank and every order tied to that contact number/email comes back
-- instead, newest first, so they can pick the one they meant.
-- =========================================================================

create or replace function track_order(p_contact text, p_order_code text default null)
returns table (
  order_code text,
  items jsonb,
  total numeric,
  full_name text,
  payment_method text,
  payment_status text,
  order_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select o.order_code, o.items, o.total, o.full_name, o.payment_method,
         o.payment_status, o.order_status, o.created_at
  from orders o
  where (p_order_code is null or trim(p_order_code) = '' or o.order_code = trim(p_order_code))
    and (o.contact_number = trim(p_contact) or lower(o.email) = lower(trim(p_contact)))
  order by o.created_at desc;
end;
$$;

grant execute on function track_order(text, text) to anon, authenticated;
