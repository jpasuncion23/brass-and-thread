// =========================================================================
// Brass & Thread — Start a GCash payment via PayMongo Checkout
// -------------------------------------------------------------------------
// Deploy this in Supabase Dashboard → Edge Functions → Create function
// (name it exactly "create-paymongo-source") → paste this file's content
// → Deploy, with "Verify JWT" turned OFF (the storefront calls this
// directly with the anon key, before the customer has any session).
//
// Called by the browser (site/script.js) right after place_order()
// creates a GCash order. It creates a PayMongo Checkout Session and
// returns its link so the browser can send the customer there to pay.
// Unlike the older "Source" flow, PayMongo's hosted checkout always has
// a way back to the site (cancel_url), so a customer who backs out lands
// on our page instead of being stranded on PayMongo's.
//
// This function never marks an order Paid itself — that only happens in
// supabase/functions/paymongo-webhook/index.ts, once PayMongo confirms
// the money actually moved. All this does is start the process and
// remember which Checkout Session belongs to which order
// (payment_provider_ref), so the webhook can find its way back here.
//
// Other jobs (all need supabase-schema-gcash-auto-cancel.sql):
//   { action: "cancel_checkout", order_id } — the customer came back via
//     cancel_url. Expires the session and cancels + restocks the order,
//     unless PayMongo says it was actually paid.
//   { action: "cancel_if_failed", order_code } — same idea for orders
//     still on the older Source flow (payment_provider_ref "src_...").
//   { action: "sweep" } — run every 10 minutes by
//     supabase-schema-gcash-sweep.sql: cancels every unpaid GCash order
//     whose payment PayMongo says is dead, or that's been abandoned for
//     over an hour (the customer closed the tab).
//
// Secrets needed (Edge Functions → Manage secrets):
//   PAYMONGO_SECRET_KEY — from PayMongo Dashboard → Developers → API Keys
//   SITE_URL            — your live site, e.g. https://yoursite.netlify.app
//                          (no trailing slash)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically
// by Supabase — no need to set those yourself.
// =========================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PAYMONGO_SECRET_KEY = Deno.env.get("PAYMONGO_SECRET_KEY")?.trim();
// Keep only the origin + path: a pasted "#shop" or "?x" or trailing "/"
// would otherwise swallow the ?paymongo=... query we append below, and
// the storefront would never show its payment-result popup.
const SITE_URL = Deno.env.get("SITE_URL")?.trim().replace(/[#?].*$/, "").replace(/\/+$/, "");

// GCash via PayMongo needs at least ₱100 per order (10000 centavos).
// Anything smaller, point the customer at COD/Bank Transfer instead.
const MIN_AMOUNT_CENTAVOS = 10000;

// A checkout nobody has paid for after this long is treated as
// abandoned by the sweep — its session is expired and the stock freed.
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function paymongoAuthHeader(): string {
  return "Basic " + btoa(`${PAYMONGO_SECRET_KEY}:`);
}

const DB_HEADERS = {
  apikey: SERVICE_ROLE_KEY!,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
};

async function findOrder(filter: string): Promise<any | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}&select=*`, { headers: DB_HEADERS });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function saveProviderRef(orderId: string, ref: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: { ...DB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ payment_provider_ref: ref }),
  });
}

// Cancels + restocks via supabase-schema-gcash-auto-cancel.sql — a no-op
// unless the order is still unpaid and untouched. Returns whether the
// order ended up Cancelled.
async function cancelUnpaidOrder(order: any, reason: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cancel_unpaid_order`, {
    method: "POST",
    headers: { ...DB_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ p_order_id: order.id }),
  });
  if (!res.ok) {
    console.error("cancel_unpaid_order failed:", res.status, await res.text());
    return false;
  }
  const updated = await res.json();
  console.log(`Cancelled ${order.order_code} — ${reason}`);
  return updated?.order_status === "Cancelled";
}

