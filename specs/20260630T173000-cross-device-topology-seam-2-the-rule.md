# Cross-device topology: seam 2 and the rule for placing owned data

- **Status:** Draft
- **Date:** 2026-06-30
- **Relates:** ADR-0079 (cross-device is two planes), ADR-0061 (Local Books three tools), ADR-0072 (Local Books standalone CLI), ADR-0073 (the relay floor), ADR-0078 (inference is a URL-addressed connection), ADR-0075 (self-host is a single-partition instance), ADR-0004 (the relay reads plaintext), ADR-0068 (privacy is a deployment)
- **Nature:** A grounded design note that re-tests ADR-0079's seam-2 rejections from current facts, draws the email-shaped extension ADR-0079 never drew, and surfaces the one product question the founder must answer. It does not settle a durable decision, so it stays a spec. When the founder answers the open question, the answer becomes an ADR and this spec is deleted.

This note re-derives the cross-device architecture from first principles, verifies the live transport facts against current docs and code, and ends with one recommendation and one product question. The short version: ADR-0079 is correct, seam 2 is not uniform, the rule for placing a dataset is `dataset-vs-operation` gated by `sensitivity x offline-value x who-can-operate-the-overlay`, and the whole open question collapses to "is offline reading of owned data a committed product goal."

---

## 1. A corrected map of where the design actually sits

The inherited analysis is substantially right. Four corrections, all verified.

**Right: the "everything box" already ships as separate processes.** Self-host is one pinned partition behind one operator bearer (ADR-0075), and the `local-books daemon` is a standalone binary serving `/mcp` (daemon.ts). The capability plane is not a new exotic mechanism; it is these existing processes reached directly, plus a tiny synced directory doc that carries addresses only (directory/index.ts, `noSecret` invariant). "Collapse to one box" is closer to what already ships than to a radical rebuild.

**Right: the NAT rendezvous is physics and cannot be deleted.** A NAT'd home box accepts no inbound connection, so a phone on cellular always needs a publicly addressed rendezvous both sides dial out to (ADR-0079 line 11). Every transport is a different placement of this same un-removable rendezvous. The fan-out confirmed it relocates onto Tailscale's DERP, onto iroh's relay+discovery, onto Cloudflare's edge, or onto a rented VPS, but never vanishes.

**Right: Yjs earns its keep only for multi-writer mergeable data.** Single-writer data (the Local Books mirror) stays the box's SQLite, never Yjs (ADR-0079 line 17). Last-write-wins silently loses data on an offline merge, which is the stated reason to keep Yjs on the sync plane and to refuse it for the box's single-writer state.

