// =========================================================================
// Brass & Thread — Order emails (placed + status changes)
// -------------------------------------------------------------------------
// Deploy this in Supabase Dashboard → Edge Functions → Create function
// (or open the existing one) → paste this file's content → Deploy. Set
// the two secrets it needs (RESEND_API_KEY, WEBHOOK_SECRET) under Edge
// Functions → Manage secrets. See DEPLOY.md for the full step-by-step,
// including the two database triggers that call this.
//
// This function is called by two Postgres triggers (never directly by
// the browser):
//   1. supabase-schema-order-confirmation-trigger.sql — AFTER INSERT on
//      orders. Sends the "we got your order, here's your order number"
//      email the moment someone checks out. Payload: { type:
//      "order_placed", record: <new order row> }.
//   2. supabase-schema-order-email-trigger.sql — AFTER UPDATE on orders,
//      only when order_status actually changed. Sends the "your order
//      is now X" email as it moves through fulfillment. Payload: {
//      record: <new row>, old_record: <previous row> }.
// =========================================================================

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");

// Resend's shared test sender — works out of the box, no domain setup
// needed, and (unlike most providers' sandbox mode) can email anyone.
// Swap this for your own verified domain later if you want a branded
// "from" address.
const FROM_EMAIL = "Brass & Thread <onboarding@resend.dev>";

const STATUS_MESSAGE: Record<string, string> = {
  Processing: "We've got your order and it's being prepared.",
  "Out for Delivery": "Your order is on its way!",
  Delivered: "Your order has been delivered. Enjoy!",
  Cancelled: "Your order has been cancelled.",
};

// Keep this in sync with the payment method list in site/payment-config.js —
// this is only the short reminder line for the email, not the full
// instructions (those live on the page shown right after checkout, so a
// customer who already paid isn't stuck re-reading account numbers here).
const PAYMENT_NOTE: Record<string, string> = {
  COD: "Pay in cash when your order arrives — no need to send anything ahead of time.",
  GCash:
    "Please complete your GCash payment using the account shown on the page right after you ordered, and use your order number below as the reference.",
  "Bank Transfer":
    "Please complete your bank transfer using the account shown on the page right after you ordered, and use your order number below as the reference.",
};

function itemsTableHtml(items: any[]): string {
  return (items || [])
    .map(
      (it) =>
        `<tr><td style="padding: 4px 0;">${it.name} (${it.size}/${it.color}) × ${it.qty}</td><td style="padding: 4px 0; text-align: right;">₱${Number(it.price * it.qty).toLocaleString("en-PH")}</td></tr>`
    )
    .join("");
}

function orderPlacedHtml(order: any): string {
  const note = PAYMENT_NOTE[order.payment_method] || "";
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #241a10;">
      <h2 style="color: #c1432a; margin-bottom: 4px;">Brass &amp; Thread</h2>
      <p>Hi ${order.full_name || "there"},</p>
      <p style="font-size: 16px;">Thanks for your order! We've got it and we're on it.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 0; color: #6b6355;">Order number</td><td style="padding: 4px 0; text-align: right;"><strong style="font-size: 15px;">${order.order_code}</strong></td></tr>
      </table>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border-top: 1px solid #e2d8c4; border-bottom: 1px solid #e2d8c4;">
        ${itemsTableHtml(order.items)}
        <tr><td style="padding: 8px 0 4px; font-weight: bold;">Total</td><td style="padding: 8px 0 4px; text-align: right; font-weight: bold;">₱${Number(order.total).toLocaleString("en-PH")}</td></tr>
      </table>
      <table style="width: 100%; border-collapse: collapse; margin: 8px 0 16px;">
        <tr><td style="padding: 4px 0; color: #6b6355;">Payment method</td><td style="padding: 4px 0; text-align: right;"><strong>${order.payment_method}</strong></td></tr>
      </table>
      ${note ? `<p style="font-size: 14px;">${note}</p>` : ""}
      <p style="color: #6b6355; font-size: 13px;">
        Save your order number — you can look up your order anytime on the
        site using "Track Order" plus the contact number or email you gave
        at checkout.
      </p>
      <p style="color: #6b6355; font-size: 13px;">Questions about your order? Reply to this email or message us using the contact number you left at checkout.</p>
    </div>
  `;
}

function statusChangedHtml(order: any, message: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #241a10;">
      <h2 style="color: #c1432a; margin-bottom: 4px;">Brass &amp; Thread</h2>
      <p>Hi ${order.full_name || "there"},</p>
      <p style="font-size: 16px;">${message}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 0; color: #6b6355;">Order</td><td style="padding: 4px 0; text-align: right;"><strong>${order.order_code}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b6355;">Status</td><td style="padding: 4px 0; text-align: right;"><strong>${order.order_status}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b6355;">Payment</td><td style="padding: 4px 0; text-align: right;"><strong>${order.payment_status}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b6355;">Total</td><td style="padding: 4px 0; text-align: right;"><strong>₱${Number(order.total).toLocaleString("en-PH")}</strong></td></tr>
      </table>
      <p style="color: #6b6355; font-size: 13px;">Questions about your order? Reply to this email or message us using the contact number you left at checkout.</p>
    </div>
  `;
}

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Resend error:", errText);
    return new Response(errText, { status: 502 });
  }
  return new Response("sent", { status: 200 });
}

Deno.serve(async (req: Request) => {
  // Shared-secret check instead of Supabase's own JWT verification —
  // this function should be deployed with "Verify JWT" turned OFF,
  // since the triggers calling it aren't a logged-in browser session.
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: { type?: string; record?: any; old_record?: any };
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const order = payload.record;
  if (!order) {
    return new Response("Bad payload", { status: 400 });
  }
  if (!order.email) {
    return new Response("Order has no email on file", { status: 200 });
  }

  // ----- Order just placed (AFTER INSERT trigger) -----
  if (payload.type === "order_placed") {
    return sendEmail(order.email, `Order ${order.order_code} received — thank you!`, orderPlacedHtml(order));
  }

  // ----- Fulfillment status changed (AFTER UPDATE trigger) -----
  const previous = payload.old_record;
  if (!previous || order.order_status === previous.order_status) {
    return new Response("No status change — nothing to send", { status: 200 });
  }

  const message = STATUS_MESSAGE[order.order_status] || `Your order status is now: ${order.order_status}`;
  return sendEmail(order.email, `Order ${order.order_code} — ${order.order_status}`, statusChangedHtml(order, message));
});
