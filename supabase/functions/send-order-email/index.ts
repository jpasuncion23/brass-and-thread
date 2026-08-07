// =========================================================================
// Brass & Thread — Order status email notifications
// -------------------------------------------------------------------------
// Deploy this in Supabase Dashboard → Edge Functions → Create function
// (name it exactly "send-order-email") → paste this file's content →
// Deploy. Set the two secrets it needs (RESEND_API_KEY, WEBHOOK_SECRET)
// under Edge Functions → Manage secrets. See DEPLOY.md for the full
// step-by-step, including the database trigger that calls this.
//
// This function is called by a Postgres trigger (not by the browser)
// whenever an order's order_status changes. It emails the customer
// whatever the new stage is — Processing, Out for Delivery, Delivered,
// or Cancelled.
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

Deno.serve(async (req: Request) => {
  // Shared-secret check instead of Supabase's own JWT verification —
  // this function should be deployed with "Verify JWT" turned OFF,
  // since the trigger calling it isn't a logged-in browser session.
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: { record?: any; old_record?: any };
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const order = payload.record;
  const previous = payload.old_record;

  if (!order || !previous || order.order_status === previous.order_status) {
    return new Response("No status change — nothing to send", { status: 200 });
  }

  if (!order.email) {
    return new Response("Order has no email on file", { status: 200 });
  }

  const message = STATUS_MESSAGE[order.order_status] || `Your order status is now: ${order.order_status}`;
  const subject = `Order ${order.order_code} — ${order.order_status}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #241a10;">
      <h2 style="color: #c1432a; margin-bottom: 4px;">Brass &amp; Thread</h2>
      <p>Hi ${order.full_name || "there"},</p>
      <p style="font-size: 16px;">${message}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 4px 0; color: #6b6355;">Order</td><td style="padding: 4px 0; text-align: right;"><strong>${order.order_code}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b6355;">Status</td><td style="padding: 4px 0; text-align: right;"><strong>${order.order_status}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b6355;">Total</td><td style="padding: 4px 0; text-align: right;"><strong>₱${Number(order.total).toLocaleString("en-PH")}</strong></td></tr>
      </table>
      <p style="color: #6b6355; font-size: 13px;">Questions about your order? Reply to this email or message us using the contact number you left at checkout.</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: order.email,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Resend error:", errText);
    return new Response(errText, { status: 502 });
  }

  return new Response("sent", { status: 200 });
});
