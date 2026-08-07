/* =========================================================================
   Brass & Thread — Storefront (Supabase-backed)
   ---------------------------------------------------------------------
   Real backend: products/orders live in a hosted Postgres database
   (Supabase). Checkout calls the place_order() database function, which
   re-checks stock and deducts it inside one atomic transaction — see
   supabase-schema.sql for exactly how the race condition described in
   the paper (two customers, one last unit) is handled server-side.
   ========================================================================= */

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LOW_STOCK_THRESHOLD = 3;
const CART_KEY = "bt_cart"; // sessionStorage — guest cart, resets per browser session

let PRODUCTS = []; // local cache of the last fetch, refreshed on load + realtime events

function peso(n) {
  return "₱" + Number(n).toLocaleString("en-PH");
}

/* ---------------------------------------------------------------------
   Hero carousel — no product photography yet, so each slide is a
   CSS-built backdrop (see .hero-slide in style.css) tinted per slide,
   with its own headline. Swap in real photos later by setting each
   slide's background-image inline here once you have them.
   --------------------------------------------------------------------- */
const HERO_SLIDES = [
  {
    kicker: "Manifest No. 004 · Limited Batch",
    headline: "What's left<br />is what's left.",
    sub: "Every shirt here is factory overrun — extra units and surplus lots that already exist, sold off before they go to waste. Once a size or print sells out, that exact batch usually isn't coming back.",
    colorA: "#f9f0e2",
    colorB: "#f0d9ae",
    video: "/videos/hero-loop.mp4",
  },
  {
    kicker: "Optional Account",
    headline: "Order as a guest.<br />Or save your info.",
    sub: "Check out with just your name, contact number, and how you'll pay — no account required. Prefer to save your details for next time? That's here too, totally optional.",
    colorA: "#eef2e6",
    colorB: "#dbe6c9",
    image: "/images/brooklyn-tee.jpg",
  },
  {
    kicker: "Live Stock Count",
    headline: "What you see<br />is what's on the shelf.",
    sub: "The stock count on every card is the same number the owner sees on the ShopTrack dashboard — updated the moment an order comes in.",
    colorA: "#faece0",
    colorB: "#f0cba0",
    image: "/images/toyota-tee.jpg",
  },
];

let heroIndex = 0;
let heroTimer = null;

function renderHeroSlides() {
  const slidesEl = document.getElementById("heroSlides");
  const dotsEl = document.getElementById("heroDots");

  slidesEl.innerHTML = HERO_SLIDES.map((s, i) => {
    let media = "";
    if (s.video) {
      media = `<video src="${s.video}" autoplay muted loop playsinline></video>`;
    } else if (s.image) {
      media = `<img src="${s.image}" alt="" />`;
    }
    return `<div class="hero-slide${i === 0 ? " active" : ""}" style="--slide-a:${s.colorA}; --slide-b:${s.colorB}">${media}</div>`;
  }).join("");

  dotsEl.innerHTML = HERO_SLIDES.map(
    (_, i) => `<button data-index="${i}" class="${i === 0 ? "active" : ""}" aria-label="Slide ${i + 1}"></button>`
  ).join("");

  dotsEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => goToHeroSlide(Number(btn.dataset.index)));
  });

  updateHeroText();
}

function updateHeroText() {
  const slide = HERO_SLIDES[heroIndex];
  document.getElementById("heroKicker").textContent = slide.kicker;
  document.getElementById("heroHeadline").innerHTML = slide.headline;
  document.getElementById("heroSub").textContent = slide.sub;

  document.querySelectorAll(".hero-slide").forEach((el, i) => el.classList.toggle("active", i === heroIndex));
  document.querySelectorAll("#heroDots button").forEach((el, i) => el.classList.toggle("active", i === heroIndex));
}

function goToHeroSlide(index) {
  heroIndex = (index + HERO_SLIDES.length) % HERO_SLIDES.length;
  updateHeroText();
  restartHeroAutoplay();
}

function restartHeroAutoplay() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => goToHeroSlide(heroIndex + 1), 6000);
}

/* ---------------------------------------------------------------------
   Navbar — transparent over the hero, solid once you scroll past it
   --------------------------------------------------------------------- */
