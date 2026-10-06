// =========================================================================
// Brass & Thread — PayMongo webhook (confirms GCash payments)
// -------------------------------------------------------------------------
// Deploy this in Supabase Dashboard → Edge Functions → Create function
// (name it exactly "paymongo-webhook") → paste this file's content →
// Deploy, with "Verify JWT" turned OFF (PayMongo calls this directly,
// it has no Supabase session — this function checks PayMongo's own
// signature instead, see verifySignature() below).
//
// Then in the PayMongo Dashboard → Developers → Webhooks → Add endpoint,
// point it at this function's URL (Supabase gives you that URL once
// deployed) and subscribe it to these two events:
//   - source.chargeable
//   - payment.paid
//
// Why two events, not one: GCash (and other e-wallets) go through
// PayMongo's "Source" resource. Once the customer approves the payment
// on PayMongo's page, the Source becomes "chargeable" — that's step 1
// below, where we actually tell PayMongo to charge it. PayMongo then
// confirms the charge went through with a separate "payment.paid"
// event — that's step 2, which is the ONLY place an order actually gets
// marked Paid in our database. Until that second event arrives, nothing
// here claims the order is paid, no matter what the customer's browser
// redirect says — the browser side is just UX, never the source of truth.
//
// Secrets needed (Edge Functions → Manage secrets):
//   PAYMONGO_SECRET_KEY    — same one used by create-paymongo-source
//   PAYMONGO_WEBHOOK_SECRET — from the webhook's own "Signing secret" in
//                             the PayMongo Dashboard (shown after you add
//                             the endpoint, not the same as the API key)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// =========================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PAYMONGO_SECRET_KEY = Deno.env.get("PAYMONGO_SECRET_KEY");
const PAYMONGO_WEBHOOK_SECRET = Deno.env.get("PAYMONGO_WEBHOOK_SECRET");

function paymongoAuthHeader(): string {
  return "Basic " + btoa(`${PAYMONGO_SECRET_KEY}:`);
}

// PayMongo signs each request: "Paymongo-Signature: t=<timestamp>,te=<test
// signature>,li=<live signature>". The signed string is "<timestamp>.<raw
// body>", hashed with HMAC-SHA256 using the webhook's signing secret. We
// don't need to know ahead of time whether this is a test- or live-mode
// event — just accept it if our computed signature matches EITHER te or
// li; an attacker without the secret can't produce a match for either.
async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !PAYMONGO_WEBHOOK_SECRET) return false;

  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k.trim(), v?.trim()];
    })
  );
  const timestamp = parts.t;
  if (!timestamp) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PAYMONGO_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const expected = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expected === parts.te || expected === parts.li;
}

async function getOrderBySourceId(sourceId: string): Promise<any | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?payment_provider_ref=eq.${sourceId}&select=*`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function markOrderPaid(orderId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ payment_status: "Paid" }),
  });
}

async function chargeSource(sourceId: string, amountCentavos: number): Promise<void> {
  const res = await fetch("https://api.paymongo.com/v1/payments", {
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
          source: { id: sourceId, type: "source" },
        },
      },
    }),
  });
  if (!res.ok) {
    console.error("PayMongo charge failed:", await res.text());
  }
}

Deno.serve(async (req: Request) => {
  const rawBody = await req.text();

  const valid = await verifySignature(rawBody, req.headers.get("paymongo-signature"));
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const eventType = event?.data?.attributes?.type;
  const resource = event?.data?.attributes?.data;

  // Step 1: the customer approved the GCash payment — the Source is now
  // chargeable. Tell PayMongo to actually move the money.
  if (eventType === "source.chargeable") {
    const sourceId = resource?.id;
    const amount = resource?.attributes?.amount;
    if (sourceId && amount) {
      const order = await getOrderBySourceId(sourceId);
      if (order && order.payment_status !== "Paid") {
        await chargeSource(sourceId, amount);
      }
    }
    return new Response("ok", { status: 200 });
  }

  // Step 2: PayMongo confirms the charge actually went through — this is
  // the only point where an order is marked Paid.
  if (eventType === "payment.paid") {
    const sourceId = resource?.attributes?.source?.id;
    if (sourceId) {
      const order = await getOrderBySourceId(sourceId);
      if (order && order.payment_status !== "Paid") {
        await markOrderPaid(order.id);
      }
    }
    return new Response("ok", { status: 200 });
  }

  // Anything else (payment.failed, source.cancelled, etc.) — acknowledged,
  // no action needed. The customer can just retry at checkout.
  return new Response("ok", { status: 200 });
});
