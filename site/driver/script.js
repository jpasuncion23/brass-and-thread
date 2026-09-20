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

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPass").value;
  const errorEl = document.getElementById("loginError");
  const btn = document.getElementById("loginBtn");

  btn.disabled = true;
  btn.textContent = "Logging in…";

  const { error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = "Log In";

  if (error) {
    errorEl.textContent = "Incorrect email or password.";
    return;
  }

  errorEl.textContent = "";
  await showApp();
}

async function handleLogout() {
  try {
    await sb.auth.signOut();
  } catch (err) {
    console.error("Sign out error:", err);
  }
  showLogin();
}

async function showApp() {
  const { data, error } = await sb.rpc("get_driver_orders");

  if (error) {
    // Logged in fine, but this account isn't registered in the `drivers`
    // table — not a driver account, so don't let them see the app shell.
    document.getElementById("loginError").textContent =
      "This account isn't set up as a driver. Ask the shop owner to add it.";
    await sb.auth.signOut();
    showLogin();
    return;
  }

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("driverApp").classList.remove("hidden");
  renderOrders(data || []);
}

function showLogin() {
  document.getElementById("driverApp").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
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
    showLogin();
  }
  subscribeRealtime();

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
});
