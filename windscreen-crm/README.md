# GlassPro CRM

A mobile-first, offline-capable CRM for windscreen repair businesses.

## Features

- **Jobs** — create, track and update jobs with status progression
- **Customers** — full profiles with vehicle and job history
- **Vehicles** — linked to customers with reg, make, model
- **Invoices** — labour + parts pricing with optional 20% VAT
- **Offline support** — works with no internet via PWA service worker
- **Install to home screen** — works like a native app on iOS and Android

---

## Deploy in 5 minutes (free)

### Option A: Vercel (recommended)

1. Push this folder to a GitHub repository
2. Go to [vercel.com](https://vercel.com) and sign up free
3. Click **Add New Project** → Import your GitHub repo
4. Vercel auto-detects Vite — just click **Deploy**
5. Your app is live at `https://your-project.vercel.app`

### Option B: Netlify

1. Push this folder to a GitHub repository
2. Go to [netlify.com](https://netlify.com) and sign up free
3. Click **Add new site** → Import from Git → select your repo
4. Build command: `npm run build` / Publish directory: `dist`
5. Click **Deploy site**

### Option C: Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## Install as an app on your phone

Once deployed:

**iPhone/iPad:**
1. Open the URL in Safari
2. Tap the Share button (box with arrow)
3. Tap **Add to Home Screen**

**Android:**
1. Open the URL in Chrome
2. Tap the three-dot menu
3. Tap **Add to Home Screen** or **Install App**

The app will then work offline and feel like a native app.

---

## Custom domain

Both Vercel and Netlify let you add a custom domain (e.g. `crm.yourbusiness.co.uk`) for free in their dashboard settings.

---

## Data storage

All data is stored locally in the browser using `localStorage`. This means:
- Data persists between sessions on the same device
- Data is private to that device/browser
- To share data across multiple devices, you would need to add a backend (e.g. Supabase — ask for help if needed)

---

## Tech stack

- React 18
- Vite 5
- vite-plugin-pwa (Workbox) for offline/PWA support
- Zero external UI dependencies
