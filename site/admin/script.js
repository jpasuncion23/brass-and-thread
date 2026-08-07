/* =========================================================================
   ShopTrack — Admin Dashboard (Supabase-backed)
   ---------------------------------------------------------------------
   Real auth: Supabase Auth session (the admin user you create in
   Supabase → Authentication → Users). Row Level Security only allows a
   logged-in ("authenticated") session to write to products/orders —
   see supabase-schema.sql. supabase-js keeps the session itself
   (stored under its own localStorage key), so refreshing the page
   keeps you logged in until you explicitly log out.
   ========================================================================= */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LOW_STOCK_THRESHOLD = 3;

let PRODUCTS = [];
let ORDERS = [];

function peso(n) {
  return "₱" + Number(n).toLocaleString("en-PH");
}
function formatDate(iso) {
  return new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------------------------------------------------------------------
   Auth
   --------------------------------------------------------------------- */
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
  showApp();
}

async function handleLogout() {
  try {
    await sb.auth.signOut();
  } catch (err) {
    console.error("Sign out error:", err);
  }
  showLogin();
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("adminApp").classList.remove("hidden");
  loadAll();
}

function showLogin() {
  document.getElementById("adminApp").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
}

/* ---------------------------------------------------------------------
   Tabs
   --------------------------------------------------------------------- */
function switchTab(tabName) {
  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === "tab-" + tabName);
  });
}

/* ---------------------------------------------------------------------
   Load data
   --------------------------------------------------------------------- */
async function loadAll() {
  const [{ data: products, error: pErr }, { data: orders, error: oErr }] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("orders").select("*").order("created_at", { ascending: false }),
  ]);

  if (pErr) console.error(pErr);
  if (oErr) console.error(oErr);

  PRODUCTS = products || [];
  ORDERS = orders || [];

  renderDashboard();
  renderInventory();
  renderOrders();
}

/* ---------------------------------------------------------------------
   Dashboard
   --------------------------------------------------------------------- */
