-- =========================================================================
-- Brass & Thread — Driver sees ALL "Out for Delivery" orders, not just COD
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run, AFTER
-- supabase-schema-delivery-drivers.sql.
--
-- Before this: get_driver_orders() only returned COD orders, since
-- "mark Paid" only makes sense for COD. But the admin already has an
-- "Out for Delivery" option for every order regardless of payment
-- method — a GCash/Bank Transfer order still has to physically get
-- delivered, so the driver should see it too, just without a "Paid"
-- step (that one's already paid, or the admin is confirming it
-- separately).
--
-- So now:
--   - COD order → driver taps "Mark Paid & Delivered" (unchanged,
--     mark_cod_paid_delivered — sets payment_status AND order_status)
--   - Any other payment method → driver taps "Mark Delivered"
--     (new, mark_delivered — sets order_status only, leaves payment
--     alone, since that's the admin's call)
-- =========================================================================

create or replace function get_driver_orders()
returns setof orders
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from drivers where user_id = auth.uid()) then
    raise exception 'NOT_AUTHORIZED: driver only';
  end if;

  return query
  select * from orders
  where order_status = 'Out for Delivery'
  order by created_at asc;
end;
$$;

grant execute on function get_driver_orders() to authenticated;

-- ===== mark_delivered — for non-COD orders (payment already handled elsewhere) =====
create or replace function mark_delivered(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
begin
  if not exists (select 1 from drivers where user_id = auth.uid()) then
    raise exception 'NOT_AUTHORIZED: driver only';
  end if;

  select * into v_order from orders where id = p_order_id for update;

  if v_order is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.order_status <> 'Out for Delivery' then
    raise exception 'NOT_ELIGIBLE: only an order that is Out for Delivery can be marked this way';
  end if;

  update orders
    set order_status = 'Delivered'
    where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

grant execute on function mark_delivered(uuid) to authenticated;
