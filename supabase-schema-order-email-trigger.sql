-- =========================================================================
-- Brass & Thread — Trigger: email the customer on every order status change
-- ---------------------------------------------------------------------
-- RUN THIS AFTER you've deployed the send-order-email Edge Function and
-- set its RESEND_API_KEY + WEBHOOK_SECRET secrets (see DEPLOY.md).
--
-- BEFORE RUNNING, replace both placeholders below:
--   1. YOUR-PROJECT-REF   → the part of your Supabase URL before
--                           ".supabase.co" (Settings → General → Reference ID)
--   2. YOUR-WEBHOOK-SECRET → the exact same value you set as the
--                            WEBHOOK_SECRET secret on the Edge Function
-- =========================================================================

create extension if not exists pg_net;

create or replace function notify_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_status is distinct from old.order_status then
    perform net.http_post(
      url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-order-email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', 'YOUR-WEBHOOK-SECRET'
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

drop trigger if exists trg_order_status_email on orders;

create trigger trg_order_status_email
  after update on orders
  for each row
  execute function notify_order_status_change();
