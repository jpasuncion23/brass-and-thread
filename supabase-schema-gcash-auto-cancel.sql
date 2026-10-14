-- =========================================================================
-- Brass & Thread — Auto-cancel failed GCash payments + "payment received"
-- email
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- 1. cancel_unpaid_order(): cancels an order and puts its items back in
--    stock, but ONLY while it's still unpaid and untouched (Pending /
--    Pending). Called by the create-paymongo-source and paymongo-webhook
--    Edge Functions once PayMongo itself confirms a GCash payment failed,
--    expired or was cancelled — never on the browser's word alone.
--    Unlike cancel_order() (the admin's), only the service role can call
--    it — customers and the anon key can't.
--
-- 2. notify_order_status_change() now also fires when payment_status
--    changes (e.g. Pending → Paid), so send-order-email can tell the
--    customer their payment came through. It still fires on every
--    order_status change exactly as before.
-- =========================================================================

create or replace function cancel_unpaid_order(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders;
  v_item jsonb;
begin
  select * into v_order from orders where id = p_order_id for update;

  if v_order is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- Already paid, already being prepped, or already cancelled — leave
  -- it alone (and never restore stock twice).
  if v_order.payment_status <> 'Pending' or v_order.order_status <> 'Pending' then
    return v_order;
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

revoke execute on function cancel_unpaid_order(uuid) from public, anon, authenticated;
grant execute on function cancel_unpaid_order(uuid) to service_role;

create or replace function notify_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_status is distinct from old.order_status
     or new.payment_status is distinct from old.payment_status then
    perform net.http_post(
      -- "smart-processor" is the send-order-email function's real URL
      -- slug — see supabase-schema-order-email-trigger.sql.
      url := 'https://oyujsqzueghivhjgmukn.supabase.co/functions/v1/smart-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', order_email_secret()  -- from Vault, see supabase-schema-email-secret-vault.sql
      ),
      body := jsonb_build_object(
        'record', to_jsonb(new),
        'old_record', to_jsonb(old)
      )
    );
  end if;
  return new;
end;
$$;
