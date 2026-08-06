-- =========================================================================
-- Brass & Thread / ShopTrack — Supabase schema
-- ---------------------------------------------------------------------
-- Paste this whole file into Supabase → SQL Editor → New Query → Run.
-- Safe to run once on a fresh project. Re-running will error on the
-- "create table" lines if you've already run it (that's expected).
-- =========================================================================

create extension if not exists pgcrypto;

-- ===== TABLES =====

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  size text not null,
  color text not null,
  cost numeric not null default 0,
  price numeric not null,
  stock integer not null default 0,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null,
  channel text not null check (channel in ('online', 'walkin')),
  items jsonb not null,               -- [{product_id, name, size, color, price, qty}, ...]
  total numeric not null,
  full_name text not null,
  contact_number text,
  email text,
  address text,
  payment_method text not null,       -- 'COD' | 'GCash' | 'Cash'
  order_notes text,
  payment_status text not null default 'Pending' check (payment_status in ('Pending', 'Paid')),
  created_at timestamptz not null default now()
);

-- ===== ROW LEVEL SECURITY =====

alter table products enable row level security;
alter table orders enable row level security;

-- Anyone (including anonymous storefront visitors) can browse products.
create policy "Public can view products"
  on products for select
  using (true);

-- Only the logged-in admin (Supabase Auth session) can edit the catalog directly.
create policy "Admin can insert products"
  on products for insert
  to authenticated
  with check (true);

create policy "Admin can update products"
  on products for update
  to authenticated
  using (true);

create policy "Admin can delete products"
  on products for delete
  to authenticated
  using (true);

-- Orders are private — only the admin dashboard can read/update them.
-- Customers never SELECT this table directly; they get their own order
-- back as the return value of place_order() below, at checkout time only.
create policy "Admin can view orders"
  on orders for select
  to authenticated
  using (true);

create policy "Admin can update orders"
  on orders for update
  to authenticated
  using (true);

-- ===== CHECKOUT — atomic "re-check stock, deduct, create order" =====
-- This is Section 4 (Steps 2-5) of the paper, done as a single database
-- transaction so two customers racing for the last unit can't both win.
-- SECURITY DEFINER lets the anonymous storefront call this one narrow
-- operation without needing direct write access to the tables.

create or replace function place_order(
  p_items jsonb,              -- [{"product_id": "...", "qty": 2}, ...]
  p_full_name text,
  p_contact_number text,
  p_email text,
  p_address text,
  p_payment_method text,
  p_order_notes text
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
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'CART_EMPTY: your cart is empty';
  end if;
  if coalesce(p_full_name, '') = '' or coalesce(p_contact_number, '') = ''
     or coalesce(p_email, '') = '' or coalesce(p_payment_method, '') = '' then
    raise exception 'MISSING_FIELDS: full name, contact number, email and payment method are required';
  end if;

  -- Pass 1: lock every line's product row and validate stock BEFORE
  -- writing anything. Locks are held until commit, so a concurrent
  -- checkout for the same product waits here instead of over-selling.
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
    payment_status
  ) values (
    v_code, 'online', v_order_items, v_total,
    p_full_name, p_contact_number, p_email, p_address, p_payment_method, p_order_notes,
    'Pending'
  )
  returning * into v_order;

  return v_order;
end;
$$;

grant execute on function place_order(jsonb, text, text, text, text, text, text) to anon, authenticated;

-- ===== WALK-IN SALE — admin logs an in-person sale =====
-- Also atomic; also SECURITY DEFINER for the same reason, but only
-- grants execute to logged-in admins (RLS already blocks anon from
-- writing to products/orders, but this keeps the deduction atomic too).

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
    payment_status
  ) values (
    v_code, 'walkin',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'size', v_product.size,
      'color', v_product.color, 'price', v_product.price, 'qty', p_qty
    )),
    v_product.price * p_qty,
    coalesce(p_customer_name, 'Walk-in customer'), '', '', '', 'Cash', '',
    'Paid'
  )
  returning * into v_order;

  return v_order;
end;
$$;

grant execute on function record_walkin_sale(uuid, int, text) to authenticated;

-- ===== REALTIME — so the admin dashboard updates live, no refresh needed =====
do $$
begin
  execute 'alter publication supabase_realtime add table products';
exception when others then
  raise notice 'products: %', sqlerrm;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table orders';
exception when others then
  raise notice 'orders: %', sqlerrm;
end $$;

-- ===== STARTER CATALOG =====
insert into products (name, size, color, cost, price, stock) values
  ('Graphic Tee — Faded Print', 'M',  'Black',  120, 249, 5),
  ('Graphic Tee — Faded Print', 'L',  'Black',  120, 249, 2),
  ('Plain Overrun Tee',         'S',  'White',  80,  179, 8),
  ('Plain Overrun Tee',         'M',  'White',  80,  179, 0),
  ('Streetwear Print Tee',      'L',  'Olive',  150, 299, 3),
  ('Polo Overrun',              'XL', 'Navy',   160, 329, 1),
  ('Basic Crew Tee',            'M',  'Maroon', 90,  199, 6),
  ('Basic Crew Tee',            'L',  'Gray',   90,  199, 4);
