-- =========================================================================
-- Brass & Thread — Track My Order: order number only
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Replaces supabase-schema-track-order.sql's lookup (which needed the
-- contact number or email as proof, with order code as an optional
-- narrower) with a simpler rule: the order number alone is what you
-- type in "Track Order" now. Whoever placed the order already got it by
-- email (see supabase-schema-order-confirmation-trigger.sql) or saw it
-- on the confirmation screen, so it doubles as the lookup key.
-- =========================================================================

drop function if exists track_order(text, text);

create or replace function track_order(p_order_code text)
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
  if coalesce(trim(p_order_code), '') = '' then
    return;
  end if;

  return query
  select o.order_code, o.items, o.total, o.full_name, o.payment_method,
         o.payment_status, o.order_status, o.created_at
  from orders o
  where o.order_code = trim(p_order_code)
  order by o.created_at desc;
end;
$$;

grant execute on function track_order(text) to anon, authenticated;
