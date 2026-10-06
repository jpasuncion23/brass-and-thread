/* =========================================================================
   EDIT ME — payment methods shown as clickable options at checkout, in
   this order.

   GCash is handled automatically through PayMongo (see
   supabase/functions/create-paymongo-source and supabase-schema-
   paymongo.sql) — picking it redirects the customer to PayMongo's own
   GCash checkout page, and the order is marked Paid the moment PayMongo
   confirms it, no manual confirmation needed. `instantPayment: true`
   marks a method as working this way.

   COD and Bank Transfer still have no payment API behind them —
   `manualPayment: true` shows a "Complete Your Payment" page with the
   account details below (fill in your real bank info). COD
   (`manualPayment: false`) just goes straight to the order confirmation.

   For a bank QR code: save the image into site/images/, then point
   qrImage at that filename, e.g. "images/bank-qr.jpg". Leave it null to
   skip showing a QR code and rely on the account number alone.
   ========================================================================= */

const PAYMENT_METHODS = [
  {
    id: "COD",
    label: "Cash on Delivery (COD)",
    blurb: "Pay in cash when your order arrives.",
    manualPayment: false,
  },
  {
    id: "GCash",
    label: "GCash",
    blurb: "Pay via GCash — you'll be sent to GCash's own checkout to confirm the payment instantly.",
    instantPayment: true,
  },
  {
    id: "Bank Transfer",
    label: "Bank Transfer",
    blurb: "Pay via bank transfer — account details on the next screen.",
    manualPayment: true,
    bankName: "PASTE YOUR BANK NAME",
    accountName: "PASTE YOUR ACCOUNT NAME",
    accountNumber: "PASTE YOUR ACCOUNT NUMBER",
    qrImage: null,
  },
];

/* =========================================================================
   EDIT ME — shown at checkout when the customer picks "Pickup" instead
   of "Delivery", so they know where and when to show up.
   ========================================================================= */
const PICKUP_INFO = {
  address: "NU BALIWAG",
  hours: "(Mon–Sat, 10am–6pm)",
};