function renderDashboard() {
  const totalUnits = PRODUCTS.reduce((sum, p) => sum + p.stock, 0);
  const lowStock = PRODUCTS.filter((p) => p.stock > 0 && p.stock <= LOW_STOCK_THRESHOLD).length;
  const soldOut = PRODUCTS.filter((p) => p.stock <= 0).length;
  const pending = ORDERS.filter((o) => o.payment_status === "Pending").length;
  const totalSales = ORDERS.filter((o) => o.order_status !== "Cancelled").reduce((sum, o) => sum + Number(o.total), 0);

  document.getElementById("statProducts").textContent = PRODUCTS.length;
  document.getElementById("statUnits").textContent = totalUnits;
  document.getElementById("statLowStock").textContent = lowStock;
  document.getElementById("statSoldOut").textContent = soldOut;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statSales").textContent = peso(totalSales);

  const body = document.querySelector("#recentOrdersTable tbody");
  const recent = ORDERS.slice(0, 5);

  body.innerHTML = recent.length
    ? recent
        .map(
          (o) => `
      <tr>
        <td class="mono">${o.order_code}</td>
        <td>${o.full_name}</td>
        <td class="mono">${peso(o.total)}</td>
        <td>${statusBadge(o)}</td>
        <td>${fulfillmentBadge(o.order_status)}</td>
        <td>${formatDate(o.created_at)}</td>
      </tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="6">No orders yet.</td></tr>`;

  attachStatusToggles();
}

/* ---------------------------------------------------------------------
   Inventory
   --------------------------------------------------------------------- */
function stockBadge(stock) {
  if (stock <= 0) return `<span class="badge out">Sold Out</span>`;
  if (stock <= LOW_STOCK_THRESHOLD) return `<span class="badge low">${stock} left</span>`;
  return `<span class="badge ok">${stock} in stock</span>`;
}

function renderInventory() {
  const body = document.querySelector("#inventoryTable tbody");

  if (PRODUCTS.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="9">No items in inventory yet.</td></tr>`;
    return;
  }

  body.innerHTML = PRODUCTS.map(
    (p) => `
    <tr>
      <td>${p.image_url ? `<img class="row-thumb" src="${p.image_url}" alt="${p.name}" />` : `<div class="row-thumb row-thumb-empty"></div>`}</td>
      <td>${p.name}</td>
      <td>${p.size}</td>
      <td>${p.color}</td>
      <td class="mono">${peso(p.cost)}</td>
      <td class="mono">${peso(p.price)}</td>
      <td class="mono">${p.stock}</td>
      <td>${stockBadge(p.stock)}</td>
      <td>
        <div class="row-actions">
          <button data-action="restock" data-id="${p.id}">+ Stock</button>
          <button data-action="deduct" data-id="${p.id}">− Stock</button>
          <button data-action="edit" data-id="${p.id}">Edit</button>
          <button data-action="delete" data-id="${p.id}" class="danger">Delete</button>
        </div>
      </td>
    </tr>`
  ).join("");

  body.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "edit") openProductModal(id);
      else if (btn.dataset.action === "restock") openRestockModal(id);
      else if (btn.dataset.action === "deduct") openDeductModal(id);
      else deleteProduct(id);
    });
  });
}

/* ---------------------------------------------------------------------
   Restock — quick "+N units" instead of retyping the whole new total
   via Edit. Same effect as Edit, just a friendlier action for the most
   common admin task (a new overrun batch of the same item arrives).
   --------------------------------------------------------------------- */
function openRestockModal(id) {
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;

  document.getElementById("restockForm").reset();
  document.getElementById("restockError").textContent = "";
  document.getElementById("restockId").value = id;
  document.getElementById("restockItemInfo").textContent =
    `${product.name} (${product.size}/${product.color}) — currently ${product.stock} in stock.`;
  document.getElementById("restockQty").value = 1;

  document.getElementById("restockModal").classList.add("show");
  document.getElementById("restockOverlay").classList.add("show");
}

function closeRestockModal() {
  document.getElementById("restockModal").classList.remove("show");
  document.getElementById("restockOverlay").classList.remove("show");
}

async function handleRestockSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("restockId").value;
  const qty = Number(document.getElementById("restockQty").value);
  const errorEl = document.getElementById("restockError");

  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;

  if (!qty || qty < 1) {
    errorEl.textContent = "Enter how many units to add.";
    return;
  }

  const { error } = await sb.from("products").update({ stock: product.stock + qty }).eq("id", id);

  if (error) {
    errorEl.textContent = "Couldn't restock: " + error.message;
    return;
  }

  closeRestockModal();
  loadAll();
}

/* ---------------------------------------------------------------------
   Deduct stock — the mirror of Restock, for damaged units, corrections,
   or stock pulled out for any reason other than a sale.
   --------------------------------------------------------------------- */
function openDeductModal(id) {
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;

  document.getElementById("deductForm").reset();
  document.getElementById("deductError").textContent = "";
  document.getElementById("deductId").value = id;
  document.getElementById("deductItemInfo").textContent =
    `${product.name} (${product.size}/${product.color}) — currently ${product.stock} in stock.`;
  document.getElementById("deductQty").value = 1;
  document.getElementById("deductQty").max = product.stock;

  document.getElementById("deductModal").classList.add("show");
  document.getElementById("deductOverlay").classList.add("show");
}

function closeDeductModal() {
  document.getElementById("deductModal").classList.remove("show");
  document.getElementById("deductOverlay").classList.remove("show");
}

async function handleDeductSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("deductId").value;
  const qty = Number(document.getElementById("deductQty").value);
  const errorEl = document.getElementById("deductError");

  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;

  if (!qty || qty < 1) {
    errorEl.textContent = "Enter how many units to remove.";
    return;
  }
  if (qty > product.stock) {
    errorEl.textContent = `Only ${product.stock} in stock — can't remove more than that.`;
    return;
  }

  const { error } = await sb.from("products").update({ stock: product.stock - qty }).eq("id", id);

  if (error) {
    errorEl.textContent = "Couldn't update stock: " + error.message;
    return;
  }

  closeDeductModal();
  loadAll();
}

function openProductModal(id) {
  const form = document.getElementById("productForm");
  form.reset();
  document.getElementById("productError").textContent = "";

  if (id) {
    const product = PRODUCTS.find((p) => p.id === id);
    if (!product) return;
    document.getElementById("productModalTitle").textContent = "Edit Item";
    document.getElementById("productId").value = product.id;
    document.getElementById("pName").value = product.name;
    document.getElementById("pSize").value = product.size;
    document.getElementById("pColor").value = product.color;
    document.getElementById("pCost").value = product.cost;
    document.getElementById("pPrice").value = product.price;
    document.getElementById("pStock").value = product.stock;
    document.getElementById("pImageUrl").value = product.image_url || "";
    showImagePreview(product.image_url);
  } else {
    document.getElementById("productModalTitle").textContent = "Add New Item";
    document.getElementById("productId").value = "";
    showImagePreview(null);
  }

  document.getElementById("imageUploadStatus").textContent = "";
  document.getElementById("productModal").classList.add("show");
  document.getElementById("productOverlay").classList.add("show");
}

function closeProductModal() {
  document.getElementById("productModal").classList.remove("show");
  document.getElementById("productOverlay").classList.remove("show");
}

function showImagePreview(url) {
  const wrap = document.getElementById("pImagePreviewWrap");
  const img = document.getElementById("pImagePreview");
  if (url) {
    img.src = url;
    wrap.classList.remove("hidden");
  } else {
    img.src = "";
    wrap.classList.add("hidden");
  }
}

/* ---------------------------------------------------------------------
   Image upload — sends the file straight to Supabase Storage
   (bucket "product-images", see supabase-schema-storage.sql) and drops
   the resulting public URL into the same field Save Item reads from.
   --------------------------------------------------------------------- */
async function handleImageFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("imageUploadStatus");
  statusEl.textContent = "Uploading…";

  const ext = file.name.split(".").pop();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: uploadError } = await sb.storage.from("product-images").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });

  if (uploadError) {
    statusEl.textContent = "Upload failed: " + uploadError.message;
    return;
  }

  const { data } = sb.storage.from("product-images").getPublicUrl(path);
  document.getElementById("pImageUrl").value = data.publicUrl;
  showImagePreview(data.publicUrl);
  statusEl.textContent = "Uploaded ✓";
}

