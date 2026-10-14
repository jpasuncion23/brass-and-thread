-- =========================================================================
-- Brass & Thread — Every 10 minutes, cancel GCash orders whose payment
-- PayMongo says is dead
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run, AFTER
-- supabase-schema-gcash-auto-cancel.sql and after redeploying the
-- create-paymongo-source Edge Function (it needs the "sweep" action).
--
-- Why: PayMongo doesn't always send the customer back to the site after
-- a failed GCash payment (its test "Expire" button doesn't, and a real
-- customer can just close the tab), so the cancel-on-return check in
-- site/script.js never runs for them. This job asks create-paymongo-
-- source to check every still-unpaid GCash order with PayMongo and
-- cancel + restock the ones whose payment expired, failed or was
-- cancelled. Orders still waiting for payment are left alone.
--
-- "quick-worker" is create-paymongo-source's real URL slug — same value
-- as PAYMONGO_SOURCE_FUNCTION_SLUG in site/payment-config.js.
--
-- To stop it later: select cron.unschedule('gcash-sweep');
-- =========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-running this file replaces the job instead of adding a second one.
select cron.unschedule('gcash-sweep')
  where exists (select 1 from cron.job where jobname = 'gcash-sweep');

select cron.schedule(
  'gcash-sweep',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://oyujsqzueghivhjgmukn.supabase.co/functions/v1/quick-worker',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('action', 'sweep')
  );
  $$
);