function initNavbarScroll() {
  const navbar = document.getElementById("navbar");
  const hero = document.querySelector(".hero");

  const observer = new IntersectionObserver(
    ([entry]) => navbar.classList.toggle("scrolled", !entry.isIntersecting),
    { threshold: 0, rootMargin: "-72px 0px 0px 0px" }
  );
  observer.observe(hero);
}

/* ---------------------------------------------------------------------
   Chat widget — a lightweight contact popover (no live-chat backend)
   --------------------------------------------------------------------- */
function initChatWidget() {
  const bubble = document.getElementById("chatBubble");
  const popover = document.getElementById("chatPopover");

  bubble.addEventListener("click", () => popover.classList.toggle("show"));
  document.addEventListener("click", (e) => {
    if (!popover.contains(e.target) && e.target !== bubble) popover.classList.remove("show");
  });
}

/* ---------------------------------------------------------------------
   Cart (client-side only until checkout — no stock is touched yet)
   --------------------------------------------------------------------- */
function getCart() {
  return JSON.parse(sessionStorage.getItem(CART_KEY) || "{}"); // { productId: qty }
}
function saveCart(cart) {
  sessionStorage.setItem(CART_KEY, JSON.stringify(cart));
}

/* ---------------------------------------------------------------------
   Fetch + render products
   --------------------------------------------------------------------- */
async function loadProducts() {
  const { data, error } = await sb.from("products").select("*").order("name");
  const loadState = document.getElementById("loadState");

  if (error) {
    loadState.textContent = "Couldn't load stock — check your config.js / internet connection.";
    console.error(error);
    return;
  }

  PRODUCTS = data;
  loadState.classList.add("hidden");
  renderProducts();
  renderCart(); // in case stock changed under an item already in cart
}

