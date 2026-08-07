-- =========================================================================
-- Brass & Thread — Optional Customer Login
-- ---------------------------------------------------------------------
-- RUN THIS AFTER supabase-schema.sql (SQL Editor → New query → paste →
-- Run). It adds accounts customers can OPTIONALLY create — guest
-- checkout keeps working exactly as before either way.
--
-- Why this is needed: until now, "authenticated" meant "the admin" —
-- any logged-in session could read every order. Once customers can log
-- in too, that's no longer safe, so this migration introduces a real
-- `admins` table and rewrites the policies to check membership in it:
--   - the admin (listed in `admins`) can still see/manage everything
--   - a customer with an account sees ONLY their own orders
--   - guests (no account) can still check out exactly as before
--
-- BEFORE RUNNING: replace 'PASTE-YOUR-ADMIN-EMAIL-HERE' below with the
-- admin email you created in Authentication → Users (Step 3 of DEPLOY.md).
-- =========================================================================

-- ===== Admins table — marks which auth accounts are the shop admin =====
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Newer Supabase projects enable RLS by default on every new table. If
-- this table has no SELECT policy, the `exists (select 1 from admins ...)`
-- check inside every product/order policy sees nothing and always
-- evaluates false — every admin write then silently affects 0 rows
-- (no error, nothing happens). This policy is what makes that check work.
alter table admins enable row level security;

drop policy if exists "Authenticated can check admin membership" on admins;

create policy "Authenticated can check admin membership"
  on admins for select
  to authenticated
  using (true);

insert into admins (user_id)
select id from auth.users where email = 'jpasuncion.laca@gmail.com'
on conflict (user_id) do nothing;

-- ===== Orders: optional link to a customer account =====
alter table orders add column if not exists user_id uuid references auth.users(id);

-- ===== Replace policies that assumed "any logged-in session = admin" =====
drop policy if exists "Admin can insert products" on products;
drop policy if exists "Admin can update products" on products;
drop policy if exists "Admin can delete products" on products;
drop policy if exists "Admin can view orders" on orders;
drop policy if exists "Admin can update orders" on orders;

create policy "Admin can insert products" on products
  for insert to authenticated
  with check (exists (select 1 from admins a where a.user_id = auth.uid()));

create policy "Admin can update products" on products
  for update to authenticated
  using (exists (select 1 from admins a where a.user_id = auth.uid()));

create policy "Admin can delete products" on products
  for delete to authenticated
  using (exists (select 1 from admins a where a.user_id = auth.uid()));

create policy "Admin can view all orders" on orders
  for select to authenticated
  using (exists (select 1 from admins a where a.user_id = auth.uid()));

create policy "Admin can update orders" on orders
  for update to authenticated
  using (exists (select 1 from admins a where a.user_id = auth.uid()));

-- A customer with an account can see their own order history.
create policy "Customer can view own orders" on orders
  for select to authenticated
  using (auth.uid() = user_id);

-- ===== place_order: tag the order with the signed-in customer, if any =====
-- auth.uid() reflects whoever is actually calling (null for a guest using
-- the anon key, or the customer's id if they're logged in) regardless of
-- this function's own SECURITY DEFINER privileges.
create or replace function place_order(
  p_items jsonb,
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
    payment_status, user_id
  ) values (
    v_code, 'online', v_order_items, v_total,
    p_full_name, p_contact_number, p_email, p_address, p_payment_method, p_order_notes,
    'Pending', auth.uid()
  )
  returning * into v_order;

  return v_order;
end;
$$;

grant execute on function place_order(jsonb, text, text, text, text, text, text) to anon, authenticated;

-- ===== record_walkin_sale: now needs its own admin check =====
-- (previously safe because only the admin could ever be "authenticated";
-- that's no longer true now that customers can log in too)
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
