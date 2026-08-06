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
  const totalSales = ORDERS.reduce((sum, o) => sum + Number(o.total), 0);

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
        <td>${channelBadge(o.channel)}</td>
        <td class="mono">${peso(o.total)}</td>
        <td>${statusBadge(o)}</td>
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
  } else {
    document.getElementById("productModalTitle").textContent = "Add New Item";
    document.getElementById("productId").value = "";
  }

  document.getElementById("productModal").classList.add("show");
  document.getElementById("productOverlay").classList.add("show");
}

function closeProductModal() {
  document.getElementById("productModal").classList.remove("show");
  document.getElementById("productOverlay").classList.remove("show");
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
function channelBadge(channel) {
  return channel === "online" ? `<span class="badge online">Online</span>` : `<span class="badge walkin">Walk-in</span>`;
}
function statusBadge(order) {
  return order.payment_status === "Paid"
    ? `<span class="badge paid">Paid</span>`
    : `<span class="badge pending" data-toggle-status="${order.id}" title="Click para markahang Paid">Pending</span>`;
}

function renderOrders() {
  const body = document.querySelector("#ordersTable tbody");

  if (ORDERS.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No orders yet.</td></tr>`;
    return;
  }

  body.innerHTML = ORDERS.map((o) => {
    const itemsSummary = o.items.map((it) => `${it.name} (${it.size}/${it.color}) ×${it.qty}`).join("<br>");
    return `
      <tr>
        <td class="mono">${o.order_code}</td>
        <td>${o.full_name}<br><span class="opt">${o.contact_number || ""}</span></td>
        <td>${itemsSummary}</td>
        <td class="mono">${peso(o.total)}</td>
        <td>${channelBadge(o.channel)}</td>
        <td>${o.payment_method}</td>
        <td>${statusBadge(o)}</td>
        <td>${formatDate(o.created_at)}</td>
      </tr>`;
  }).join("");

  attachStatusToggles();
}

function attachStatusToggles() {
  document.querySelectorAll("[data-toggle-status]").forEach((el) => {
    el.addEventListener("click", async () => {
      const { error } = await sb.from("orders").update({ payment_status: "Paid" }).eq("id", el.dataset.toggleStatus);
      if (error) {
        alert("Couldn't update: " + error.message);
        return;
      }
      loadAll();
    });
  });
}

/* ---------------------------------------------------------------------
   Walk-in sale
   --------------------------------------------------------------------- */
function populateWalkinProductSelect() {
  const select = document.getElementById("wProduct");
  const inStock = PRODUCTS.filter((p) => p.stock > 0);
  select.innerHTML = inStock.length
    ? inStock.map((p) => `<option value="${p.id}">${p.name} (${p.size}/${p.color}) — ${p.stock} in stock</option>`).join("")
    : `<option value="" disabled selected>No items available</option>`;
}

function openWalkinModal() {
  document.getElementById("walkinForm").reset();
  document.getElementById("walkinError").textContent = "";
  populateWalkinProductSelect();
  document.getElementById("walkinModal").classList.add("show");
  document.getElementById("walkinOverlay").classList.add("show");
}
function closeWalkinModal() {
  document.getElementById("walkinModal").classList.remove("show");
  document.getElementById("walkinOverlay").classList.remove("show");
}

async function handleWalkinSubmit(e) {
  e.preventDefault();
  const productId = document.getElementById("wProduct").value;
  const qty = Number(document.getElementById("wQty").value);
  const customerName = document.getElementById("wCustomer").value.trim() || "Walk-in customer";
  const errorEl = document.getElementById("walkinError");

  if (!productId) {
    errorEl.textContent = "Please select an item.";
    return;
  }

  const { error } = await sb.rpc("record_walkin_sale", {
    p_product_id: productId,
    p_qty: qty,
    p_customer_name: customerName,
  });

  if (error) {
    errorEl.textContent = "Couldn't record sale: " + error.message;
    return;
  }

  closeWalkinModal();
  loadAll();
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

  document.getElementById("closeRestockModal").addEventListener("click", closeRestockModal);
  document.getElementById("restockOverlay").addEventListener("click", closeRestockModal);
  document.getElementById("restockForm").addEventListener("submit", handleRestockSubmit);

  document.getElementById("addWalkinBtn").addEventListener("click", openWalkinModal);
  document.getElementById("closeWalkinModal").addEventListener("click", closeWalkinModal);
  document.getElementById("walkinOverlay").addEventListener("click", closeWalkinModal);
  document.getElementById("walkinForm").addEventListener("submit", handleWalkinSubmit);
});