**Correction A: the directory is mildly ahead of demand, but it is not the over-build the relay floor was.** The floor had zero end-to-end consumers and is already on its deletion path (PR #2237 merged the dispatch decommission; ADR-0079 line 39 lists the channel layer as deletable once Whispering is wired into sync). The directory, by contrast, is one `defineWorkspace` reusing existing Yjs+IndexedDB+WebSocket machinery, with real value at `n` boxes. At `n=1` a single pasted address does the same job, so the directory is a v1 convenience, not a launch requirement. This is a smaller smell than the floor, not the same smell.

**Correction B (the important one): seam 2 is not what ADR-0079 fully settled.** ADR-0079 settled Local Books decisively (tools-only, never materialized, line 56). It never treated email. Email is the case that breaks the Local Books rule, because offline reading is the headline feature of a mail client and a mailbox is both large and sensitive. The open crux is email-shaped, and the right output is a placement rule, not a single answer for both apps.

**Correction C: the "tools-only is confidential because the tailnet ACL is the authz" story has a verified hole.** See section 6. The daemon's `/mcp` is cross-origin write-triggerable today, even tailnet-private. This does not change the topology, but it sharpens ADR-0079's claim that a box bearer only becomes load-bearing on public exposure: a thin write-guard is needed even on the private tailnet.

---

## 2. Seam 1 (sync plane): confirmed, and one honest mismatch

Seam 1 is coherent and minimal as designed. Epicenter Cloud syncs the Yjs CRDT across a user's devices over a plain authenticated WebSocket to a hibernatable per-user anchor, gated on Epicenter sign-in (ADR-0079 decision 1). This is the paid product, the Obsidian-Sync analog, and it is the right home for data that is multi-writer, mergeable, not-too-large, and not-too-sensitive: notes, settings, app state, the boxes directory itself. Epicenter sees this data by design (ADR-0004), which is the hosted-sync deal the user already accepts. The wedge (Whispering) needs exactly this plane and nothing from seam 2, so the highest-leverage next build is wiring Whispering into sync, which depends on none of the capability plane (ADR-0079 line 43). Nothing here is heavier than it needs to be.

The one honest mismatch to surface: the founder's seam-1 promise, "I log in and all my data syncs," is **false for seam-2 data** under any confidential design. Books and email do not ride the sync plane, so "all my data" must be read as "all my light, mergeable, non-sensitive data." That is not a bug, it is the confidentiality line doing its job, but it must be said out loud in any user-facing copy so "my books did not sync to my phone" is a documented choice, not a surprise.

---

## 3. Seam 2: four topology-bearing visions

The data in question is a QuickBooks ledger or a Gmail mailbox: potentially too large to sync, too sensitive for the operator-readable plane, and read-heavy with real offline value (for mail). Four visions carry distinct topologies. The fifth option, the placement rule, is the recommendation (section 5), not a topology of its own.

Legend for the diagrams: `==>` is a direct device-to-box call over the user's overlay (Epicenter not in path); `-->` rides the Epicenter sync plane (operator-readable); `[!]` marks plaintext visible to a third party.

### V1: Tools-only box (ADR-0079 default for Local Books)

**User story:** "I ask my books or search my mail from any device, and a question and its answer cross the wire, never the ledger."

```
  phone (native)                          home box (Mac Studio)
  +------------+    MCP tools/call ==>     +----------------------+
  | agent loop | ----------------------->  | /mcp airlock         |
  | holds only |    <== answer only        | SQLite mirror + QB   |
  | ANSWERS    |                           | (data never leaves)  |
  +------------+   rendezvous: Tailscale   +----------------------+
                   DERP (content-blind)
  discovery: boxes directory --> sync plane (address only, no secret)
```

**Deletion prize:** nothing new to delete; this is what ships. Going forward it refuses to build the V2 cache engine, the iroh/broker tracks, and any per-app materialization machinery.

**User loss:** no offline access to heavy or sensitive data; the device holds only answers, so on a dead subway the app returns nothing. Reaching the box needs an overlay client, which is friction for a non-developer (ADR-0079 line 42).

**Transport:** Tailscale Serve (native on tailnet); Funnel only if a browser off the tailnet must reach it.

### V2: Bounded confidential hot-cache on the capability plane

**User story:** "My phone keeps a recent window of my mail and books, refreshed by my box directly, so I read offline; Epicenter never sees it, and older items still come live."

```
  phone                                    home box
  +------------------+   window push ==>   +----------------------+
  | recent-N window  | <-----------------  | CDC mirror + fan-out |
  | AT REST [!OS]    |   (E2E to box)      | engine (NEW)         |
  | + live tail ====================>      | /mcp for older items |
  +------------------+                     +----------------------+
   rendezvous: Tailscale DERP        discovery: directory --> sync plane
   [!OS] = at rest, leaks to iCloud/Google backup unless excluded
```

**Deletion prize:** none; this is the maximal build. It deletes the dead-subway failure mode and the need for a per-app fork, but it adds a box-owned replication, windowing, eviction, and freshness subsystem.

**User loss:** a new confidentiality-at-rest surface (see section 6) and a box-owned sync engine to maintain. The cache is useless to a user who cannot operate the overlay, so it inherits V1's reachability friction and amplifies it (a stale cache that cannot refresh is worse than no cache).

**Transport:** the same capability overlay as V1, plus a box-side fan-out engine. Crucially this rides the capability plane, never the operator-readable sync plane, so the confidentiality line holds in transit.

### V3: Materialize into the Epicenter sync plane

**User story:** "Everything syncs through Epicenter like my notes, so it is offline everywhere and uniform."

```
  phone                  Epicenter sync anchor              home box
  +--------+   ledger/mail [!]   +-----------------+   [!]   +--------+
  | local  | <----------------->  | operator-      | <-----> | source |
  | replica|     (plaintext to    | readable plane |         | (opt.) |
  +--------+      the operator)    +-----------------+         +--------+
            books_report (live QB) and recategorize (write-through) CANNOT sync
```

**Deletion prize:** the largest by far. The boxes directory, the daemon's cross-device `/mcp`, the overlay dependency, and the entire NAT apparatus all disappear. One plane, one trust line.

**User loss:** the financial ledger and email bodies transit the operator-readable plane in plaintext (ADR-0004), which is the exact data the design keeps off the Epicenter path. Two of Local Books' three tools cannot be materialized at all: `books_report` is a live QuickBooks call and `recategorize` writes through to Intuit (ADR-0061), so Epicenter would have to absorb the QuickBooks integration server-side and hold every user's Intuit token, becoming an always-on compute operator and a single honeypot. Box-local model privacy dies.

**Transport:** the existing sync WebSocket plus a new snapshot/blob channel for single-writer data (a Y.Doc of a multi-GB mailbox is a memory bomb on the anchor).

### V4: All-in tools-only (uniform refusal)

**User story:** "Light mergeable things sync; everything heavy or sensitive stays on my box and I reach it live, with no offline copy anywhere."

```
  Same topology as V1, applied as a UNIFORM RULE to every heavy/sensitive app.
  Sync plane carries only light, mergeable, non-sensitive CRDT.
  No device ever holds a dataset at rest.
```

**Deletion prize:** approximately nothing new. The relay-floor deletion it would claim is already booked by ADR-0079's Whispering-sync trigger, independent of this choice. V4 is a refusal to build the cache engine, not a deletion of existing code.

**User loss:** no offline for any heavy data, forever. As a permanent product rule this ships a non-competitive mail client (offline reading is the headline feature). As a build state for today it is honest, because no shipping app needs the cache yet.

**Transport:** Tailscale, same as V1.

---

## 4. Comparison

| Dimension | V1 tools-only | V2 hot-cache | V3 sync-plane | V4 all-in tools |
|---|---|---|---|---|
| Offline (heavy data) | No | Yes (window) | Yes (full) | No |
| Confidential in transit | Yes | Yes | **No** (operator reads) | Yes |
| Confidential at rest | Yes (only answers) | **Conditional** (OS controls, backup-exclusion) | No | Yes (only answers) |
| Browser reach | Funnel only (beta) | Funnel only (beta) | Yes (native to the plane) | Funnel only (beta) |
| Setup friction (non-dev) | High (overlay) | High (overlay) + device hardening | Low (sign-in) | High (overlay) |
| Epicenter operates | Nothing | Nothing | The honeypot + Intuit proxy | Nothing |
| Code Epicenter must add | None | Box-owned cache/freshness engine | Snapshot channel + QB-server absorption | None |
| Two-of-three Local Books tools fit | Yes | Yes (mirror only) | **No** | Yes |

The honest asymmetric-wins reading: **the only vision with a real deletion prize is V3, and it is the one the confidentiality line forbids.** Among admissible options, none deletes much. So seam 2 is not a "refuse a feature to delete a code family" decision. It is a "what do we refuse to *build*" decision. The asymmetric-wins lens, applied honestly, says: the cheapest correct move is to refuse to build the cache engine until an app earns it (V4 build state), because building it buys offline at the price of a new replication subsystem and a new at-rest attack surface, for zero deletion.

---

## 5. Recommendation: ship the V4 build state, keep V2 as a fully designed earned seam, refuse V3, and adopt the placement rule

**The spine, now.** Ship the V1/V4 build state: tools-only over the user's overlay, nothing materialized, the daemon and addresses-only directory exactly as built. This is what the wedge needs (nothing) plus what a power-user developer can already use (Local Books over Tailscale). Adopt **V4's build state, not V4's product rule**: we have not built a cache engine because no shipping app needs one, not because we refuse offline forever.

**The durable rule (this is the artifact).** Place a piece of owned data by asking, in order:

1. **Is it a dataset or an operation?** An operation never materializes. `books_report` is a live QuickBooks call and `recategorize` is a write-through to Intuit (ADR-0061, mcp-server.ts), so both stay tools-only forever, on every plane, regardless of preference. Only datasets are placement candidates. This corrects the loose claim that "books = tools-only": the books *mirror* is a cacheable dataset; the report and the write are operations.
2. **Is the dataset light, mergeable, and non-sensitive?** If yes, it rides the **sync plane** (seam 1). This is the only admissible home for V3-style materialization, and it is exactly seam 1's job.
3. **Is it sensitive?** If yes, it never touches the operator-readable sync plane (V3 refused). It is reached as **tools-only (V1)** by default.
4. **Is offline reading of this sensitive dataset a committed product goal, AND can the target user operate the overlay?** Only if both hold does it become a **bounded confidential hot-cache (V2)** on the capability plane. The second clause is load-bearing: the cache rides the same overlay the user must run, so offline-for-non-developers is welded to turnkey reachability. You cannot ship offline email to a non-developer without also solving non-developer box reach.

Under this rule, books sort to V1 (sensitive, online-tolerable, analyst use), and email sorts to V2 *if and only if* offline email becomes a committed goal *and* its reachability is solved.

**Why the spine survives the grilling.** All three kill attempts landed as wounds with mandatory drafting fixes, not kills. "Reachability friction is fatal" misses that the wedge and the revenue ride the sync plane, which needs no overlay; the capability plane being developer-only today *is* the recommendation, matching ADR-0079's current power-user lean. "Online-only email is unshippable" is true but aimed at an app no one is shipping: email is a draft, gated on Google CASA, and not on the launch path; the recommendation defers *email itself*, not "V2 separable from email." "Confidentiality at rest breaks V2" is a real wound that V2's contract must absorb (section 6), not a reason to refuse V2, because V2 is the only admissible cell for the sensitive+offline+large shape.

**V2, designed cold now even though the build is deferred.** This closes the "you punted the hard part under launch pressure" attack. The contract:

- One-way fan-out from the box's existing CDC mirror to each device; the box is the single authoritative writer, so this is a projection, not a CRDT merge.
- A conservative default window (7 days or flagged-only, not 30), tunable per dataset, because bounded-by-time is not bounded-by-severity: one password-reset or 2FA email in the window is account-takeover-grade at any age.
- A per-dataset sensitivity toggle, default off for financials.
- A staleness indicator ("synced 2h ago"), because a cache that silently lies about freshness is worse than no cache.
- Fail-closed at-rest protection (see section 6): backup-exclusion and the highest OS data-protection class are requirements of the seam, not afterthoughts.
- A purge channel for a lost device. Note the cross-plane coupling: remote wipe naturally rides the **sync plane** (where device identity and Epicenter auth already live), because the box cannot push a wipe to a NAT'd, offline, or stolen phone over the capability plane. So capability-plane data's at-rest safety ends up depending on the sync plane. This coupling is acceptable but must be named.

**The native-vs-browser lever (actionable, because apps/email does not exist yet).** A native or Tauri client reaches the box frictionlessly on the tailnet; a browser SPA cannot use Tailscale Serve at all and needs Funnel (beta, throttled, admin-gated) or a public box. Whispering is Tauri, so it is fine. The app that most wants offline (email) is, if specced as a browser SPA, the worst-positioned client for capability-plane reach. **Building offline email as a native app sidesteps Funnel entirely.** This is a seam-2 decision the founder can pull at design time, not a fixed constraint.

**What replaces the revenue if we ever drift toward V3.** Nothing needs to: the recommendation keeps the paid sync plane intact and untouched. V3 is refused precisely because it would dissolve the paid plane's differentiator (your sensitive compute never touches Epicenter) into a honeypot. The one honest tension, raised by the all-in-cloud consultant: ADR-0004 already puts notes on the operator-readable plane, and notes routinely contain the same financial numbers and private text, so the hard wall at "ledgers and email bodies" protects a distinction the product does not otherwise fully honor. The wall still stands, because a bulk financial ledger and a full mailbox are categorically more than incidental numbers in a note, and the wall is what lets the product promise something Dropbox and Google cannot. But the tension deserves the one sentence it just got.

---

## 6. Proposed ADR-0079 amendments (verified, awaiting owner ratification)

These are corrections the fan-out verified against live docs and code. They are proposals; they live here until the owner folds them into ADR-0079.

1. **Funnel is beta, not GA.** Tailscale Funnel is documented as in beta, limited to ports 443/8443/10000, bandwidth-throttled, and requires a `funnel` node-attribute that only an admin can set in the tailnet policy (kb/1223). ADR-0079 should not lean on Funnel as a frictionless browser door. Funnel's confidentiality claim does hold: it is SNI passthrough, TLS terminates on the box, relays cannot decrypt (kb/1223, kb/1242), so it clears the bar the Cloudflare tunnel fails.
2. **The Origin-forwarding assumption needs a live check.** The V0 CORS allowlist depends on `tailscale serve` forwarding the browser's real Origin to the box. Serve is a transparent forwarding proxy that only manipulates `Tailscale-*` headers, so the real Origin almost certainly reaches the box, but no Tailscale doc states Origin handling explicitly. A 5-minute `curl` through `tailscale serve` checking the box-observed Origin should be run before treating the allowlist as load-bearing.
3. **The confidentiality line must add an at-rest custody clause.** As written, ADR-0079 bans edge-TLS-termination and operator-readability but is silent on data at rest. Two gaps follow. First, a self-run reverse proxy on a rented VPS is admissible under the current text, but it moves the data off the home box onto a rented public machine whose hypervisor and disk the provider controls; "E2E to the box" silently becomes "E2E to a rented machine." Second, a V2 device cache is silently re-leaked to Apple or Google by default-on iCloud/Google backup, which is the same reflexive-default leak ADR-0079 refuses Cloudflare to prevent, now at rest. The line should explicitly cover at-rest custody and require backup-exclusion plus the highest OS data-protection class for any device cache.
4. **iroh's confidentiality framing is too harsh; its deferral still holds.** ADR-0079 line 62 lumps iroh with WebRTC and the rejected edge tunnels. Verified correction: an iroh relay is content-blind and does not terminate TLS at the edge (docs.iroh.computer/concepts/relays), so iroh would *not* violate the confidentiality line; its residual exposure is connection metadata, not payload. The deferral still holds for the right reason: iroh does not deliver turnkey reach without Epicenter operating a relay+discovery rendezvous (n0's public relays are dev/test only), and every browser and CGNAT phone relays permanently (browser WASM is relay-only). iroh returns only behind the existing turnkey trigger, and if it returns, its self-hosted relay is preferable to a bespoke channel floor.
5. **A write-guard is needed even tailnet-private (verified V0 bug).** The daemon's `/mcp` is cross-origin write-triggerable today. The MCP SDK's content-type gate is a substring check (`webStandardStreamableHttp.js:386`, `!ct.includes('application/json')`), so `Content-Type: text/plain; charset=application/json` is a CORS simple request that fires no preflight and passes the gate; the SDK's own Origin guard is off by default (`:112`, `_enableDnsRebindingProtection` unset by the daemon); stateless mode skips session validation and a bare `tools/call` needs no `initialize`. So any website a tailnet device visits can trigger `sync` (always) and `recategorize` (when not read-only). The response is unreadable, but the side-effect fires. This falsifies "the tailnet ACL is sufficient authz, no bearer needed": the CORS-fails-closed seam guards reads only. Cheapest fix that fits the design: enable the SDK's `enableDnsRebindingProtection` + `allowedOrigins`, or reject a POST whose `Origin` is present-but-unallowlisted (native clients send none). The true fix is a bearer on the POST. ADR-0079 decision 6 should note that the bearer is load-bearing at the app layer even before public exposure.

