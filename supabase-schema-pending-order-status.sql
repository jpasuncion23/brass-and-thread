-- =========================================================================
-- Brass & Thread — "Pending" order status (new order queue)
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Adds a new FIRST stage to the fulfillment tracker, before Processing:
--   Pending → Processing → Out for Delivery → Delivered   (or Cancelled)
--
-- Every new online order now lands as "Pending" — meaning it's just been
-- placed and the admin hasn't started prepping it yet. The admin moves it
-- to "Processing" once they actually start working on it. This gives a
-- clear "new, unhandled" signal in the Orders tab, separate from "already
-- being worked on".
--
-- Walk-in sales are unaffected — record_walkin_sale() already sets those
-- straight to "Delivered" since the customer already has the item.
-- =========================================================================

alter table orders alter column order_status set default 'Pending';

alter table orders drop constraint if exists orders_order_status_check;
alter table orders add constraint orders_order_status_check
  check (order_status in ('Pending', 'Processing', 'Out for Delivery', 'Delivered', 'Cancelled'));

-- Existing rows keep whatever stage they're already at — this only
-- changes what NEW orders start as, not any order already in progress.
