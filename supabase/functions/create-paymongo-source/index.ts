// =========================================================================
// Brass & Thread — Start a GCash payment via PayMongo
// -------------------------------------------------------------------------
// Deploy this in Supabase Dashboard → Edge Functions → Create function
// (name it exactly "create-paymongo-source") → paste this file's content
// → Deploy, with "Verify JWT" turned OFF (the storefront calls this
// directly with the anon key, before the customer has any session).
//
// Called by the browser (site/script.js) right after place_order()
// creates a GCash order. It asks PayMongo for a "Source" — the resource
// behind a GCash checkout link — and returns that link so the browser
// can redirect the customer there to actually authorize the payment.
//
// This function never marks an order Paid itself — that only happens in
// supabase/functions/paymongo-webhook/index.ts, once PayMongo confirms
// the money actually moved. All this does is start the process and
// remember which PayMongo Source belongs to which order
// (payment_provider_ref), so the webhook can find its way back here.
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
const PAYMONGO_SECRET_KEY = Deno.env.get("PAYMONGO_SECRET_KEY");
const SITE_URL = Deno.env.get("SITE_URL");

// GCash via PayMongo needs at least ₱100 per order (PayMongo's own
// minimum for Sources — 10000 centavos). Anything smaller, point the
// customer at COD/Bank Transfer instead.
const MIN_AMOUNT_CENTAVOS = 10000;

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

async function getOrder(orderId: string): Promise<any | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*`, {
    headers: {
      apikey: SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function saveSourceRef(orderId: string, sourceId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ payment_provider_ref: sourceId }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Bad request" }, 400);
  }

  const orderId = body.order_id;
  if (!orderId) {
    return jsonResponse({ error: "order_id is required" }, 400);
  }

  const order = await getOrder(orderId);
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

  const successUrl = `${SITE_URL}/?paymongo=success&order=${encodeURIComponent(order.order_code)}`;
  const failedUrl = `${SITE_URL}/?paymongo=failed&order=${encodeURIComponent(order.order_code)}`;

  const pmRes = await fetch("https://api.paymongo.com/v1/sources", {
    method: "POST",
    headers: {
      Authorization: paymongoAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        attributes: {
          amount: amountCentavos,
          currency: "PHP",
          type: "gcash",
          redirect: { success: successUrl, failed: failedUrl },
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
    const errText = await pmRes.text();
    console.error("PayMongo source creation failed:", errText);
    return jsonResponse({ error: "Couldn't start GCash payment — please try again." }, 502);
  }

  const pmData = await pmRes.json();
  const source = pmData.data;
  const checkoutUrl = source?.attributes?.redirect?.checkout_url;

  if (!checkoutUrl) {
    console.error("PayMongo response missing checkout_url:", JSON.stringify(pmData));
    return jsonResponse({ error: "Couldn't start GCash payment — please try again." }, 502);
  }

  await saveSourceRef(orderId, source.id);

  return jsonResponse({ checkout_url: checkoutUrl });
});
