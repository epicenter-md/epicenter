# Positioning

Canonical positioning for Epicenter. This doc owns the public claims and the rules for deriving copy from them. Finished copy belongs to the surface that ships it: README, landing page, GitHub About, package metadata, or launch plan.

## The Destination

The product picture all messaging derives from. This section describes the end state, not public copy. Public copy quotes the Spine. The Destination is the compass, never quoted directly.

One person owns one logical Epicenter: their notes, settings, documents,
conversations, and history, together in one database. Each of their devices
keeps one full SQLite replica of it, with media and attachments beside it.
Every trusted Epicenter app works with that same database through its own
release-local, identity-free lens: a transcription app, a notes app, a tab
manager, each a different way of working with the same underlying data.

```txt
        Whispering   Notes   Tabs   ...trusted apps
              \        |       /
               one logical Epicenter
              /        |       \
        laptop      phone      desktop
     (SQLite replica on each device)
```

The inversion this buys: the database belongs to the person, not the
application. Apps do not own databases inside a person's Epicenter, not
physical ones and not named logical ones. Projects, notebooks, and collections
are rows. When an app changes or disappears, the person's work, memory, and
accumulated context stay useful, because they never lived inside the app.

Shared local context is the payoff, twice over. More private, because the data
stays on the person's devices instead of scattering across vendor clouds. More
personal, because each app can see the context the others created: your
transcripts can inform your notes, your saved tabs can become drafts, and an
assistant can work across all of it without an integration per app.

Precision rule: "one database per person" is the product shorthand, and it is
the shorthand to lead with. The technical claim behind it stays exact: one
Epicenter per selected owner (a person's account, a self-hosted instance, or
an explicit local owner), one SQLite replica per device, synchronized through
that owner's server. Trusted apps are not permission boundaries; a real
security boundary requires another principal or another deployment. Copy may
compress; it may not conflate one person's Epicenter with an account holding
many named databases.

What we refuse to build is the strategy. No second database identity beneath
the person: no per-app databases, no named logical databases, no database
catalog. No partial sync: a device replicates the whole Epicenter, which is
what keeps sync simple and the local copy complete. One validated write path:
apps and agents mutate data through typed APIs, and the live database stays
inspectable read-only rather than becoming a free-for-all write surface. Each
refusal pays for the simplicity of everything else.

## The Spine

One message, cut to length and audience. Longer cuts add detail. No cut contradicts a shorter one, and every claim from a shorter cut survives in the longer cuts.

One line, for one-line surfaces (GitHub About, social preview, link cards):

> Local-first apps that share one database you own.

The hero cut, for the root README hero:

> **What if you could manage your entire digital life in one SQLite database?** Epicenter is a collection of local-first apps built around a simple inversion: the database belongs to the person, not the application.

One paragraph, for anyone giving us thirty seconds (website about page, CONTRIBUTING, talk bios):

> Most apps keep your data in their own cloud database. Epicenter inverts that: one person owns one database, every device keeps a full local SQLite copy of it, and each app is a different way of working with the same data. Your notes, settings, conversations, and history stay together on your machines and outlive any app that touched them. Start with Whispering, our speech-to-text app.

The developer cut, for `@epicenter/workspace` and other toolkit surfaces (npm, package READMEs, technical talks):

> A local-first data layer for TypeScript apps: typed tables and KV over per-device SQLite, lazy Yjs documents for collaborative content, and sync through a server you can self-host.

The public cut, for epicenter.so and other general-audience surfaces:

> Apps come and go. What you make with them should stay yours. Epicenter apps keep everything you create in one place that belongs to you, on your own devices, so your work outlives every app that made it.

The developer and public cuts are the only cuts with their own framing. The developer cut exists because npm readers evaluate an API, not a product. The public cut exists because epicenter.so readers are not evaluating an architecture: it restates the one-line cut with the vocabulary translated. SQLite, local-first, CRDT, and Yjs stay out of public heroes; on a public surface the mechanism appears below the fold, after the benefit it guarantees, never as the headline. (The README hero is the one deliberate exception: its audience is technical, and "one SQLite database" is the concrete claim that earns the read.)

Headlines, tweets, launch posts, and package copy derive from these cuts but live in the surface that publishes them. If a derived surface needs a claim the spine does not make, fix the spine first.

## The Hook

The long-form narrative, for surfaces with room to breathe (landing page body, launch posts, talks). It extends the spine with the claims the short cuts cannot carry: apps share one person's context, and that context compounds.

The conventional model is one database per app, run by the vendor. Every app
you adopt opens another silo; every app you abandon strands another slice of
your life. Epicenter is built on the opposite premise: one person, one
Epicenter. Your devices each hold a full SQLite replica. Apps bring typed
lenses to that shared database instead of bringing their own database. So the
transcription app and the notes app are not two silos with an export button
between them; they are two views of one corpus that belongs to you.

Under the hood, bounded rows live in SQLite for fast local queries; each row
can own a lazy Yjs document for collaborative rich content; media lives beside
the database as ordinary files. You can open your own live database read-only
and query it with plain SQL, and take a complete portable export whenever you
want. Sync runs through your account's server: hosted Epicenter if you want
convenience, self-hosted if you want the server in your hands. The relay reads
plaintext either way; privacy is a topology choice, not an encryption layer.

## The Proof Line

Every shipped surface longer than one line carries exactly one proof line, stated without caveats. The proof line is a claim, not finished copy: each surface writes its own sentence, in keeping with the rule that finished copy belongs to the surface that ships it. The sentence must carry:

- Whispering, by name
- speech-to-text
- you can use it today
- where it runs: the browser at whispering.epicenter.so, and natively inside the Epicenter desktop app

