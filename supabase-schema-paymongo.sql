-- =========================================================================
-- Brass & Thread — PayMongo (automatic GCash payment)
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Adds one column: payment_provider_ref, which stores the id of the
-- PayMongo "Source" created for a GCash order. That id is how the
-- paymongo-webhook Edge Function matches an incoming PayMongo event
-- back to the right order — it's set once, right after the order is
-- placed and a Source is created (see
-- supabase/functions/create-paymongo-source/index.ts), and read once
-- the customer finishes paying on PayMongo's page and PayMongo calls
-- our webhook.
--
-- No RLS/policy changes needed here — both Edge Functions that touch
-- this talk to the database with the service role key (set as an
-- automatic secret inside every Edge Function), which already bypasses
-- RLS, the same way the database triggers in this project always have.
-- =========================================================================

alter table orders add column if not exists payment_provider_ref text;

create index if not exists orders_payment_provider_ref_idx
  on orders (payment_provider_ref)
  where payment_provider_ref is not null;
