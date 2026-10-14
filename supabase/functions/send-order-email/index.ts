// =========================================================================
// Brass & Thread — Order emails (placed + status changes)
// -------------------------------------------------------------------------
// Deploy this in Supabase Dashboard → Edge Functions → Create function
// (or open the existing one) → paste this file's content → Deploy. Set
// its secrets under Edge Functions → Manage secrets: WEBHOOK_SECRET, plus
// one way to send, tried in this order: GMAIL_USER + GMAIL_APP_PASSWORD
// (the shop's own Gmail), BREVO_API_KEY + SENDER_EMAIL, or
// RESEND_API_KEY (test sender — only reaches the Resend account owner).
// See DEPLOY.md for the two database triggers that call this.
//
// This function is called by two Postgres triggers (never directly by
// the browser):
//   1. supabase-schema-order-confirmation-trigger.sql — AFTER INSERT on
//      orders. Sends the "we got your order, here's your order number"
//      email the moment someone checks out. Payload: { type:
//      "order_placed", record: <new order row> }.
//   2. supabase-schema-order-email-trigger.sql — AFTER UPDATE on orders,
//      when order_status or payment_status changed (the payment_status
//      part comes from supabase-schema-gcash-auto-cancel.sql). Sends the
//      "your order is now X" email as it moves through fulfillment, or a
//      "payment received" email when a GCash / Bank Transfer order gets
//      marked Paid. Payload: { record: <new row>, old_record: <previous
//      row> }.
// =========================================================================

import nodemailer from "npm:nodemailer@6.9.16";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");

// Gmail SMTP — the same thing PHPMailer does: send straight from the
// shop's own Gmail, so mail lands like any normal Gmail message. Used
// first whenever both secrets are set:
//   GMAIL_USER         — the Gmail address, e.g. brassthread@gmail.com
//   GMAIL_APP_PASSWORD — myaccount.google.com/apppasswords (16 letters;
//                        needs 2-Step Verification on). Not the normal
//                        Gmail password.
// Port 465 (implicit TLS) — Supabase blocks outgoing 25 and 587.
const GMAIL_USER = Deno.env.get("GMAIL_USER")?.trim();
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")?.replace(/\s+/g, "");

// Brevo (brevo.com) — used when Gmail isn't set up but both of these
// are. Brevo can send to any customer from a single verified sender
// address (e.g. the shop's Gmail), no domain of our own needed:
//   BREVO_API_KEY — Brevo → SMTP & API → API Keys
//   SENDER_EMAIL  — the address verified under Brevo → Senders
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY")?.trim();
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL")?.trim();
const SENDER_NAME = "Brass & Thread";

// Resend's shared test sender — the fallback when neither is set up.
// Works with no domain setup, but Resend only delivers mail from it to
// the Resend account owner's own address, never to other customers.
const FROM_EMAIL = `${SENDER_NAME} <onboarding@resend.dev>`;

const STATUS_MESSAGE: Record<string, string> = {
  Processing: "We've got your order and it's being prepared.",
  "Out for Delivery": "Your order is on its way!",
  Delivered: "Your order has been delivered. Enjoy!",
  Cancelled: "Your order has been cancelled.",
};

// The database always stores "Out for Delivery"/"Delivered" regardless
// of fulfillment method — these just pick the wording that actually
// matches a Pickup order, where no rider is ever involved.
function statusLabel(status: string, fulfillmentMethod: string): string {
  if (status === "Out for Delivery" && fulfillmentMethod === "Pickup") return "Ready for Pickup";
  return status;
}

function statusMessage(status: string, fulfillmentMethod: string): string {
  if (status === "Out for Delivery" && fulfillmentMethod === "Pickup") {
    return "Your order is ready for pickup!";
  }
  return STATUS_MESSAGE[status] || `Your order status is now: ${status}`;
}

