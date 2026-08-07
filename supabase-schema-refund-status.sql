-- =========================================================================
-- Brass & Thread — Refund tracking for cancelled-but-paid orders
-- ---------------------------------------------------------------------
-- RUN THIS in Supabase → SQL Editor → New query → Run.
--
-- Adds "Refunded" as a valid payment_status. An order that was already
-- Paid (usually GCash) and then gets Cancelled needs the admin to
-- physically send the money back — the admin dashboard now shows a
-- "Needs Refund" badge for that case, which the admin clicks once the
-- refund is actually sent, marking it "Refunded".
-- =========================================================================

alter table orders drop constraint if exists orders_payment_status_check;
alter table orders add constraint orders_payment_status_check
  check (payment_status in ('Pending', 'Paid', 'Refunded'));
