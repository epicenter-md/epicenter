# Your Script Names Should Tell You Which Database They'll Destroy

**TL;DR**: Suffix every database-touching script with `:local` or `:remote`. Commands that don't touch a database stay unsuffixed. Now there's no ambiguity about what a command will hit before you run it.

## The Problem

You're working on a Cloudflare Workers project. You have drizzle-kit for migrations and a Hyperdrive-connected Postgres database in production. Here's what your environment actually looks like:

```
Local Postgres          ◄── development, safe to nuke
Dev Branch DB           ◄── shared, Infisical-injected DATABASE_URL
Production via Hyperdrive ◄── env.HYPERDRIVE at runtime, not a URL
```

Three databases. One `drizzle-kit push` command. No indication which one it hits.

You're staring at `bun run db:push` and asking yourself: is this going to wipe my local schema, or is it going to push directly to the dev database that two other people are using? You don't remember which `.env` you have loaded. You don't remember if Infisical is injecting anything. You run it anyway because you're in a hurry.

That's the problem. The script name gives you zero information about blast radius.

## The Convention

Name every database-touching script with an explicit `:local` or `:remote` suffix. If a command doesn't actually connect to a database, leave it alone.

```json
"scripts": {
    "db:generate": "drizzle-kit generate",
    "db:drop": "drizzle-kit drop",
    "db:push:local": "drizzle-kit push",
    "db:migrate:remote": "infisical run --env=prod --path=/ops -- drizzle-kit migrate",
    "db:studio:local": "drizzle-kit studio",
    "db:studio:remote": "infisical run --env=prod --path=/ops -- drizzle-kit studio"
}
```

`db:generate` and `db:drop` have no suffix because they never touch a database. `db:generate` diffs your schema files and produces SQL. `db:drop` deletes a local migration file. Both are pure filesystem operations. Suffixing them would be noise.

Everything that connects to a database gets a suffix. Not every command needs both halves: `db:push:local` exists for fast iteration, but the corresponding `:remote` push is intentionally absent because schema changes against production go through versioned migrations (`db:migrate:remote`), not ad-hoc pushes.

## The Implementation

### `:local` scripts

`:local` scripts run `drizzle-kit` directly with no extra setup. The fallback chain in `drizzle.config.ts` does the rest:

```ts
dbCredentials: {
    url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
}
```

`LOCAL_DATABASE_URL` is a constant parsed from `wrangler.jsonc`'s `localConnectionString`:

```
postgres://postgres:postgres@localhost:5432/epicenter
```

If `DATABASE_URL` isn't set in the environment, drizzle-kit falls through to the local Postgres. `:local` scripts rely on that fallback being the only thing available, no secrets injected, no env vars set.

### `:remote` scripts

`:remote` scripts are prefixed with `infisical run --env=prod --path=/ops --`:

```
infisical run --env=prod --path=/ops -- drizzle-kit migrate
```

Infisical injects `DATABASE_URL` (and any other secrets) before the command runs. That URL points to the production Postgres. drizzle-kit picks it up because `process.env.DATABASE_URL` takes priority over the `LOCAL_DATABASE_URL` fallback.

### Why there is no `dev:remote`

You might expect a parallel `dev:remote` that wraps `wrangler dev` with `infisical run`. There isn't one, by design. A development server pointing at production data is a category error: there's no use case for it that isn't better served by either (a) running real migrations against prod via `db:migrate:remote`, or (b) deploying.

The bare `dev` script is the single sensible local workflow. It still requires Infisical login because the API needs dev secrets like API keys and the auth secret, but it never touches production data at runtime: Wrangler's Hyperdrive binding (`localConnectionString` from `wrangler.jsonc`) routes the connection to local Postgres. Required secrets come from the Infisical-spawned `process.env`, and the local public origin is passed with `wrangler dev --var API_PUBLIC_ORIGIN:http://localhost:8787`; no `.dev.vars` file is produced.

```json
"dev": "bun scripts/dev.ts"
```

Inside that script: `infisical run --silent --env=dev --path=/api -- wrangler dev --var API_PUBLIC_ORIGIN:http://localhost:8787`. One command, one workflow, no `:remote` variant.

## The Three-Layer Strategy

```
┌──────────────┬────────────────────────────────────┬──────────────────────────────────┐
│ Layer        │ Source                             │ Used By                          │
├──────────────┼────────────────────────────────────┼──────────────────────────────────┤
│ Local        │ wrangler.jsonc localConnectionString│ :local scripts, contributors     │
│ Migration    │ Infisical DATABASE_URL              │ :remote scripts                  │
│ Runtime      │ Hyperdrive env.HYPERDRIVE           │ Production worker                │
└──────────────┴────────────────────────────────────┴──────────────────────────────────┘
```