function renderProducts() {
  const grid = document.getElementById("productGrid");
  grid.innerHTML = "";

  PRODUCTS.forEach((p) => {
    const soldOut = p.stock <= 0;
    const low = !soldOut && p.stock <= LOW_STOCK_THRESHOLD;
    const pillClass = soldOut ? "out" : low ? "low" : "";
    const pillText = soldOut ? "Sold Out" : `${p.stock} left`;

    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="product-photo">
        ${p.image_url ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy" />` : `<span class="product-photo-placeholder">👕</span>`}
      </div>
      <span class="stock-pill ${pillClass}">${pillText}</span>
      <h3>${p.name}</h3>
      <div class="tag-divider"></div>
      <p class="product-meta">Size ${p.size} · ${p.color}</p>
      <p class="product-price">${peso(p.price)}</p>
      <button class="btn btn-primary add-to-cart-btn" data-id="${p.id}" ${soldOut ? "disabled" : ""}>
        ${soldOut ? "Sold Out" : "Add to Cart"}
      </button>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll(".add-to-cart-btn").forEach((btn) => {
    btn.addEventListener("click", () => addToCart(btn.dataset.id));
  });
}

function addToCart(productId) {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return;

  const cart = getCart();
  const currentQty = cart[productId] || 0;

  if (currentQty + 1 > product.stock) {
    alert(`Sorry, "${product.name}" (${product.size}/${product.color}) only has ${product.stock} left in stock.`);
    return;
  }

  cart[productId] = currentQty + 1;
  saveCart(cart);
  renderCart();
  openCart();
}

function renderCart() {
  const cart = getCart();
  const container = document.getElementById("cartItems");
  const totalEl = document.getElementById("cartTotal");
  const countEl = document.getElementById("cartCount");
  const checkoutBtn = document.getElementById("checkoutBtn");

  const entries = Object.entries(cart).filter(([, qty]) => qty > 0);
  let total = 0;
  let itemCount = 0;

  if (entries.length === 0) {
    container.innerHTML = `<p class="cart-empty">Your cart is empty.</p>`;
  } else {
    container.innerHTML = "";
    entries.forEach(([id, qty]) => {
      const product = PRODUCTS.find((p) => p.id === id);
      if (!product) return;

      total += product.price * qty;
      itemCount += qty;

      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div class="cart-item-info">
          <div class="name">${product.name}</div>
          <div class="meta">${product.size} / ${product.color} · ${peso(product.price)}</div>
          <div class="qty-controls">
            <button data-action="dec" data-id="${product.id}">−</button>
            <span>${qty}</span>
            <button data-action="inc" data-id="${product.id}">+</button>
          </div>
        </div>
        <button class="cart-item-remove" data-action="remove" data-id="${product.id}">Remove</button>
      `;
      container.appendChild(row);
    });
  }

  totalEl.textContent = peso(total);
  countEl.textContent = itemCount;
  checkoutBtn.disabled = itemCount === 0;

  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const cart = getCart();
      const product = PRODUCTS.find((p) => p.id === id);

      if (action === "inc") {
        if (product && (cart[id] || 0) + 1 > product.stock) {
          alert(`Only ${product.stock} left in stock.`);
          return;
        }
        cart[id] = (cart[id] || 0) + 1;
      } else if (action === "dec") {
        cart[id] = Math.max(0, (cart[id] || 0) - 1);
      } else if (action === "remove") {
        delete cart[id];
      }

      saveCart(cart);
      renderCart();
    });
  });
}

/* ---------------------------------------------------------------------
   Cart drawer + modals
   --------------------------------------------------------------------- */
function openCart() {
  document.getElementById("cartDrawer").classList.add("open");
  document.getElementById("cartOverlay").classList.add("show");
}
function closeCart() {
  document.getElementById("cartDrawer").classList.remove("open");
  document.getElementById("cartOverlay").classList.remove("show");
}

function openCheckout() {
  const cart = getCart();
  const entries = Object.entries(cart).filter(([, qty]) => qty > 0);
  if (entries.length === 0) return;

  const summary = document.getElementById("checkoutSummary");
  let total = 0;
  summary.innerHTML =
    entries
      .map(([id, qty]) => {
        const p = PRODUCTS.find((pr) => pr.id === id);
        if (!p) return "";
        const lineTotal = p.price * qty;
        total += lineTotal;
        return `<div class="row"><span>${p.name} (${p.size}/${p.color}) × ${qty}</span><span>${peso(lineTotal)}</span></div>`;
      })
      .join("") + `<div class="row total"><span>Total</span><span>${peso(total)}</span></div>`;

  document.getElementById("checkoutError").textContent = "";
  document.getElementById("checkoutForm").reset();

  // Convenience only — a logged-in customer doesn't have to retype these.
  // Guests skip this entirely and the form just stays blank.
  if (CURRENT_USER) {
    document.getElementById("fullName").value = CURRENT_USER.user_metadata?.full_name || "";
    document.getElementById("email").value = CURRENT_USER.email || "";
  }

  closeCart();
  document.getElementById("checkoutModal").classList.add("show");
  document.getElementById("checkoutOverlay").classList.add("show");
}

function closeCheckout() {
  document.getElementById("checkoutModal").classList.remove("show");
  document.getElementById("checkoutOverlay").classList.remove("show");
}

function openConfirm(orderCode, total, paymentMethod, contactNumber, fullName) {
  document.getElementById("confirmText").textContent =
    `Thank you, ${fullName}! Order ${orderCode} — ${peso(total)} via ${paymentMethod}. ` +
    `We'll reach out at ${contactNumber} to arrange delivery.`;
  document.getElementById("confirmModal").classList.add("show");
  document.getElementById("confirmOverlay").classList.add("show");
}
function closeConfirm() {
  document.getElementById("confirmModal").classList.remove("show");
  document.getElementById("confirmOverlay").classList.remove("show");
}

/* ---------------------------------------------------------------------
   Checkout — calls the place_order() database function
   --------------------------------------------------------------------- */
async function handleCheckoutSubmit(e) {
  e.preventDefault();

  const cart = getCart();
  const entries = Object.entries(cart).filter(([, qty]) => qty > 0);
  const errorEl = document.getElementById("checkoutError");
  const submitBtn = document.getElementById("placeOrderBtn");

  if (entries.length === 0) {
    errorEl.textContent = "Your cart is empty.";
    return;
  }

  const fullName = document.getElementById("fullName").value.trim();
  const contactNumber = document.getElementById("contactNumber").value.trim();
  const email = document.getElementById("email").value.trim();
  const address = document.getElementById("address").value.trim();
  const paymentMethod = document.getElementById("paymentMethod").value;
  const orderNotes = document.getElementById("orderNotes").value.trim();

  if (!fullName || !contactNumber || !email || !paymentMethod) {
    errorEl.textContent = "Please fill out all required fields.";
    return;
  }

  const items = entries.map(([productId, qty]) => ({ product_id: productId, qty }));

  submitBtn.disabled = true;
  submitBtn.textContent = "Placing order…";
  errorEl.textContent = "";

  const { data: order, error } = await sb.rpc("place_order", {
    p_items: items,
    p_full_name: fullName,
    p_contact_number: contactNumber,
    p_email: email,
    p_address: address,
    p_payment_method: paymentMethod,
    p_order_notes: orderNotes,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = "Place Order";

  if (error) {
    // The database re-checked stock and something no longer fits —
    // this is Section 4 Step 2 of the paper in action.
    errorEl.textContent = friendlyDbError(error.message);
    await loadProducts();
    return;
  }

  saveCart({});
  renderCart();
  await loadProducts();
  closeCheckout();
  openConfirm(order.order_code, order.total, paymentMethod, contactNumber, fullName);
}

function friendlyDbError(message) {
  if (message.includes("INSUFFICIENT_STOCK")) {
    return "Sorry, an item in your cart ran out of stock before you submitted. Please check your cart again.";
  }
  if (message.includes("MISSING_FIELDS")) {
    return "Please fill out all required fields.";
  }
  if (message.includes("CART_EMPTY")) {
    return "Your cart is empty.";
  }
  return "Couldn't place the order — please try again. (" + message + ")";
}

/* ---------------------------------------------------------------------
   Optional customer account — guest checkout works with or without one.
   Logging in just tags future orders to the account (so "My Orders"
   works) and prefills the checkout form.
   --------------------------------------------------------------------- */
let CURRENT_USER = null; // Supabase auth user object, or null if guest
let authMode = "login"; // "login" | "signup"

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === "signup";
  document.getElementById("authModalTitle").textContent = isSignup ? "Register Your Account" : "Log In";
  document.getElementById("authNameRow").classList.toggle("hidden", !isSignup);
  document.getElementById("authSwitchText").textContent = isSignup ? "Already have an account?" : "Don't have an account?";
  document.getElementById("authSwitchBtn").textContent = isSignup ? "Log In" : "Sign Up";
  document.getElementById("forgotPasswordBtn").classList.toggle("hidden", isSignup);
  document.getElementById("authError").textContent = "";
}

function openAuth() {
  document.getElementById("authForm").reset();
  setAuthMode("login");
  document.getElementById("authModal").classList.add("show");
  document.getElementById("authOverlay").classList.add("show");
}
function closeAuth() {
  document.getElementById("authModal").classList.remove("show");
  document.getElementById("authOverlay").classList.remove("show");
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const firstName = document.getElementById("authFirstName").value.trim();
  const lastName = document.getElementById("authLastName").value.trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const errorEl = document.getElementById("authError");
  const btn = document.getElementById("authSubmitBtn");

  btn.disabled = true;
  errorEl.textContent = "";

  const { data, error } =
    authMode === "signup"
      ? await sb.auth.signUp({
          email,
          password,
          options: { data: { first_name: firstName, last_name: lastName, full_name: fullName } },
        })
      : await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;

  if (error) {
    errorEl.textContent = error.message.includes("Invalid login")
      ? "Incorrect email or password."
      : error.message;
    return;
  }

  if (authMode === "signup" && !data.session) {
    // Email confirmation is on for this project — they'll need to
    // confirm before their first login. Guest checkout still works
    // in the meantime.
    errorEl.textContent = "";
    alert("Account created! Check your email to confirm it, then log in.");
    setAuthMode("login");
    return;
  }

  closeAuth();
  updateAccountUI();
}

function updateAccountUI() {
  const accountBtn = document.getElementById("accountBtn");
  if (CURRENT_USER) {
    const firstName = CURRENT_USER.user_metadata?.first_name;
    const label = firstName || CURRENT_USER.user_metadata?.full_name || CURRENT_USER.email;
    accountBtn.textContent = "Hi, " + label.split(" ")[0];
  } else {
    accountBtn.textContent = "Log In";
  }
  document.getElementById("accountMenu").classList.remove("show");
  updateAdminLinkVisibility();
}

/* ---------------------------------------------------------------------
   Admin Dashboard link — only shown once we've confirmed the signed-in
   account is actually listed in `admins` (see supabase-schema-optional-
   login.sql). A customer account never sees this, logged in or not.
   --------------------------------------------------------------------- */
async function updateAdminLinkVisibility() {
  const link = document.getElementById("adminDashboardLink");
  if (!CURRENT_USER) {
    link.classList.add("hidden");
    return;
  }

  const { data, error } = await sb.from("admins").select("user_id").eq("user_id", CURRENT_USER.id).maybeSingle();
  link.classList.toggle("hidden", error || !data);
}

function toggleAccountMenu() {
  if (!CURRENT_USER) {
    openAuth();
    return;
  }
  document.getElementById("accountMenu").classList.toggle("show");
}

async function handleLogout() {
  await sb.auth.signOut();
  CURRENT_USER = null;
  updateAccountUI();
}

async function openMyOrders() {
  document.getElementById("accountMenu").classList.remove("show");
  const listEl = document.getElementById("myOrdersList");
  listEl.innerHTML = `<p class="cart-empty">Loading…</p>`;
  document.getElementById("myOrdersModal").classList.add("show");
  document.getElementById("myOrdersOverlay").classList.add("show");

  const { data: orders, error } = await sb.from("orders").select("*").order("created_at", { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="cart-empty">Couldn't load your orders.</p>`;
    return;
  }

  listEl.innerHTML = orders.length
    ? orders
        .map((o) => {
          const items = o.items.map((it) => `${it.name} (${it.size}/${it.color}) ×${it.qty}`).join(", ");
          const statusClass = o.payment_status === "Paid" ? "ok" : o.payment_status === "Refunded" ? "out" : "low";
          return `
        <div class="my-order-card">
          <div class="my-order-top">
            <span class="mono">${o.order_code}</span>
            <span class="stock-pill ${statusClass}">${o.payment_status}</span>
          </div>
          <p class="my-order-items">${items}</p>
          ${orderTrackerHtml(o.order_status)}
          <div class="my-order-bottom">
            <span class="mono">${peso(o.total)}</span>
            <span>${new Date(o.created_at).toLocaleDateString("en-PH", { dateStyle: "medium" })}</span>
          </div>
        </div>`;
        })
        .join("")
    : `<p class="cart-empty">You don't have any orders yet.</p>`;
}

/* ---------------------------------------------------------------------
   Order tracker — a Lazada/Shopee-style progress stepper for the
   fulfillment stage the admin sets from the ShopTrack dashboard.
   --------------------------------------------------------------------- */
function orderTrackerHtml(status) {
  if (status === "Cancelled") {
    return `<div class="order-tracker cancelled"><span class="tracker-cancelled-label">✕ Order Cancelled</span></div>`;
  }

  const stages = ["Processing", "Out for Delivery", "Delivered"];
  const currentIndex = Math.max(stages.indexOf(status), 0);

  const steps = stages
    .map((stage, i) => {
      const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "";
      return `<div class="tracker-step ${state}"><span class="tracker-dot"></span><span class="tracker-label">${stage}</span></div>`;
    })
    .join("");

  return `<div class="order-tracker">${steps}</div>`;
}

function closeMyOrders() {
  document.getElementById("myOrdersModal").classList.remove("show");
  document.getElementById("myOrdersOverlay").classList.remove("show");
}

async function initAuth() {
  const { data } = await sb.auth.getSession();
  CURRENT_USER = data.session?.user || null;
  updateAccountUI();

  sb.auth.onAuthStateChange((event, session) => {
    CURRENT_USER = session?.user || null;
    updateAccountUI();

    // Supabase lands the user back here (via the emailed reset link)
    // with a temporary "recovery" session — that's our cue to ask for
    // a new password instead of treating it as a normal login.
    if (event === "PASSWORD_RECOVERY") {
      openNewPasswordModal();
    }
  });
}

/* ---------------------------------------------------------------------
   Forgot password — sends a reset link to the email on file. No
   account lookup needed client-side; Supabase just no-ops quietly if
   the address doesn't match anything, same as it does for signup.
   --------------------------------------------------------------------- */
function openForgotPassword() {
  closeAuth();
  document.getElementById("forgotForm").reset();
  document.getElementById("forgotError").textContent = "";
  document.getElementById("forgotEmail").value = document.getElementById("authEmail").value;
  document.getElementById("forgotModal").classList.add("show");
  document.getElementById("forgotOverlay").classList.add("show");
}

function closeForgotPassword() {
  document.getElementById("forgotModal").classList.remove("show");
  document.getElementById("forgotOverlay").classList.remove("show");
}

async function handleForgotSubmit(e) {
  e.preventDefault();
  const email = document.getElementById("forgotEmail").value.trim();
  const errorEl = document.getElementById("forgotError");
  const btn = document.getElementById("forgotSubmitBtn");

  btn.disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  btn.disabled = false;

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  closeForgotPassword();
  alert(`If an account exists for ${email}, a password reset link is on its way — check your inbox.`);
}

/* ---------------------------------------------------------------------
   Set new password — reached only via the emailed reset link
   (PASSWORD_RECOVERY event above), never opened directly by a button.
   --------------------------------------------------------------------- */
function openNewPasswordModal() {
  document.getElementById("newPasswordForm").reset();
  document.getElementById("newPasswordError").textContent = "";
  document.getElementById("newPasswordModal").classList.add("show");
  document.getElementById("newPasswordOverlay").classList.add("show");
}

function closeNewPasswordModal() {
  document.getElementById("newPasswordModal").classList.remove("show");
  document.getElementById("newPasswordOverlay").classList.remove("show");
}

async function handleNewPasswordSubmit(e) {
  e.preventDefault();
  const password = document.getElementById("newPassword").value;
  const errorEl = document.getElementById("newPasswordError");

  const { error } = await sb.auth.updateUser({ password });

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  closeNewPasswordModal();
  alert("Password updated! You're logged in with your new password.");
}

/* ---------------------------------------------------------------------
   Realtime — reflect admin edits / other customers' purchases live
   --------------------------------------------------------------------- */
function subscribeRealtime() {
  sb.channel("storefront-products")
    .on("postgres_changes", { event: "*", schema: "public", table: "products" }, () => {
      loadProducts();
    })
    .subscribe();
}

/* ---------------------------------------------------------------------
   Init
   --------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  loadProducts();
  subscribeRealtime();
  initAuth();

  renderHeroSlides();
  restartHeroAutoplay();
  initNavbarScroll();
  initChatWidget();
  document.getElementById("heroPrev").addEventListener("click", () => goToHeroSlide(heroIndex - 1));
  document.getElementById("heroNext").addEventListener("click", () => goToHeroSlide(heroIndex + 1));

  document.getElementById("cartBtn").addEventListener("click", openCart);
  document.getElementById("closeCart").addEventListener("click", closeCart);
  document.getElementById("cartOverlay").addEventListener("click", closeCart);

  document.getElementById("checkoutBtn").addEventListener("click", openCheckout);
  document.getElementById("closeCheckout").addEventListener("click", closeCheckout);
  document.getElementById("checkoutOverlay").addEventListener("click", closeCheckout);
  document.getElementById("checkoutForm").addEventListener("submit", handleCheckoutSubmit);

  document.getElementById("closeConfirm").addEventListener("click", closeConfirm);
  document.getElementById("confirmOverlay").addEventListener("click", closeConfirm);

  document.getElementById("accountBtn").addEventListener("click", toggleAccountMenu);
  document.getElementById("myOrdersBtn").addEventListener("click", openMyOrders);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("accountMenu");
    const btn = document.getElementById("accountBtn");
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.remove("show");
  });

  document.getElementById("authCancelBtn").addEventListener("click", closeAuth);
  document.getElementById("authOverlay").addEventListener("click", closeAuth);
  document.getElementById("authForm").addEventListener("submit", handleAuthSubmit);
  document.getElementById("authSwitchBtn").addEventListener("click", () =>
    setAuthMode(authMode === "signup" ? "login" : "signup")
  );

  document.getElementById("forgotPasswordBtn").addEventListener("click", openForgotPassword);
  document.getElementById("forgotCancelBtn").addEventListener("click", closeForgotPassword);
  document.getElementById("forgotOverlay").addEventListener("click", closeForgotPassword);
  document.getElementById("forgotForm").addEventListener("submit", handleForgotSubmit);

  document.getElementById("newPasswordOverlay").addEventListener("click", closeNewPasswordModal);
  document.getElementById("newPasswordForm").addEventListener("submit", handleNewPasswordSubmit);

  document.getElementById("closeMyOrders").addEventListener("click", closeMyOrders);
  document.getElementById("myOrdersOverlay").addEventListener("click", closeMyOrders);
});
