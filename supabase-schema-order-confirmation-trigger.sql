-- =========================================================================
-- Brass & Thread — Trigger: email the customer the moment they order
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run, AFTER you've
-- redeployed supabase/functions/send-order-email/index.ts (it now
-- handles two kinds of emails — this is what sends the second kind).
--
-- Unlike supabase-schema-order-email-trigger.sql (which fires on every
-- STATUS CHANGE), this one fires once, right when the order is first
-- created — the "Thanks for ordering, here's your order number" email.
-- It calls the exact same Edge Function, so it reuses the same URL and
-- secret already filled in below (copied from the other trigger file —
-- keep both in sync if you ever redeploy the function under a new name).
-- =========================================================================

create extension if not exists pg_net;

create or replace function notify_order_placed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Walk-in sales (record_walkin_sale) are handed over in person and
  -- usually have no email on file — only email online storefront orders.
  if new.channel = 'online' then
    perform net.http_post(
      url := 'https://oyujsqzueghivhjgmukn.supabase.co/functions/v1/dynamic-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', 'bt-webhook-x7k2m9p4qz'
      ),
      body := jsonb_build_object(
        'type', 'order_placed',
        'record', to_jsonb(new)
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_placed_email on orders;

create trigger trg_order_placed_email
  after insert on orders
  for each row
  execute function notify_order_placed();