---

## 7. The one product question that locks seam 2

Everything above reduces to one question, and it is the founder's, not an engineer's:

> **Is offline reading of owned data (concretely, email) a committed product goal?**
> Owner: the founder (a product call).

The cascade is the whole point of stating it as one question:

- **If no:** ADR-0079 stands untouched. Seam 2 is tools-only (V1) for everything sensitive, books included. No cache engine, no turnkey reachability spend, the relay floor's channel layer is deleted on schedule, and the recommendation is simply "ship the spine."
- **If yes:** it cascades into two builds that must be funded together, because they co-fire. First, the V2 bounded confidential hot-cache (the cold contract in section 5), with the at-rest protections in section 6 as fail-closed requirements and its full cost charged to email's budget. Second, the pre-existing ADR-0079 reachability fork resolves toward turnkey, because offline email for a non-developer requires non-developer box reach, which power-user bring-your-own-Tailscale does not provide. The cheapest way to soften the second cascade is the native-vs-browser lever: a native email client reaches the box on the tailnet without Funnel, which buys time before committing to embedded iroh or a broker.

A "no" is the simplest shape that keeps the seam-1 promise and a usable seam-2 product for the developer audience the wedge actually reaches first. A "yes" is a real, costed expansion, not a small feature, and it should be taken only when an email app is genuinely on the roadmap.
