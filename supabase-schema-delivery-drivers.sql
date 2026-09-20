-- =========================================================================
-- Brass & Thread — Delivery drivers (mark COD orders Paid on delivery)
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Adds a THIRD kind of account, separate from admin and customer: a
-- delivery driver. A driver logs in through their own page
-- (site/driver/index.html), not the admin dashboard, and can only:
--   - see COD orders that are "Out for Delivery"
--   - flip exactly one of those to Paid + Delivered, when they actually
--     collect the cash at the door
-- Nothing else in the database (products, other orders, analytics) is
-- exposed to a driver account — this is enforced by the two functions
-- below, not by giving drivers a broad RLS policy on `orders`.
--
-- Once this order is marked Delivered, the existing order-status email
-- trigger (supabase-schema-order-email-trigger.sql) emails the customer
-- automatically, and the admin dashboard's live realtime feed reflects
-- the payment the moment it happens — neither needs the admin to do
-- anything by hand anymore for COD.
--
-- ----- To give someone driver access -----
-- 1. Supabase dashboard → Authentication → Users → Add user → their own
--    email + password (check "Auto Confirm User"). This is a completely
--    separate account from any admin or customer account.
-- 2. Copy their User UID from that same Users list.
-- 3. Run, with their real UID and name:
--      insert into drivers (user_id, full_name)
--      values ('PASTE-THEIR-USER-UID', 'Driver Name');
-- 4. Give them the link to site/driver/ (e.g.
--    https://yoursite.netlify.app/driver/) — that's their login page.
-- =========================================================================

create table if not exists drivers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now()
);

alter table drivers enable row level security;

drop policy if exists "Authenticated can check driver membership" on drivers;
create policy "Authenticated can check driver membership"
  on drivers for select
  to authenticated
  using (true);

-- No insert/update/delete policy on purpose — only you, running SQL
-- directly in the dashboard (which bypasses RLS), should ever add or
-- remove a driver. Same pattern as the `admins` table.

-- ===== get_driver_orders — the ONLY orders a driver account can ever see =====
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
  where payment_method = 'COD'
    and order_status = 'Out for Delivery'
  order by created_at asc;
end;
$$;

grant execute on function get_driver_orders() to authenticated;

-- ===== mark_cod_paid_delivered — the ONLY write a driver account can ever make =====
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

  if v_order.payment_method <> 'COD' or v_order.order_status <> 'Out for Delivery' then
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

-- `orders` is already in the supabase_realtime publication (see
-- supabase-schema.sql), so no extra step is needed for the admin
-- dashboard or the driver's own order list to update live.
--
-- One extra bit for the admin dashboard's toast notification: by
-- default, a realtime UPDATE payload's "old record" only carries the
-- primary key, not the columns that actually changed — not enough to
-- tell "this order just got marked Paid" apart from "this order was
-- already Paid and something unrelated changed". REPLICA IDENTITY FULL
-- makes the full previous row available so that check is accurate.
alter table orders replica identity full;
