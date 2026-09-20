/* =========================================================================
   ShopTrack — Driver Portal (Supabase-backed)
   ---------------------------------------------------------------------
   Separate account type from admin and customer — see
   supabase-schema-delivery-drivers.sql. A driver can only ever see COD
   orders that are "Out for Delivery" (via get_driver_orders()) and can
   only flip one of those to Paid + Delivered (via
   mark_cod_paid_delivered()) — both are enforced server-side, not just
   hidden in this UI.
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
          <button type="button" class="btn btn-primary btn-full order-mark-btn" data-id="${o.id}" data-code="${o.order_code}">
            Mark Paid &amp; Delivered
          </button>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".order-mark-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleMarkPaid(btn));
  });
}

async function handleMarkPaid(btn) {
  const id = btn.dataset.id;
  const code = btn.dataset.code;

  if (!confirm(`Confirm: you collected payment for order ${code}?`)) return;

  btn.disabled = true;
  btn.textContent = "Saving…";

  const { error } = await sb.rpc("mark_cod_paid_delivered", { p_order_id: id });

  if (error) {
    alert("Couldn't update this order — please try again. (" + error.message + ")");
    btn.disabled = false;
    btn.textContent = "Mark Paid & Delivered";
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