function isOpenGcashOrder(order: any): boolean {
  return (
    order?.payment_method === "GCash" &&
    order.payment_status === "Pending" &&
    order.order_status === "Pending" &&
    !!order.payment_provider_ref
  );
}

// ----- Checkout Sessions ("cs_...") -------------------------------------

async function getCheckoutSession(id: string): Promise<any | null> {
  const res = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${id}`, {
    headers: { Authorization: paymongoAuthHeader() },
  });
  if (!res.ok) {
    console.error("PayMongo checkout lookup failed:", await res.text());
    return null;
  }
  return (await res.json())?.data ?? null;
}

function checkoutWasPaid(session: any): boolean {
  const payments = session?.attributes?.payments || [];
  return payments.some((p: any) => p?.attributes?.status === "paid");
}

// Expire the session first so the customer can't still pay on it after
// we've cancelled the order. Only cancel if PayMongo confirms nothing
// was paid and the session is (now) expired.
async function cancelCheckoutIfUnpaid(order: any, force: boolean): Promise<boolean> {
  const session = await getCheckoutSession(order.payment_provider_ref);
  if (!session || checkoutWasPaid(session)) return false;

  let status = session.attributes?.status;
  if (status === "active") {
    const createdAt = new Date(order.created_at).getTime();
    if (!force && Date.now() - createdAt < ABANDONED_AFTER_MS) return false;

    const res = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${session.id}/expire`, {
      method: "POST",
      headers: { Authorization: paymongoAuthHeader() },
    });
    if (!res.ok) {
      // Most likely it got paid in the meantime — leave it to the webhook.
      console.error("PayMongo checkout expire failed:", await res.text());
      return false;
    }
    status = "expired";
  }

  if (status !== "expired") return false;
  return cancelUnpaidOrder(order, force ? "customer cancelled checkout" : "checkout abandoned");
}

// ----- Sources ("src_...") — orders placed before the Checkout switch --

const DEAD_SOURCE_STATUSES = ["cancelled", "expired", "failed"];

async function cancelSourceIfDead(order: any): Promise<boolean> {
  const res = await fetch(`https://api.paymongo.com/v1/sources/${order.payment_provider_ref}`, {
    headers: { Authorization: paymongoAuthHeader() },
  });
  if (!res.ok) {
    console.error("PayMongo source lookup failed:", await res.text());
    return false;
  }
  const status = (await res.json())?.data?.attributes?.status;
  if (!DEAD_SOURCE_STATUSES.includes(status)) return false;
  return cancelUnpaidOrder(order, `PayMongo source is "${status}"`);
}

// ----- Actions -----------------------------------------------------------

// The customer came back via cancel_url. The URL carries the order's
// UUID (never shown anywhere else), not just its public order code, so a
// stranger can't cancel someone else's order by typing a URL — and even
// then, PayMongo has to confirm nothing was paid.
async function handleCancelCheckout(orderId: string): Promise<Response> {
  const order = await findOrder(`id=eq.${encodeURIComponent(orderId)}`);
  if (order?.order_status === "Cancelled") {
    return jsonResponse({ cancelled: true });
  }
  if (!isOpenGcashOrder(order) || !order.payment_provider_ref.startsWith("cs_")) {
    return jsonResponse({ cancelled: false });
  }
  return jsonResponse({ cancelled: await cancelCheckoutIfUnpaid(order, true) });
}

async function handleCancelIfFailed(orderCode: string): Promise<Response> {
  const order = await findOrder(`order_code=eq.${encodeURIComponent(orderCode)}`);
  if (order?.order_status === "Cancelled") {
    return jsonResponse({ cancelled: true });
  }
  if (!isOpenGcashOrder(order) || !order.payment_provider_ref.startsWith("src_")) {
    return jsonResponse({ cancelled: false });
  }
  return jsonResponse({ cancelled: await cancelSourceIfDead(order) });
}

