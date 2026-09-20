/* =========================================================================
   EDIT ME — no payment API is used here (none needed for COD/GCash/Bank
   Transfer at this scale). Instead, picking a payment method at checkout
   shows the customer a "Complete Your Payment" page with these details —
   fill in your real GCash and bank account info below.

   For the GCash QR code: save the QR image Supabase (or your GCash app's
   "Show QR" screen) gives you into site/images/, then point qrImage at
   that filename, e.g. "images/gcash-qr.jpg". Leave it as null to skip
   showing a QR code and rely on the account number alone.

   Every method in this list shows up as a clickable option at checkout,
   in this order. `manualPayment: false` (like COD) skips the payment
   instructions page entirely and goes straight to the order confirmation.
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
    blurb: "Pay via GCash — you'll see the account and QR code on the next screen.",
    manualPayment: true,
    accountName: "PASTE YOUR GCASH ACCOUNT NAME",
    accountNumber: "09XX XXX XXXX",
    qrImage: null, // e.g. "images/gcash-qr.jpg"
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
