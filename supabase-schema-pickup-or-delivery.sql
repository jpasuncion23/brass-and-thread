-- =========================================================================
-- Brass & Thread — Pickup or Delivery, chosen at checkout
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run, AFTER
-- supabase-schema-delivery-drivers.sql and
-- supabase-schema-driver-all-deliveries.sql.
--
-- Adds a fulfillment_method to every order ('Delivery' or 'Pickup'),
-- chosen by the customer at checkout — independent of payment method,
-- so COD/GCash/Bank Transfer all work with either choice. This changes
-- who handles a COD order's "mark Paid" step, and who ever sees it:
--   - Delivery → the rider handles it (site/driver/), unchanged from
--     before
--   - Pickup → no rider involved at all; the order never appears in the
--     driver portal, and the admin marks it Paid + Delivered themselves
--     once the customer shows up and pays in person, same as any other
--     in-person sale
-- =========================================================================

alter table orders add column if not exists fulfillment_method text not null default 'Delivery';

alter table orders drop constraint if exists orders_fulfillment_method_check;
alter table orders add constraint orders_fulfillment_method_check
  check (fulfillment_method in ('Delivery', 'Pickup'));

-- Walk-in sales are already handed over in person at checkout — that's
-- a pickup, not a delivery.
update orders set fulfillment_method = 'Pickup' where channel = 'walkin';

-- ===== place_order — now takes the customer's Delivery/Pickup choice =====
drop function if exists place_order(jsonb, text, text, text, text, text, text);

create or replace function place_order(
  p_items jsonb,
  p_full_name text,
  p_contact_number text,
  p_email text,
  p_address text,
  p_payment_method text,
  p_order_notes text,
  p_fulfillment_method text default 'Delivery'
) returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_product products;
  v_order_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_order orders;
  v_code text;
  v_fulfillment text;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'CART_EMPTY: your cart is empty';
  end if;
  if coalesce(p_full_name, '') = '' or coalesce(p_contact_number, '') = ''
     or coalesce(p_email, '') = '' or coalesce(p_payment_method, '') = '' then
    raise exception 'MISSING_FIELDS: full name, contact number, email and payment method are required';
  end if;

  v_fulfillment := case when p_fulfillment_method = 'Pickup' then 'Pickup' else 'Delivery' end;

  -- Pass 1: lock every line's product row and validate stock BEFORE
  -- writing anything.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product from products
      where id = (v_item ->> 'product_id')::uuid
      for update;

    if v_product is null then
      raise exception 'PRODUCT_NOT_FOUND: item no longer exists';
    end if;

    if v_product.stock < (v_item ->> 'qty')::int then
      raise exception 'INSUFFICIENT_STOCK: "%s" (%s/%s) only has %s left',
        v_product.name, v_product.size, v_product.color, v_product.stock;
    end if;
  end loop;

  -- Pass 2: everything checked out fine — deduct and build the order record.
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    update products
      set stock = stock - (v_item ->> 'qty')::int
      where id = (v_item ->> 'product_id')::uuid
      returning * into v_product;

    v_order_items := v_order_items || jsonb_build_object(
      'product_id', v_product.id,
      'name', v_product.name,
      'size', v_product.size,
      'color', v_product.color,
      'price', v_product.price,
      'qty', (v_item ->> 'qty')::int
    );
    v_total := v_total + v_product.price * (v_item ->> 'qty')::int;
  end loop;

  v_code := 'ORD-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(md5(random()::text), 1, 5));

  insert into orders (
    order_code, channel, items, total,
    full_name, contact_number, email, address, payment_method, order_notes,
    payment_status, user_id, fulfillment_method
  ) values (
    v_code, 'online', v_order_items, v_total,
    p_full_name, p_contact_number, p_email, p_address, p_payment_method, p_order_notes,
    'Pending', auth.uid(), v_fulfillment
  )
  returning * into v_order;

  return v_order;
end;
$$;

grant execute on function place_order(jsonb, text, text, text, text, text, text, text) to anon, authenticated;

-- ===== record_walkin_sale — always Pickup (handed over in person) =====
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
    payment_status, order_status, fulfillment_method
  ) values (
    v_code, 'walkin',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'size', v_product.size,
      'color', v_product.color, 'price', v_product.price, 'qty', p_qty
    )),
    v_product.price * p_qty,
    coalesce(p_customer_name, 'Walk-in customer'), '', '', '', 'Cash', '',
    'Paid', 'Delivered', 'Pickup'
  )
  returning * into v_order;

  return v_order;
end;
$$;

grant execute on function record_walkin_sale(uuid, int, text) to authenticated;

-- ===== Driver only ever sees Delivery orders — Pickup never reaches them =====
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
    and fulfillment_method = 'Delivery'
  order by created_at asc;
end;
$$;

grant execute on function get_driver_orders() to authenticated;

create or replace function mark_cod_paid_delivered(p_order_id uuid)
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

  if v_order.payment_method <> 'COD' or v_order.order_status <> 'Out for Delivery'
     or v_order.fulfillment_method <> 'Delivery' then
    raise exception 'NOT_ELIGIBLE: only a COD order that is Out for Delivery can be marked this way';
  end if;

  update orders
    set payment_status = 'Paid', order_status = 'Delivered'
    where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

grant execute on function mark_cod_paid_delivered(uuid) to authenticated;

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

  if v_order.order_status <> 'Out for Delivery' or v_order.fulfillment_method <> 'Delivery' then
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

-- ===== track_order — now also returns fulfillment_method, so the
-- storefront can show "Ready for Pickup" instead of "Out for Delivery"
-- where that's what actually applies =====
drop function if exists track_order(text);

create or replace function track_order(p_order_code text)
returns table (
  order_code text,
  items jsonb,
  total numeric,
  full_name text,
  payment_method text,
  payment_status text,
  order_status text,
  fulfillment_method text,
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
         o.payment_status, o.order_status, o.fulfillment_method, o.created_at
  from orders o
  where o.order_code = trim(p_order_code)
  order by o.created_at desc;
end;
$$;

grant execute on function track_order(text) to anon, authenticated;
