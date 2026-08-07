# Brass & Thread + ShopTrack — Deployment Guide

Sundin lang nang paisa-isa. Wala kang kailangang i-install — browser mo lang.
Yung mga account sa Step 1 at Step 4 ay libre (free tier).

---

## Step 1 — Gumawa ng Supabase project (ito ang backend/database mo)

1. Pumunta sa **[supabase.com](https://supabase.com)** → **Start your project** → mag-sign up (libre).
2. **New Project** → bigyan ng pangalan (hal. `brass-and-thread`), gumawa ng database
   password (i-save mo sa notes mo — hindi na ito gagamitin sa code, pero i-save
   mo lang), piliin ang region na malapit sa Pilipinas (hal. Singapore).
3. Hintayin ~2 minuto habang ginagawa ang project.

## Step 2 — I-set up ang database tables

1. Sa sidebar, pumunta sa **SQL Editor** → **New query**.
2. Buksan ang [supabase-schema.sql](supabase-schema.sql) mula dito sa project mo,
   kopyahin lahat ng content, i-paste sa SQL Editor.
3. I-click **Run**. Dapat "Success" — gumawa na ito ng `products` at `orders`
   tables, mga security rules, at nag-seed ng 8 sample overrun shirts.

## Step 3 — Gumawa ng admin login

1. Sidebar → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Ilagay ang email at password na gagamitin mo bilang **ShopTrack admin**
   (hal. `owner@brassandthread.com` / sarili mong password). I-check ang
   "Auto Confirm User" kung available.
3. Ito na ang ilalagay mo sa login form ng ShopTrack admin dashboard.

## Step 4 — Kunin ang API keys mo

1. Sidebar → **Project Settings** (gear icon) → **API**.
2. Kopyahin ang dalawang value:
   - **Project URL**
   - **anon public** key
3. Buksan `site/config.js` **at** `site/admin/config.js` dito sa project mo,
   palitan ang placeholder values ng dalawang value na kopya mo:

   ```js
   const SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....";
   ```

   (Same values sa dalawang files.)

## Step 5 — Subukan muna lokal

1. I-double click `site/index.html` — dapat mabuksan sa browser mo at
   makita mo ang mga overrun shirts (nangailangan ng internet dahil
   kumokonekta ito sa Supabase mo).
2. Subukan mag-add to cart at mag-checkout — dapat gumana ang buong flow.
3. I-double click `site/admin/index.html`, mag-login gamit ang email/password
   mula Step 3 — dapat makita mo ang bagong order at ang bawas na stock.

Kung may error: buksan ang browser DevTools (F12) → tab na **Console** —
karamihan ng error ay typo sa `config.js` o hindi pa na-Run ang SQL script.

## Step 6 — Kunin ang public link (Netlify)

1. Pumunta sa **[app.netlify.com/drop](https://app.netlify.com/drop)**
   (walang account na kailangan para sa unang try).
2. I-drag ang **buong `site` folder** (yung isa na may `index.html` sa loob,
   hindi ang `ShopTrack` root folder) papunta sa page na iyon.
3. Maghihintay ng ilang segundo, tapos bibigyan ka ng link na parang
   `https://xxxxx-xxxxx.netlify.app`.
   - Storefront: `https://xxxxx-xxxxx.netlify.app/`
   - Admin: `https://xxxxx-xxxxx.netlify.app/admin/`

> **Tip:** gumawa ng libreng Netlify account (may button na "Sign up to
> save this site") kung ayaw mong mawala ang link pagkatapos ng ilang oras,
> at para pwede mo na lang i-drag ulit ang folder kapag may binago ka.

---

## Update — Optional Customer Accounts

Ang storefront ay may **optional** na "Log In" ngayon (pwede mag-order
kahit walang account — guest checkout gumagana pa rin). Kailangan lang
mo i-run ito **once** para gumana ito nang tama:

1. Buksan ang [supabase-schema-optional-login.sql](supabase-schema-optional-login.sql).
2. Hanapin ang linyang ganito:
   ```sql
   select id from auth.users where email = 'PASTE-YOUR-ADMIN-EMAIL-HERE'
   ```
   Palitan ang `'PASTE-YOUR-ADMIN-EMAIL-HERE'` ng email na ginamit mo sa
   Step 3 (yung ShopTrack admin account mo).
3. Kopyahin ang buong file, i-paste sa Supabase → **SQL Editor** → **New
   query** → **Run**.
4. Subukan: buksan ang storefront, i-click ang **"Log In"** sa navbar →
   **"Sign Up"** para gumawa ng test customer account → mag-order → i-click
   ulit ang account button (ngayon "Hi, [pangalan]") → **My Orders** —
   dapat makita mo lang ang orders ng account na iyon.
5. I-double check din sa ShopTrack admin dashboard mo na gumagana pa rin
   ang login mo — kung "Mali ang email o password" o walang makita, ibig
   sabihin hindi na-match ang email sa Step 2 sa totoong admin email mo.

**Bakit kailangan ito:** dati, "may login session" = admin palagi. Ngayon
na pwede na rin mag-login ang customers, hiniwalay na ng migration na ito
ang "admin" (may nakalistang entry sa bagong `admins` table) sa ordinaryong
customer account — kaya makikita lang ng bawat customer ang sariling
orders, at ikaw lang bilang admin makikita/makaka-edit ng lahat.

---

## Update — Forgot Password + Real Email Requirement

Customer accounts (Sign Up) at ang bagong **"Forgot password?"** link ay
umaasa sa email na aktwal na naka-verify ng Supabase mismo — kaya
importanteng i-check ang dalawang setting na ito **isang beses**:

1. Supabase dashboard → **Authentication → Sign In / Providers** →
   siguraduhing **naka-ON** ang **"Confirm email"** — dito ang dahilan
   kung bakit hindi puwedeng basta-basta gamitin ng customer ang fake
   email: hindi sila makaka-Log In hangga't hindi na-click yung
   confirmation link na pinadala sa totoong inbox nila.
2. Supabase dashboard → **Authentication → URL Configuration** → idagdag
   sa **Redirect URLs** ang totoong Netlify link mo, hal.
   `https://brassthread.netlify.app/*` — kailangan ito para gumana nang
   tama ang "Forgot password" reset link (kung wala ito, maaaring
   maipadala pero mag-redirect sa maling lugar o mag-error).

Wala nang idadagdag pang code dito — mga setting lang ang babaguhin sa
Supabase dashboard.

---

## Update — Order Status Email Notifications

Kapag binago ng admin ang fulfillment status ng isang order (Processing →
Out for Delivery → Delivered, o Cancelled), automatic na maka-email ang
customer. Setup ito, may 4 na parte:

### Part 1 — Gumawa ng Resend account (libreng email service)

1. Pumunta sa **[resend.com](https://resend.com)** → Sign up (libre, 100
   email/day, 3,000/buwan).
2. Sa dashboard → **API Keys** → **Create API Key** → kopyahin yung key
   (nagsisimula sa `re_...`) — makikita mo lang ito **isang beses**, i-save
   mo agad.
3. Hindi mo na kailangan i-verify ang domain para sa demo — may built-in
   silang test sender (`onboarding@resend.dev`) na pwedeng mag-email sa
   kahit kanino, walang setup.

### Part 2 — I-deploy ang Edge Function

1. Sa Supabase dashboard → sidebar → **Edge Functions** → **Create a new
   function**.
2. Pangalanan: **`send-order-email`** (eksakto ito, kasi ito yung tatawagin
   ng database trigger sa Part 4).
3. Buksan ang [supabase/functions/send-order-email/index.ts](supabase/functions/send-order-email/index.ts)
   dito sa project mo, i-select all + copy, i-paste sa editor ng Supabase
   (papalit sa placeholder code nila).
4. Kung may option na **"Verify JWT"** o "Enforce JWT verification" —
   **i-OFF/uncheck mo ito** (may sariling secret-check na ang function na
   ito, hindi na kailangan ng Supabase JWT dahil isang database trigger
   ang tumatawag dito, hindi isang naka-login na browser).
5. **Deploy**.
6. Pumunta sa **Edge Functions → Manage secrets** (o "Secrets" tab), idagdag
   ang dalawa:
   - `RESEND_API_KEY` = yung key mula Part 1
   - `WEBHOOK_SECRET` = kahit anong random na text na gagawin mo (hal.
     `bt-webhook-8x2k9m` — sarili mong gawa, basta tandaan mo, gagamitin
     ulit sa Part 4)

### Part 3 — Kunin ang Project Reference ID mo

Settings → General → **Reference ID** (yung ID na ginamit mo na dati para
sa Project URL — `https://<reference-id>.supabase.co`).

### Part 4 — I-run ang trigger SQL

1. Buksan ang [supabase-schema-order-email-trigger.sql](supabase-schema-order-email-trigger.sql).
2. Palitan ang:
   - `YOUR-PROJECT-REF` → yung Reference ID mula Part 3
   - `YOUR-WEBHOOK-SECRET` → yung **eksaktong** parehong value na inilagay
     mo bilang `WEBHOOK_SECRET` sa Part 2, Step 6
3. Select all, copy, paste sa **SQL Editor** → **Run**.

### Subukan

1. Pumunta sa admin Orders tab, palitan ang Fulfillment ng isang order
   (halimbawa papuntang "Out for Delivery").
2. Tignan ang email address na nakalagay sa order na iyon — dapat may
   dumating na email sa loob ng ilang segundo.
3. Kung walang dumating: Supabase dashboard → **Edge Functions →
   send-order-email → Logs** — makikita mo dun kung ano ang error (mali
   ba yung secret, o may isyu sa Resend key).

---

## Paalala tungkol sa security

- Ang **anon key** ay talagang OK na makita ng publiko sa code — ganito
  talaga gumagana ang Supabase. Ang totoong proteksyon ay nasa Row Level
  Security policies (nasa `supabase-schema.sql`): pwedeng basahin ng lahat
  ang products, pero ang pag-edit ng inventory at pagtingin/pag-update ng
  orders ay kailangan ng admin login lang.
- **HUWAG** kopyahin ang **`service_role`** key kung saan man — ito ang
  key na nag-bypass ng lahat ng security, dapat lang siya nasa server,
  hindi sa isang website na binabasa ng browser.
- Ang checkout (`place_order`) ay isang database function na tumatakbo
  sa loob ng isang transaction — dinodouble-check muna ang stock bago
  bawasan, kaya hindi mauubos ng dalawang customer ang parehong last unit
  nang sabay-sabay.

## Kung gusto mong palitan ang design

- Fonts, colors: `site/style.css` at `site/admin/style.css` (tokens nasa
  taas ng file, `:root { ... }`).
- Copy/text: sa `site/index.html`.
- Sample catalog: i-edit/i-delete/i-add na lang sa Inventory tab ng admin
  dashboard mismo — hindi na kailangan bumalik sa code.