async function handleProductSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("productId").value;
  const name = document.getElementById("pName").value.trim();
  const size = document.getElementById("pSize").value.trim();
  const color = document.getElementById("pColor").value.trim();
  const cost = Number(document.getElementById("pCost").value);
  const price = Number(document.getElementById("pPrice").value);
  const stock = Number(document.getElementById("pStock").value);
  const imageUrl = document.getElementById("pImageUrl").value.trim();
  const errorEl = document.getElementById("productError");

  if (!name || !size || !color || isNaN(cost) || isNaN(price) || isNaN(stock) || stock < 0) {
    errorEl.textContent = "Please check the fields — are they all complete and valid?";
    return;
  }

  const payload = { name, size, color, cost, price, stock, image_url: imageUrl || null };
  const { error } = id
    ? await sb.from("products").update(payload).eq("id", id)
    : await sb.from("products").insert(payload);

  if (error) {
    errorEl.textContent = "Couldn't save: " + error.message;
    return;
  }

  closeProductModal();
  loadAll();
}

async function deleteProduct(id) {
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;

  const warn =
    product.stock > 0
      ? `"${product.name}" (${product.size}/${product.color}) still has ${product.stock} unit(s) left. Delete it anyway?`
      : `Delete "${product.name}" (${product.size}/${product.color})?`;

  if (!confirm(warn)) return;

  const { error } = await sb.from("products").delete().eq("id", id);
  if (error) {
    alert("Couldn't delete: " + error.message);
    return;
  }
  loadAll();
}

/* ---------------------------------------------------------------------
   Orders
   --------------------------------------------------------------------- */
function statusBadge(order) {
  if (order.payment_status === "Refunded") {
    return `<span class="badge refunded">Refunded</span>`;
  }
  // Cancelled after already being paid (usually GCash) — flag it until
  // the admin confirms the money's actually been sent back.
  if (order.payment_status === "Paid" && order.order_status === "Cancelled") {
    return `<span class="badge needs-refund" data-mark-refunded="${order.id}" title="Click once the refund has been sent">Needs Refund</span>`;
  }
  if (order.payment_status === "Paid") {
    return `<span class="badge paid">Paid</span>`;
  }
  return `<span class="badge pending" data-toggle-status="${order.id}" title="Click to mark Paid">Pending</span>`;
}

function orderRowHtml(o) {
  const itemsSummary = o.items.map((it) => `${it.name} (${it.size}/${it.color}) ×${it.qty}`).join("<br>");
  return `
    <tr>
      <td class="mono">${o.order_code}</td>
      <td>${o.full_name}<br><span class="opt">${o.contact_number || ""}</span></td>
      <td>${itemsSummary}</td>
      <td class="mono">${peso(o.total)}</td>
      <td>${o.payment_method}<br>${statusBadge(o)}</td>
      <td>${fulfillmentSelect(o)}</td>
      <td>${formatDate(o.created_at)}</td>
      <td><button data-view-order="${o.id}">View</button></td>
    </tr>`;
}

