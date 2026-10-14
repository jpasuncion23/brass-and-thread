/* =========================================================================
   ShopTrack — Driver Portal (Supabase-backed)
   ---------------------------------------------------------------------
   Separate account type from admin and customer — see
   supabase-schema-delivery-drivers.sql and
   supabase-schema-driver-all-deliveries.sql. A driver sees every order
   that's "Out for Delivery" (via get_driver_orders()), regardless of
   payment method, and can flip exactly one to Delivered:
     - COD → "Mark Paid & Delivered" (mark_cod_paid_delivered — sets
       payment_status AND order_status, since the driver is the one
       collecting the cash)
     - anything else (already paid online, or the admin is confirming
       payment separately) → "Mark Delivered" (mark_delivered — order
       status only, payment is not the driver's call)
   Both are enforced server-side, not just hidden in this UI.

   Since supabase-schema-delivery-proof-photo.sql, both also now REQUIRE
   a proof-of-delivery photo first (the product plus the recipient's
   face) — the database rejects the call without one, so this isn't
   just a UI nicety. The photo uploads to a private "delivery-proofs"
   Storage bucket that only the admin can later view.
   ========================================================================= */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function peso(n) {
  return "₱" + Number(n).toLocaleString("en-PH");
}

// No login form here — you log in from the storefront ("Log In" in the
// navbar); get_my_role() there sends driver accounts to this page. On
// load, this just checks: is there a session, and is it actually a
// driver? If not, back to the storefront to log in.
function goToLogin() {
  window.location.href = "/";
}

async function handleLogout() {
  try {
    await sb.auth.signOut();
  } catch (err) {
    console.error("Sign out error:", err);
  }
  goToLogin();
}

async function showApp() {
  const { data, error } = await sb.rpc("get_driver_orders");

  if (error) {
    // Not registered in the `drivers` table — not a driver account.
    await sb.auth.signOut();
    goToLogin();
    return;
  }

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("driverApp").classList.remove("hidden");
  renderOrders(data || []);
}

async function refreshOrders() {
  const { data, error } = await sb.rpc("get_driver_orders");
  if (error) return;
  renderOrders(data || []);
}

function renderOrders(orders) {
  const list = document.getElementById("orderList");
  const empty = document.getElementById("emptyState");

  if (orders.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = orders
    .map((o) => {
      const items = o.items.map((it) => `${it.name} (${it.size}/${it.color}) ×${it.qty}`).join(", ");
      const isCod = o.payment_method === "COD";
      const buttonLabel = isCod ? "Take Photo &amp; Mark Paid &amp; Delivered" : "Take Photo &amp; Mark Delivered";
      const paymentNote = isCod
        ? "Collect payment on drop-off"
        : `${o.payment_method} — ${o.payment_status}`;
      return `
        <div class="order-card">
          <div class="order-card-top">
            <span class="order-code">${o.order_code}</span>
            <span class="order-total">${peso(o.total)}</span>
          </div>
          <p class="order-customer">${o.full_name}</p>
          <p class="order-contact">📞 ${o.contact_number || "—"}</p>
          <p class="order-address">${o.address || "No address on file — contact the customer."}</p>
          <p class="order-items">${items}</p>
          <p class="order-payment-note">${paymentNote}</p>
          <p class="order-proof-note">📷 Photo required: the product together with the recipient's face.</p>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="proof-photo-input hidden"
            data-id="${o.id}"
            data-code="${o.order_code}"
            data-cod="${isCod}"
          />
          <button
            type="button"
            class="btn btn-primary btn-full order-mark-btn"
            data-id="${o.id}"
          >
            ${buttonLabel}
          </button>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".order-mark-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      list.querySelector(`.proof-photo-input[data-id="${btn.dataset.id}"]`).click();
    });
  });

  list.querySelectorAll(".proof-photo-input").forEach((input) => {
    input.addEventListener("change", () => handlePhotoSelected(input));
  });
}

async function handlePhotoSelected(input) {
  const file = input.files[0];
  input.value = ""; // reset so picking the same file again still fires "change"
  if (!file) return;

  const id = input.dataset.id;
  const code = input.dataset.code;
  const isCod = input.dataset.cod === "true";
  const btn = document.querySelector(`.order-mark-btn[data-id="${id}"]`);
  const originalLabel = btn.innerHTML;

  const confirmMessage = isCod
    ? `Confirm: you collected payment for order ${code}, and this photo shows the product with the recipient?`
    : `Confirm: order ${code} was delivered, and this photo shows the product with the recipient?`;
  if (!confirm(confirmMessage)) return;

  btn.disabled = true;
  btn.textContent = "Uploading photo…";

  const path = `${id}-${Date.now()}.jpg`;
  const { error: uploadError } = await sb.storage
    .from("delivery-proofs")
    .upload(path, file, { contentType: file.type || "image/jpeg" });

  if (uploadError) {
    alert("Couldn't upload the photo — please try again. (" + uploadError.message + ")");
    btn.disabled = false;
    btn.innerHTML = originalLabel;
    return;
  }

  btn.textContent = "Saving…";

  const { error } = isCod
    ? await sb.rpc("mark_cod_paid_delivered", { p_order_id: id, p_delivery_proof_path: path })
    : await sb.rpc("mark_delivered", { p_order_id: id, p_delivery_proof_path: path });

  if (error) {
    alert("Couldn't update this order — please try again. (" + error.message + ")");
    btn.disabled = false;
    btn.innerHTML = originalLabel;
    return;
  }

  await refreshOrders();
}

function subscribeRealtime() {
  sb.channel("driver-orders")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, refreshOrders)
    .subscribe();
}

document.addEventListener("DOMContentLoaded", async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    await showApp();
  } else {
    goToLogin();
    return;
  }
  subscribeRealtime();

  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
});
