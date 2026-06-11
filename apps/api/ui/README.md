# Dashboard

Billing data has one source of truth: the server. Dashboard doesn't pretend otherwise. It's a pure API consumer with no CRDTs, no local state, no sync layer. Just a clean read of what Stripe and the hub already know.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  SvelteKit SPA (tabs, charts, plan picker)  │
├─────────────────────────────────────────────┤
│  TanStack Query (billing data + mutations)  │
├─────────────────────────────────────────────┤
│  Epicenter Hub API (/api, /auth, Stripe)    │
└─────────────────────────────────────────────┘
```

Unlike every other Epicenter app, there's no workspace here. Billing needs a single authority, so the dashboard fetches everything from the hub API and writes back through Stripe. The diagram is intentionally simple. That's the point.

---

## How it works

Auth gates the entire app via Google sign-in (`@epicenter/svelte/auth-form`). Once signed in, a tabbed UI shows three views: an overview with credit balance, usage-by-model charts (D3 + layerchart), and a top-10 models table; a model cost guide; and a billing activity feed.

Plan management sits below the tabs. Monthly/annual toggle, prorated charge preview, confirm to upgrade. "Buy 500 credits" opens a Stripe checkout session. "Manage billing" opens the Stripe billing portal.

---

## Development

Prerequisites: [Bun](https://bun.sh) and the hub API running locally (see `apps/api`).

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install

# Start the Worker first (must be running at localhost:8787)
cd apps/api
bun run dev

# Then start the dashboard (in another terminal)
cd apps/api/ui
bun run dev:local
```

Runs on port 5178. The Vite dev server proxies `/api` and `/auth` to `localhost:8787`.

```bash
bun run build    # Static output with /dashboard base path
```

---

## License

[AGPL-3.0](../../LICENSE). Most packages in this monorepo are MIT. This app is the exception.