Roadmap language stays out of heroes. The one-database destination is ahead of the implementation, so surfaces that lead with it must carry an explicit status boundary ("what we are building" or equivalent) before making behavior-shaped claims. In a hero, hedging kills the read; immediately after the hero, honesty about status is mandatory.

## Earned Vocabulary

Some words are internal until the surface earns them. Do not use a term before the reader has seen the thing it names.

| Term | Earned by |
|---|---|
| Epicenter (the database) | showing the one-database diagram or model first |
| replica | one defining clause at first use: "a full local copy on each device" |
| lens | one defining clause at first use: "the typed view an app brings to your data" |
| owner | technical surfaces only; general copy says "you" or "your account" |
| portable artifact / `.epicenter` export | showing what an export contains |
| workspace | retired from destination copy; names old code only |

Do not use "substrate", and do not describe Epicenter as generic infrastructure. Epicenter is a collection of real apps that also builds its own data layer; lead with the apps and the person, not the layer.

Do not use hype words: `AI-native`, `agentic`, `next-gen`, `revolutionary`, `redefine`, `game changer`, `Web3`, `metaverse`. Do not stack buzzwords. "CRDT-powered AI-first encrypted next-gen offline-first workspace" is a sign to say less and prove more.

## What Epicenter Is

- An **open-source collection of local-first apps** that share one database per person
- A **TypeScript data layer** (`@epicenter/workspace`) for typed tables and KV over SQLite, with lazy Yjs documents for collaborative content
- A **CLI** (`epicenter`) for local workflows against the same data
- A **sync server** (AGPL, self-hostable) that orders one person's changes across their devices

## What Epicenter Is Not

- Not a single app (many purpose-built apps, one shared database)
- Not cloud-first (local-first by default; sync is optional and yours to place)
- Not per-app storage (apps bring lenses, never their own databases)
- Not a Notion or Obsidian clone (it is the apps plus the data layer beneath them)

## Core Claims

Shipped claims, provable by inspecting the repo today:

| Claim | Proof |
|---|---|
| "We ship" | Whispering runs in the browser at whispering.epicenter.so and as a native surface inside the Epicenter desktop host. |
| "Local-first" | App state persists on-device; the apps work offline and sync is optional. |
| "Self-hostable" | The server library is AGPL with a community single-partition reference deployable (`apps/self-host`). |
| "Bring your own model" | AI features accept user-provided endpoints and API keys. |
| "Trusted relay, not an encryption layer" | Sync reads plaintext at the relay. Privacy comes from who runs the server. See `docs/trust-model.md`. |

Destination claims, decided and recorded but still being implemented (Proposed ADRs 0160 through 0182 and the one-Epicenter clean-break spec own them):

| Claim | Decision record |
|---|---|
| "One person, one Epicenter" | ADR-0160 |
| "One SQLite replica per device, media beside it" | ADR-0161 |
| "Open your live database read-only; query one stable `rows` relation" | ADR-0161, ADR-0163 |
| "Complete portable export you can edit" | ADR-0162, ADR-0165 |
| "Apps bring identity-free lenses, never databases" | ADR-0172 |

A surface may state a destination claim only beside an explicit status boundary. No surface claims that arbitrary direct writes to the live database synchronize; synchronized writes go through the typed API, and deliberate offline editing belongs to the portable export.

## Competitor Positioning

### vs Obsidian
> Obsidian is a Markdown editor with sync. Epicenter is a collection of apps that share one database owned by the person, with Markdown projections where files are the right interface.

- **Win**: Structured, queryable, app-shared data with CRDT sync; not per-plugin storage.
- **Lose**: Obsidian's plugin ecosystem and years of UX polish. We're earlier.

### vs Anytype
> Anytype is an encrypted space ecosystem with its own protocol. Epicenter is one SQLite database per person, standard Yjs for collaborative content, and apps as lenses.

- **Win**: Standard stack (SQLite, Yjs), plain-SQL inspectability, developer-facing typed API.
- **Lose**: Anytype's product is more complete today; their P2P story is more mature.

### vs Notion
> Notion is where your knowledge lives. Epicenter is where your knowledge stays.

- **Win**: Offline-first, local-first, open source, no cloud lock-in.
- **Lose**: Notion's UX, templates, collaboration, and distribution are years ahead.

### vs Jazz
> Jazz syncs slices of a shared database to many users. Epicenter gives one person one whole database, fully replicated on their own devices.

The two stacks converged on typed tables, local-first writes, and collaborative text from opposite premises. Jazz is a multi-user relational database with partial replication and row-level permissions. Epicenter is hyper-focused on one person, so a device replicates the whole Epicenter, apps are trusted lenses rather than tenants, and we refuse partial sync and row permissions on purpose. That refusal is what lets us build on SQLite and standard Yjs instead of a custom sync engine. See [the long form](articles/20260531T160000-i-kept-reinventing-jazz-the-win-is-what-we-refuse.md).

- **Win**: One database you own, plain SQL without the app, standard Yjs, less to learn because the scope is smaller.
- **Lose**: Jazz scales to large shared datasets and multi-user access that Epicenter deliberately won't. For a synced multi-user app database, Jazz is the better tool and further along.

Matter keeps its own positioning ("a folder of Markdown, queryable as SQLite", ADR-0065); it is a standalone disk-as-truth tool and does not derive from the one-database spine. Trigger to split: if Competitor Positioning stops deriving from the spine or grows beyond quick battlecards, move it into its own competitor file.

## Package Copy

Each package's npm description and keywords live in its `package.json`; that file is the owner and this doc does not duplicate it. The rule when writing one: user-facing packages derive from the user cuts of the spine, `@epicenter/workspace` derives from the developer cut, and every description leads with what the package does, not what category it is in.

Trigger to revisit: if package descriptions drift off-spine again, add a check script.