// PayMongo doesn't always bring the customer back (they can just close
// the tab), so this catches every unpaid GCash order whose payment is
// dead or abandoned, and frees up its stock.
async function handleSweep(): Promise<Response> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?payment_method=eq.GCash&payment_status=eq.Pending` +
      `&order_status=eq.Pending&payment_provider_ref=not.is.null&select=*&order=created_at.asc&limit=50`,
    { headers: DB_HEADERS }
  );
  if (!res.ok) {
    console.error("Sweep order lookup failed:", res.status, await res.text());
    return jsonResponse({ error: "lookup failed" }, 500);
  }

  const orders = await res.json();
  let cancelled = 0;
  for (const order of orders) {
    const done = order.payment_provider_ref.startsWith("cs_")
      ? await cancelCheckoutIfUnpaid(order, false)
      : await cancelSourceIfDead(order);
    if (done) cancelled++;
  }
  return jsonResponse({ checked: orders.length, cancelled });
}

async function handleCreateCheckout(orderId: string): Promise<Response> {
  const order = await findOrder(`id=eq.${encodeURIComponent(orderId)}`);
  if (!order) {
    return jsonResponse({ error: "Order not found" }, 404);
  }
  if (order.payment_method !== "GCash") {
    return jsonResponse({ error: "This order isn't a GCash order" }, 400);
  }
  if (order.payment_status === "Paid") {
    return jsonResponse({ error: "This order is already paid" }, 400);
  }

  const amountCentavos = Math.round(Number(order.total) * 100);
  if (amountCentavos < MIN_AMOUNT_CENTAVOS) {
    return jsonResponse(
      { error: "GCash payments need a minimum order total of ₱100. Please choose Cash on Delivery or Bank Transfer instead." },
      400
    );
  }

  const code = encodeURIComponent(order.order_code);
  const successUrl = `${SITE_URL}/?paymongo=success&order=${code}`;
  const cancelUrl = `${SITE_URL}/?paymongo=cancelled&order=${code}&ref=${order.id}`;

  // One line item for the whole order, so the amount PayMongo charges is
  // always exactly order.total — the item names go in the description.
  const itemSummary = (order.items || [])
    .map((it: any) => `${it.name} (${it.size}/${it.color}) ×${it.qty}`)
    .join(", ");

  const pmRes = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      Authorization: paymongoAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: [
            { name: `Brass & Thread order ${order.order_code}`, amount: amountCentavos, currency: "PHP", quantity: 1 },
          ],
          payment_method_types: ["gcash"],
          success_url: successUrl,
          cancel_url: cancelUrl,
          reference_number: order.order_code,
          description: itemSummary || `Order ${order.order_code}`,
          show_description: true,
          show_line_items: true,
          send_email_receipt: false,
          billing: {
            name: order.full_name || undefined,
            email: order.email || undefined,
            phone: order.contact_number || undefined,
          },
        },
      },
    }),
  });

  if (!pmRes.ok) {
    console.error("PayMongo checkout creation failed:", await pmRes.text());
    return jsonResponse({ error: "Couldn't start GCash payment — please try again." }, 502);
  }

  const session = (await pmRes.json())?.data;
  const checkoutUrl = session?.attributes?.checkout_url;
  if (!checkoutUrl) {
    console.error("PayMongo response missing checkout_url:", JSON.stringify(session));
    return jsonResponse({ error: "Couldn't start GCash payment — please try again." }, 502);
  }

  await saveProviderRef(order.id, session.id);
  return jsonResponse({ checkout_url: checkoutUrl });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  let body: { order_id?: string; action?: string; order_code?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Bad request" }, 400);
  }

  if (body.action === "sweep") {
    return handleSweep();
  }
  if (body.action === "cancel_checkout") {
    if (!body.order_id) return jsonResponse({ error: "order_id is required" }, 400);
    return handleCancelCheckout(body.order_id);
  }
  if (body.action === "cancel_if_failed") {
    if (!body.order_code) return jsonResponse({ error: "order_code is required" }, 400);
    return handleCancelIfFailed(body.order_code);
  }

  if (!body.order_id) {
    return jsonResponse({ error: "order_id is required" }, 400);
  }
  return handleCreateCheckout(body.order_id);
});
