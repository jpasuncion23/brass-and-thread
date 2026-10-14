-- =========================================================================
-- Brass & Thread — Keep the order-email webhook secret in Supabase Vault
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- BEFORE running it, store the secret in Vault once (pick a long random
-- value — never commit it here), with this in its own query:
--
--   select vault.create_secret('<your-secret>', 'order_email_webhook_secret');
--
-- and set the exact same value as the WEBHOOK_SECRET secret on the
-- send-order-email Edge Function (Edge Functions → Secrets). To change
-- it later: vault.update_secret(<id>, '<new>') — see Vault in the
-- dashboard — then update WEBHOOK_SECRET to match.
--
-- Why: the secret used to be written into the trigger SQL files, and the
-- repo is public — anyone could have called send-order-email with it and
-- used the shop's Gmail to send mail. Now the triggers read it from
-- Vault at call time and no file holds it.
--
-- This replaces both trigger functions that call send-order-email:
--   notify_order_placed()         — AFTER INSERT (order received email)
--   notify_order_status_change()  — AFTER UPDATE (status / payment emails)
-- The triggers themselves already point at these functions, so nothing
-- else needs re-creating.
-- =========================================================================

create extension if not exists pg_net;

create or replace function order_email_secret()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = 'order_email_webhook_secret'
  limit 1;
$$;

revoke execute on function order_email_secret() from public, anon, authenticated;

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
      -- "smart-processor" is the send-order-email function's real URL slug.
      url := 'https://oyujsqzueghivhjgmukn.supabase.co/functions/v1/smart-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', order_email_secret()
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
      url := 'https://oyujsqzueghivhjgmukn.supabase.co/functions/v1/smart-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', order_email_secret()
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
