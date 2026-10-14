-- =========================================================================
-- Brass & Thread — Proof-of-delivery photo required for Delivery orders
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run, AFTER
-- supabase-schema-delivery-drivers.sql and
-- supabase-schema-driver-all-deliveries.sql.
--
-- A rider can no longer mark a Delivery order Paid/Delivered without
-- first uploading a photo — the product together with the recipient's
-- face, taken at the door. The photo lives in a private Storage bucket
-- (drivers can only upload, never browse; only the admin can view it),
-- and the admin sees it right on the order's detail view.
--
-- This only affects site/driver/ (mark_cod_paid_delivered,
-- mark_delivered) — Pickup orders are handled entirely by the admin and
-- are untouched by this.
-- =========================================================================

alter table orders add column if not exists delivery_proof_path text;

-- ===== Private bucket for proof-of-delivery photos =====
insert into storage.buckets (id, name, public)
values ('delivery-proofs', 'delivery-proofs', false)
on conflict (id) do nothing;

drop policy if exists "Drivers can upload delivery proof photos" on storage.objects;
drop policy if exists "Admin can view delivery proof photos" on storage.objects;

-- Drivers can only ever INSERT here — no select/update/delete policy
-- for them, so a driver can't browse or overwrite another delivery's
-- photo once it's uploaded.
create policy "Drivers can upload delivery proof photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'delivery-proofs'
    and exists (select 1 from drivers d where d.user_id = auth.uid())
  );

-- Only the admin can ever view these photos (via a signed URL the admin
-- dashboard requests client-side — the bucket itself is private, so
-- there's no public link to a customer's doorstep photo).
create policy "Admin can view delivery proof photos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'delivery-proofs'
    and exists (select 1 from admins a where a.user_id = auth.uid())
  );

-- ===== mark_cod_paid_delivered — now requires a proof photo path =====
drop function if exists mark_cod_paid_delivered(uuid);

create or replace function mark_cod_paid_delivered(p_order_id uuid, p_delivery_proof_path text)
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

  if coalesce(trim(p_delivery_proof_path), '') = '' then
    raise exception 'PROOF_PHOTO_REQUIRED: a delivery proof photo is required before marking this order delivered';
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
    set payment_status = 'Paid', order_status = 'Delivered', delivery_proof_path = p_delivery_proof_path
    where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

grant execute on function mark_cod_paid_delivered(uuid, text) to authenticated;

-- ===== mark_delivered — now requires a proof photo path =====
drop function if exists mark_delivered(uuid);

create or replace function mark_delivered(p_order_id uuid, p_delivery_proof_path text)
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

  if coalesce(trim(p_delivery_proof_path), '') = '' then
    raise exception 'PROOF_PHOTO_REQUIRED: a delivery proof photo is required before marking this order delivered';
  end if;

  select * into v_order from orders where id = p_order_id for update;

  if v_order is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.order_status <> 'Out for Delivery' or v_order.fulfillment_method <> 'Delivery' then
    raise exception 'NOT_ELIGIBLE: only an order that is Out for Delivery can be marked this way';
  end if;

  update orders
    set order_status = 'Delivered', delivery_proof_path = p_delivery_proof_path
    where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

grant execute on function mark_delivered(uuid, text) to authenticated;
