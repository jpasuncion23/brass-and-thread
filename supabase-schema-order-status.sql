-- =========================================================================
-- Brass & Thread — Order fulfillment status (Lazada/Shopee-style tracking)
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Adds a fulfillment stage to orders, separate from payment_status
-- (Paid/Pending is about money; this is about the physical order):
--   Processing → Out for Delivery → Delivered   (or Cancelled, any time)
--
-- Online orders start at "Processing". Walk-in sales start at
-- "Delivered" — the customer already has the item in hand at checkout.
-- =========================================================================

alter table orders add column if not exists order_status text not null default 'Processing';

alter table orders drop constraint if exists orders_order_status_check;
alter table orders add constraint orders_order_status_check
  check (order_status in ('Processing', 'Out for Delivery', 'Delivered', 'Cancelled'));

-- Existing walk-in rows were already handed over in person.
update orders set order_status = 'Delivered' where channel = 'walkin';

-- ===== record_walkin_sale: mark new walk-in sales Delivered too =====
create or replace function record_walkin_sale(
  p_product_id uuid,
  p_qty int,
  p_customer_name text
) returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product products;
  v_order orders;
  v_code text;
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'NOT_AUTHORIZED: admin only';
  end if;

  select * into v_product from products where id = p_product_id for update;

  if v_product is null then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'INVALID_QTY';
  end if;
  if v_product.stock < p_qty then
    raise exception 'INSUFFICIENT_STOCK: "%s" only has %s left', v_product.name, v_product.stock;
  end if;

  update products set stock = stock - p_qty where id = p_product_id;

  v_code := 'ORD-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(md5(random()::text), 1, 5));

  insert into orders (
    order_code, channel, items, total,
    full_name, contact_number, email, address, payment_method, order_notes,
    payment_status, order_status
  ) values (
    v_code, 'walkin',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'size', v_product.size,
      'color', v_product.color, 'price', v_product.price, 'qty', p_qty
    )),
    v_product.price * p_qty,
    coalesce(p_customer_name, 'Walk-in customer'), '', '', '', 'Cash', '',
    'Paid', 'Delivered'
  )
  returning * into v_order;

  return v_order;
end;
$$;

grant execute on function record_walkin_sale(uuid, int, text) to authenticated;
