-- =========================================================================
-- Brass & Thread — Restore stock when an order is Cancelled
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Bug this fixes: cancelling an order (via the Fulfillment dropdown)
-- previously just changed the order_status text — the stock deducted
-- at checkout stayed deducted forever, even though the sale never
-- actually happened. For overrun stock, where a batch often can't be
-- reordered, that permanently (and wrongly) shrinks the shelf count.
--
-- This function adds each cancelled item's quantity back to its
-- product's stock, atomically, and is a no-op if the order was
-- already Cancelled (so re-selecting "Cancelled" twice can't
-- double-restore stock).
-- =========================================================================

create or replace function cancel_order(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
  v_item jsonb;
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'NOT_AUTHORIZED: admin only';
  end if;

  select * into v_order from orders where id = p_order_id for update;

  if v_order is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.order_status = 'Cancelled' then
    return v_order; -- already cancelled — don't restore stock twice
  end if;

  for v_item in select * from jsonb_array_elements(v_order.items)
  loop
    update products
      set stock = stock + (v_item ->> 'qty')::int
      where id = (v_item ->> 'product_id')::uuid;
  end loop;

  update orders set order_status = 'Cancelled' where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

grant execute on function cancel_order(uuid) to authenticated;