// Keep this in sync with the payment method list in site/payment-config.js —
// this is only the short reminder line for the email, not the full
// instructions (those live on the page shown right after checkout, so a
// customer who already paid isn't stuck re-reading account numbers here).
const PAYMENT_NOTE: Record<string, string> = {
  COD: "Pay in cash when your order arrives — no need to send anything ahead of time.",
  GCash:
    "If you finished paying on the GCash checkout page, you're all set — we'll email you once the payment is confirmed. If it didn't go through, message us and we'll help you complete it.",
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
        <tr><td style="padding: 4px 0; color: #6b6355;">Delivery or pickup</td><td style="padding: 4px 0; text-align: right;"><strong>${order.fulfillment_method || "Delivery"}</strong></td></tr>
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
        <tr><td style="padding: 4px 0; color: #6b6355;">Status</td><td style="padding: 4px 0; text-align: right;"><strong>${statusLabel(order.order_status, order.fulfillment_method)}</strong></td></tr>
        <tr><td style="padding: 4px 0; color: #6b6355;">Payment</td><td style="padding: 4px 0; text-align: right;"><strong>${order.payment_status}</strong></td></tr>
      </table>
      <table style="width: 100%; border-collapse: collapse; margin: 0 0 16px; border-top: 1px solid #e2d8c4; border-bottom: 1px solid #e2d8c4;">
        ${itemsTableHtml(order.items)}
        <tr><td style="padding: 8px 0 4px; font-weight: bold;">Total</td><td style="padding: 8px 0 4px; text-align: right; font-weight: bold;">₱${Number(order.total).toLocaleString("en-PH")}</td></tr>
      </table>
      <p style="color: #6b6355; font-size: 13px;">Questions about your order? Reply to this email or message us using the contact number you left at checkout.</p>
    </div>
  `;
}

async function sendEmail(to: string, subject: string, html: string) {
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const transport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      });
      await transport.sendMail({ from: `"${SENDER_NAME}" <${GMAIL_USER}>`, to, subject, html });
    } catch (err) {
      console.error("Gmail SMTP error:", err instanceof Error ? err.message : err);
      return new Response("Gmail SMTP error", { status: 502 });
    }
    console.log("Email sent via Gmail:", subject);
    return new Response("sent", { status: 200 });
  }

  if (BREVO_API_KEY && SENDER_EMAIL) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email: to }],
        replyTo: { email: SENDER_EMAIL },
        subject,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Brevo error:", errText);
      return new Response(errText, { status: 502 });
    }
    console.log("Email sent via Brevo:", subject);
    return new Response("sent", { status: 200 });
  }

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
  console.log("Email sent via Resend (test sender — only reaches the Resend account owner):", subject);
  return new Response("sent", { status: 200 });
}

Deno.serve(async (req: Request) => {
  // Shared-secret check instead of Supabase's own JWT verification —
  // this function should be deployed with "Verify JWT" turned OFF,
  // since the triggers calling it aren't a logged-in browser session.
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    console.error("Unauthorized — x-webhook-secret doesn't match the WEBHOOK_SECRET secret");
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
    console.log(`Skipped ${order.order_code} — no email on file`);
    return new Response("Order has no email on file", { status: 200 });
  }
  console.log(
    `Email for ${order.order_code} via ${GMAIL_USER && GMAIL_APP_PASSWORD ? "Gmail" : BREVO_API_KEY && SENDER_EMAIL ? "Brevo" : "Resend"}`
  );

  // ----- Order just placed (AFTER INSERT trigger) -----
  if (payload.type === "order_placed") {
    return sendEmail(order.email, `Order ${order.order_code} received — thank you!`, orderPlacedHtml(order));
  }

  const previous = payload.old_record;
  if (!previous) {
    return new Response("Bad payload", { status: 400 });
  }

  // ----- Payment confirmed (AFTER UPDATE trigger, payment_status) -----
  // COD gets marked Paid together with Delivered, and that Delivered
  // email already covers it — so only GCash / Bank Transfer get this,
  // and only when fulfillment didn't change in the same update.
  if (order.order_status === previous.order_status) {
    const justPaid = order.payment_status === "Paid" && previous.payment_status !== "Paid";
    if (!justPaid || order.payment_method === "COD") {
      console.log(`Skipped ${order.order_code} — no status change worth emailing`);
      return new Response("No status change — nothing to send", { status: 200 });
    }
    return sendEmail(
      order.email,
      `Order ${order.order_code} — Payment received`,
      statusChangedHtml(order, `We've received your ${order.payment_method} payment — thank you! We'll start preparing your order.`)
    );
  }

  // ----- Fulfillment status changed (AFTER UPDATE trigger) -----

  // Pickup has no multi-day transit to narrate — skip the in-between
  // stage emails (Processing, Ready for Pickup) and only email once it's
  // actually done (Delivered/picked up) or Cancelled. Delivery keeps
  // every stage, since that's the whole point of tracking it.
  const isPickup = order.fulfillment_method === "Pickup";
  const isIntermediateStage = order.order_status === "Processing" || order.order_status === "Out for Delivery";
  if (isPickup && isIntermediateStage) {
    console.log(`Skipped ${order.order_code} — Pickup orders only get Delivered/Cancelled emails`);
    return new Response("Pickup order — skipping intermediate stage email", { status: 200 });
  }

  // An unpaid GCash order getting Cancelled almost always means the
  // payment never went through (cancel_unpaid_order) — say so, instead
  // of a bare "cancelled".
  const gcashUnpaid =
    order.order_status === "Cancelled" && order.payment_method === "GCash" && order.payment_status === "Pending";
  const message = gcashUnpaid
    ? "Your GCash payment wasn't completed, so this order has been cancelled and the items released. You're welcome to order again anytime."
    : statusMessage(order.order_status, order.fulfillment_method);
  const label = statusLabel(order.order_status, order.fulfillment_method);
  return sendEmail(order.email, `Order ${order.order_code} — ${label}`, statusChangedHtml(order, message));
});