// Still-open orders needing admin action; completed ones (Delivered /
// Cancelled) are done and just kept for reference.
const ACTIVE_STATUSES = ["Pending", "Processing", "Out for Delivery"];

// Search box + status dropdown above the Orders table — lets the admin
// quickly find one customer's order instead of scrolling the whole list.
function getFilteredOrders() {
  const term = (document.getElementById("orderSearchInput")?.value || "").trim().toLowerCase();
  const statusFilter = document.getElementById("orderStatusFilter")?.value || "";

  return ORDERS.filter((o) => {
    if (statusFilter && (o.order_status || "Pending") !== statusFilter) return false;
    if (!term) return true;
    const haystack = [o.order_code, o.full_name, o.contact_number, o.email]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
}

function renderOrders() {
  const body = document.querySelector("#ordersTable tbody");

  if (ORDERS.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No orders yet.</td></tr>`;
    return;
  }

  const filtered = getFilteredOrders();

  if (filtered.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No orders match your search/filter.</td></tr>`;
    return;
  }

  // Active queue: first come, first served — the earliest unhandled
  // order sits on top so the admin naturally works down the list in the
  // order customers actually placed them.
  const active = filtered.filter((o) => ACTIVE_STATUSES.includes(o.order_status || "Pending"))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // Completed orders: just a record now, most recently finished on top.
  const completed = filtered.filter((o) => !ACTIVE_STATUSES.includes(o.order_status || "Pending"))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const activeRows = active.map(orderRowHtml).join("");
  const divider = completed.length
    ? `<tr class="section-divider-row"><td colspan="8">Completed (Delivered / Cancelled)</td></tr>`
    : "";
  const completedRows = completed.map(orderRowHtml).join("");

  body.innerHTML = (activeRows || `<tr class="empty-row"><td colspan="8">No active orders — all caught up.</td></tr>`) + divider + completedRows;

  attachStatusToggles();
  attachFulfillmentSelects();

  document.querySelectorAll("[data-view-order]").forEach((btn) => {
    btn.addEventListener("click", () => openOrderDetail(btn.dataset.viewOrder));
  });
}

/* ---------------------------------------------------------------------
   Fulfillment status — the shipping-stage tracking (Pending → Processing
   → Out for Delivery → Delivered, or Cancelled), separate from whether
   the order has been paid. New orders start at "Pending" — the admin's
   signal that it hasn't been looked at yet — and move to "Processing"
   once work on it actually begins.
   --------------------------------------------------------------------- */
const ORDER_STATUSES = ["Pending", "Processing", "Out for Delivery", "Delivered", "Cancelled"];

function fulfillmentBadge(status) {
  status = status || "Pending"; // falls back gracefully if the column isn't there yet
  const cls = "fulfillment-" + status.replace(/\s+/g, "-").toLowerCase();
  return `<span class="badge ${cls}">${status}</span>`;
}

function fulfillmentSelect(order) {
  const current = order.order_status || "Pending";
  const options = ORDER_STATUSES.map(
    (s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s}</option>`
  ).join("");
  return `<select class="fulfillment-select fulfillment-${current.replace(/\s+/g, "-").toLowerCase()}" data-order-id="${order.id}">${options}</select>`;
}

function attachFulfillmentSelects() {
  document.querySelectorAll(".fulfillment-select").forEach((select) => {
    if (select.dataset.bound) return;
    select.dataset.bound = "1";
    select.addEventListener("change", async () => {
      const newStatus = select.value;
      const orderId = select.dataset.orderId;

      // Cancelling goes through a dedicated function that also puts the
      // stock back — a plain status update would leave it deducted.
      const { error } =
        newStatus === "Cancelled"
          ? await sb.rpc("cancel_order", { p_order_id: orderId })
          : await sb.from("orders").update({ order_status: newStatus }).eq("id", orderId);

      if (error) {
        alert("Couldn't update fulfillment status: " + error.message);
        return;
      }
      loadAll();
    });
  });
}

/* ---------------------------------------------------------------------
   Order detail — full customer info so it's always traceable who
   placed an order and how to reach them (name, contact, email,
   address, notes), not just the summary shown in the table.
   --------------------------------------------------------------------- */
function openOrderDetail(id) {
  const order = ORDERS.find((o) => o.id === id);
  if (!order) return;

  const itemsHtml = order.items
    .map((it) => `<div class="row"><span>${it.name} (${it.size}/${it.color}) × ${it.qty}</span><span>${peso(it.price * it.qty)}</span></div>`)
    .join("");

  document.getElementById("orderDetailBody").innerHTML = `
    <div class="order-detail-top">
      <span class="mono">${order.order_code}</span>
      ${statusBadge(order)}
    </div>

    <label class="fulfillment-label">Fulfillment status
      ${fulfillmentSelect(order)}
    </label>

    <div class="order-detail-grid">
      <div>
        <p class="opt">Full name</p>
        <p>${order.full_name}</p>
      </div>
      <div>
        <p class="opt">Contact number</p>
        <p>${order.contact_number || "—"}</p>
      </div>
      <div>
        <p class="opt">Email</p>
        <p>${order.email || "—"}</p>
      </div>
      <div>
        <p class="opt">Payment method</p>
        <p>${order.payment_method}</p>
      </div>
      <div class="span-2">
        <p class="opt">Delivery address</p>
        <p>${order.address || "—"}</p>
      </div>
      <div class="span-2">
        <p class="opt">Order notes</p>
        <p>${order.order_notes || "—"}</p>
      </div>
    </div>

    <div class="order-summary">
      ${itemsHtml}
      <div class="row total"><span>Total</span><span>${peso(order.total)}</span></div>
    </div>

    <p class="opt">Placed ${formatDate(order.created_at)}</p>
  `;

  attachStatusToggles();
  attachFulfillmentSelects();
  document.getElementById("orderDetailModal").classList.add("show");
  document.getElementById("orderDetailOverlay").classList.add("show");
}

function closeOrderDetail() {
  document.getElementById("orderDetailModal").classList.remove("show");
  document.getElementById("orderDetailOverlay").classList.remove("show");
}

function attachStatusToggles() {
  document.querySelectorAll("[data-toggle-status]").forEach((el) => {
    if (el.dataset.bound) return; // avoid double-binding across re-renders
    el.dataset.bound = "1";
    el.addEventListener("click", async () => {
      const { error } = await sb.from("orders").update({ payment_status: "Paid" }).eq("id", el.dataset.toggleStatus);
      if (error) {
        alert("Couldn't update: " + error.message);
        return;
      }
      loadAll();
    });
  });

  document.querySelectorAll("[data-mark-refunded]").forEach((el) => {
    if (el.dataset.bound) return;
    el.dataset.bound = "1";
    el.addEventListener("click", async () => {
      if (!confirm("Mark this order as refunded? Only click this once you've actually sent the money back.")) return;
      const { error } = await sb.from("orders").update({ payment_status: "Refunded" }).eq("id", el.dataset.markRefunded);
      if (error) {
        alert("Couldn't update: " + error.message);
        return;
      }
      loadAll();
    });
  });
}

/* ---------------------------------------------------------------------
   Realtime — auto-refresh when the storefront (or another admin tab)
   changes products/orders, no manual reload needed.
   --------------------------------------------------------------------- */
function subscribeRealtime() {
  sb.channel("admin-products")
    .on("postgres_changes", { event: "*", schema: "public", table: "products" }, loadAll)
    .subscribe();

  sb.channel("admin-orders")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, loadAll)
    .subscribe();
}

/* ---------------------------------------------------------------------
   Init
   --------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    showApp();
  } else {
    showLogin();
  }
  subscribeRealtime();

  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);

  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("addProductBtn").addEventListener("click", () => openProductModal(null));
  document.getElementById("closeProductModal").addEventListener("click", closeProductModal);
  document.getElementById("productOverlay").addEventListener("click", closeProductModal);
  document.getElementById("productForm").addEventListener("submit", handleProductSubmit);
  document.getElementById("pImageFile").addEventListener("change", handleImageFileChange);
  document.getElementById("pImageUrl").addEventListener("input", (e) => showImagePreview(e.target.value.trim() || null));

  document.getElementById("closeRestockModal").addEventListener("click", closeRestockModal);
  document.getElementById("restockOverlay").addEventListener("click", closeRestockModal);
  document.getElementById("restockForm").addEventListener("submit", handleRestockSubmit);

  document.getElementById("closeDeductModal").addEventListener("click", closeDeductModal);
  document.getElementById("deductOverlay").addEventListener("click", closeDeductModal);
  document.getElementById("deductForm").addEventListener("submit", handleDeductSubmit);

  document.getElementById("closeOrderDetailModal").addEventListener("click", closeOrderDetail);
  document.getElementById("orderDetailOverlay").addEventListener("click", closeOrderDetail);

  document.getElementById("orderSearchInput").addEventListener("input", renderOrders);
  document.getElementById("orderStatusFilter").addEventListener("change", renderOrders);
});