The production worker never uses `DATABASE_URL` directly. It uses `env.HYPERDRIVE`: the Cloudflare binding, which handles connection pooling and routing through Hyperdrive's edge network. So there's no single URL that can target production directly from drizzle-kit. That's intentional.

## Who `:remote` Is For

`:remote` is not "development on a remote branch." It is production administration. The `infisical run --env=prod --path=/ops --` prefix injects the live `DATABASE_URL`, and the script runs against the same Postgres that real users hit. Treat every `:remote` command as a deploy-class action.

That means `:remote` is for team members with Infisical prod access only. Outside contributors run `:local` scripts against their own Postgres, write migrations, open PRs. A maintainer with prod access applies the migration via `db:migrate:remote`.

The flow looks like this:

```
:local   → localhost Postgres                       → your machine only
:remote  → production Postgres (Infisical prod env) → team members only
deploy   → Hyperdrive → production runtime          → real users
```

Three environments, three levels of blast radius. `:local` can't break anything beyond your machine. `:remote` reaches prod data and is admin-only. And the production worker itself only reaches prod through Hyperdrive at runtime: no URL you can accidentally paste into a drizzle-kit command from the running app.

If you want a shared dev branch (PlanetScale, Supabase, Neon), add a third environment in Infisical and a separate suffix (`db:migrate:dev`, for example). Don't blur it into `:remote`. The suffix names the blast radius; making `:remote` mean two different things defeats the whole point.

## The Contributor Experience

Someone clones the repo for the first time. They have no Infisical access. Here's all they need:

```bash
# Spin up local Postgres
docker run -d -p 5432:5432 -e POSTGRES_DB=epicenter postgres

# Push the schema locally
bun run db:push:local

# Open Drizzle Studio against the local DB
bun run db:studio:local
```

Zero secrets. Zero environment setup. The `:local` scripts work because the fallback is hardcoded in `drizzle.config.ts`. They can write migrations and inspect schema locally without ever touching Infisical.

Running the full API server (`bun run dev`) still requires Infisical access because the app needs real API keys and the auth secret. But schema work, migration authoring, and Drizzle Studio against a clean local DB are all available before the contributor is added to Infisical. When they're ready to write a real migration against production, they get Infisical prod access and use `db:migrate:remote`.

## The Pattern This Replaces

The old way looks like this:

```json
"scripts": {
    "db:push": "drizzle-kit push",
    "db:push:dev": "DATABASE_URL=$DEV_URL drizzle-kit push"
}
```

Problems here. Which `.env` is loaded? What's `$DEV_URL`? Is it set? Did someone source the wrong file? You end up with a mental checklist you have to run before every database command. You forget steps. Things break.

Or worse, there's just one script and the URL is controlled entirely by which `.env` file you have loaded. There's no signal in the command itself about what it targets.

## The Pattern That Works

```json
"db:push:local": "drizzle-kit push",
"db:migrate:remote": "infisical run --env=prod --path=/ops -- drizzle-kit migrate",
```

Now the command is self-documenting. `db:push:local` cannot accidentally hit the remote database: drizzle-kit will only see `LOCAL_DATABASE_URL`. `db:migrate:remote` cannot accidentally hit local: Infisical injects the real URL and that takes priority. The asymmetry between `push:local` and `migrate:remote` is intentional: fast ad-hoc pushes are fine for the schema you can nuke, but production gets versioned migrations.

The suffix is not just a label. It enforces the behavior.

## Trade-offs

| Approach | Self-documenting | Blast radius explicit | Works without secrets |
|----------|------------------|-----------------------|-----------------------|
| Single script + `.env` | No | No | Depends on `.env` |
| Suffix convention | Yes | Yes | `:local` always works |

The one downside: you type more characters. `db:push:local` is longer than `db:push`. That's the whole trade-off. Given that the alternative is accidentally running a migration against a shared database, it seems worth it.

## The Golden Rule

**If a script connects to a database, the script name should tell you which one.**

Unsuffixed database commands are a footgun. You will forget which environment is active. The suffix isn't documentation. It's enforcement. `:local` scripts are wired to local Postgres. `:remote` scripts require secrets to run. The naming convention makes the blast radius visible before you hit enter.

---

_See also: [The Three Tiers of Database Latency](./database-latency-tiers.md): where Hyperdrive fits in the latency picture_
