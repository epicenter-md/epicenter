# Cross-device coordination: replicate, materialize, observe, attach

State: Draft

A greenfield vision memo for Epicenter cross-device synchronization, command
execution, and machine-specific capabilities. Existing ADRs were treated as
evidence, not constraints. Stops at vision; nothing here is implemented.

## 1. Product vision in one sentence

A person's data replicates to every device as local-first state; capabilities
that live on one machine are driven by durable work records that machine
observes; and exactly one live channel exists (attaching to the desktop host
session over the user's own overlay), so Epicenter operates one transport (CRDT
sync) and routes zero capability calls. Put pithily: sync is the coordination
layer; execution stays where the capability lives.

## 2. Historical context: what we built, deleted, and learned

The repo has already run this experiment three times.

```txt
BUILD-UP
#1707  2026-04-28  typed peer RPC; flags "action manifest on awareness is too heavy"
#1754  2026-05-14  RPC + presence moved onto Yjs state (lasted five days)
#1778  2026-05-19  live device dispatch over the relay
#2077  2026-06-18  always-on actors over synced docs (doc-as-wire proof)
#2236  2026-06-30  relay floor: per-user relay carries blind MCP channels; iroh deleted

TEAR-DOWN
#2237  2026-06-30  in-room dispatch deleted; run --peer refused
#2238  2026-06-30  presence action manifest decommissioned
#2277  2026-07-02  entire relay channel layer deleted (~3,400 lines)
```

Three lessons survived every teardown, and they are the spine of this memo:

1. Doc-as-wire works. The one pattern that shipped and stayed is ADR-0025: a
   durable record in a synced doc is the queue, an observing worker on the
   capable machine reconciles it, existence of the keyed result is the claim,
   cancel is a durable field, dispatch is at most a doorbell. The V0 observing
   worker is live code today (`packages/workspace/src/document/child-doc-worker.ts`,
   proven over a real synced room in `worker-over-room-sync.test.ts`).
2. Live capability transport dies of no consumers. Peer RPC, in-room dispatch,
   and the relay floor each shipped speculative reach and were deleted with
   zero end-to-end users. ADR-0086's bar is the durable rule: no spend on
   network-reachable capability until a real, named consumer exists.
3. Presence cannot carry capability. The action-manifest-on-presence idea was
   flagged in #1707, orphaned in #2237, and deleted in #2238. Presence today is
   `nodeId` / `connectedAt` / `agentId`, and the schema rejects route-shaped
   fields at the validation boundary. That is correct and final.

One more historical fact matters: the deleted things were all synchronous.
`dispatch.ts` required a live peer; the relay floor carried live MCP calls. The
durable variant (ADR-0025, PR #2077) was never deleted. The failure mode was
liveness, not the sync plane.

## 3. The gradient, tested

The candidate was a four-level gradient: synced app data, synced derived/index
data, synced command/job outbox, direct/live connection. Verdict: the shape is
right, two of the levels are wrong as stated.

Level 1 (synced app data) is proven and shipped (Whispering, Honeycrisp,
Todos). Keep.

Level 2 (synced derived/index data) dissolves. Grounding it against the real
apps shows it is not a sync level at all. Gmail's mobile story is each device
holding its own mirror against Gmail directly (Google allows 100 concurrent
grants, ADR-0081); no Epicenter transport is involved. The syncable parts of a
mail app (annotations, rules, saved views, triage state) are ordinary Level 1
app data. And the one true "replicated index" case (a bounded books hot-cache
for a phone) was already designed cold in the seam-2 spec as box-to-device
fan-out over the capability plane, deliberately not hosted sync, because ledger
rows are exactly what the operator must not read. There is nothing left for a
distinct level to own.

Level 3 (synced command/job outbox) survives, but demoted and renamed. As a
platform primitive (a generic job table any app writes into) it repeats four
recorded mistakes at once: ADR-0025 explicitly foreclosed a `generation_requests`
table and a CRDT claim field; a generic schema invites N status enums and
fragments audit (the ADR-0021 disease); an enqueue is not an authorization; and
"job" payloads have no exemption from the sync plane's trust model. What
survives is the ADR-0025 kernel as a per-app pattern: a domain row with a named
executor, observed by that machine's worker. Section 7 pins the semantics.

Level 4 (direct/live connection) narrows to exactly one shape: attaching to
the desktop host session as a thin client, end-to-end over the user's own
overlay (ADR-0080). Not per-app endpoints, not a per-tool channel, not an
Epicenter-routed relay.

The replacement model has four verbs and one Epicenter-operated transport:

```txt
replicate    durable user data syncs as local-first CRDT state
             (the sync plane; the paid product; the only Epicenter transport)

materialize  provider-owned data builds per device from the upstream's own API
             when the upstream's OAuth concurrency allows it (Gmail yes,
             QuickBooks no; ADR-0081). No Epicenter transport involved.

observe      machine-specific work is a durable domain row bound to one
             executor agent; the capable machine's worker observes it, runs
             it, writes results back. Rides the same sync plane; inherits its
             trust model and gates (section 7).

attach       live interaction with a specific machine is remote access to the
             one desktop host session, E2E over the user's overlay
             (ADR-0080). The only live cross-device channel.
```

A phone is a full citizen for replicate and materialize, a requester for
observe, and a thin client for attach. It is never a remote control for a
desktop's apps.

## 4. Use-case matrix

```txt
use case          replicate                     materialize          observe                          attach
Whispering        recordings meta, transcripts,  no                   not needed today; batch          no
                  recipes, synced settings                            transcription is a future
                  (audio = local blob refs)                           candidate if ever named

Todos/Honeycrisp  everything                     no                   no                               no

Local Mail        annotations, rules, saved      mailbox per device   no: mail materializes per        via Super Chat
                  views, triage state            direct from Gmail    device first                     session if wanted

Local Books       nothing (off the mesh)         forbidden (Intuit    hosted: not offered in v1;       yes: the default
                                                 one-connection)      self-host/attach if needed       phone story
                                                                      hot-cache stays deferred

iMessage          n/a                            n/a                  hosted: not offered in v1;      n/a
                                                                      self-host: query/summarize;
                                                                      send only under section 7 rules

Coding agent/Pi   run rows, transcripts,         no                   YES: the named first consumer    escalation path
                  progress, results (blob refs)                       (section 13)                     for live terminal

Super Chat        host-local replicas; its own   no                   consumes run rows like any       the one attach
                  transcript stays ephemeral                          client; never the executor        target (ADR-0080)
                  for now                                             registry
```

Three of these deserve a sentence beyond the table.

iMessage is not a hosted-sync feature in v1. On hosted, message bodies would
be trusted-cloud data, and the product does not need to make that promise now.
On self-host, the operator is the user, so query and summarize jobs become
viable: Apple syncs the Messages app to the user's devices, but it does not give
an agent query access to `chat.db`. Sending is admissible only under the
section-7 safety rules: exact-payload approval, short expiry, executor-local
send ledger, no auto-retry after unknown outcome, claim before send, and
cancel-until-intent. Money-shaped verbs remain refused outright.

The coding agent is the opposite: the best consumer the mailbox pattern will
ever get. The work is minutes-to-hours scale, nobody awaits it synchronously,
progress is naturally a streamed log, results are naturally blob references (a
diff, a test report), and the human who must approve a step is by definition on
a different device than the executor. The durable job log is the primary model;
live terminal control is the attach escalation, not the default.

Local Mail's phone story is the cleanest proof that materialize beats remote
control: a mobile mail app authorizes Gmail itself and holds its own mirror. Do
not let Super Chat become the mobile mail client; ADR-0080 already refused that
("reading email on a phone is the email app on the phone").

## 5. Positive target architecture

```txt
synced docs/tables      workspace CRDT state, one per-user hibernatable anchor,
                        operator-readable by design (ADR-0004). Owns: app data,
                        run/job domain rows, approval records, durable config.

derived/index data      per-device projections (SQLite materializers, markdown)
                        built locally from synced state or from the upstream
                        API. Never synced themselves; rebuildable.

command/job rows        per-app domain tables (a runs table, not a jobs table),
                        each row bound to one executor AgentId at creation.
                        Child doc per row for progress/transcript; blob refs
                        for bulk payloads and results; row deletion tears the
                        child doc down.

worker observation      the shipped V0 loop: a daemon holds a live replica,
                        filters rows to the agent it answers as, reconciles
                        unanswered work, streams progress into Y.Text, writes
                        a write-once finish. Workers dial OUT to the sync
                        anchor only; a capable machine exposes no inbound
                        surface at all.

presence/liveness       nodeId, connectedAt, agentId. Decorates the UI
                        ("Mac Studio: offline, will run when it wakes").
                        Never routing truth, never capability.

approvals               durable records in the job's child doc, resolvable
                        from any device, scoped to the exact visible payload
                        (the consent rule from specs/super-chat-direct-command-forms.md).
                        Never ambient, never carried across calls.

result/audit log        the domain rows ARE the audit log: requester-minted id,
                        executor identity, write-once finish/error, approval
                        records, all in one place per app. No parallel audit
                        table to reconcile.

direct/live             exactly one: the ADR-0080 session remote, E2E over the
                        user's overlay. Earned today by bring-your-own-
                        Tailscale; a hosted variant exists only as a future
                        content-blind E2E relay (ADR-0080's trigger).
```

The security consequence of "workers dial out only" is worth naming: the
biggest deleted liability (a daemon HTTP surface with CORS and a load-bearing
public bearer, the verified `/mcp` cross-origin write vector) cannot return,
because there is no inbound listener to attack. NAT and CGNAT also stop
mattering; the box only ever makes outbound connections.

## 6. Presence and discoverability

Presence owns one fact: which peers are connected right now, as
`{nodeId, connectedAt, agentId}`. It exists so a requester can set expectations
("queued; desktop offline") and so a worker picker can decorate a configured
list with live/offline badges.

Durable config owns addressing. The AgentId catalog (which agents exist, which
machine answers as which) is configuration on synced state, exactly as ADR-0025
put it: "a configured offline daemon can still be the correct binding because
the conversation doc is the durable mailbox it will read when it wakes."

Jobs own the work: payload, target, lifecycle, results, approvals, audit.

What must never ride presence: action manifests, tool catalogs, route tables,
endpoint URLs, capability advertisements of any kind. This was built and
deleted three separate times. The presence schema's current rejection of
route-shaped fields is a permanent invariant, not a cleanup artifact.

Discoverability of what a machine can do is a durable question with a durable
answer: the apps installed on that machine and the agent catalog, both synced
state. "What can my Mac do" is read from config; "is my Mac awake" is read from
presence; the two never merge.

## 7. Command/job semantics (the mailbox kernel)

The pattern, pinned field by field. Every choice below is ADR-0025's shipped
mechanics generalized from conversations to work, with the rejected
alternatives kept rejected.

```txt
job id          requester-minted at creation. It is simultaneously the
                idempotency key and the claim key.

job type        the domain table is the type. A coding run is a row in a runs
                table with run-shaped columns. There is no generic jobs table
                and no type enum. (Forecloses N status vocabularies and keeps
                each app's audit self-contained.)

payload         domain columns; anything bulky is a content-addressed blob
                reference, never inline CRDT bytes.

target          one immutable executor AgentId, set at creation, never
                reassigned. Retargeting is creating a new row. (The ADR-0025
                binding, and the reason contention is rare by construction.)

requester       implied by the partition (one person). Within the partition,
                writers are indistinguishable, so an enqueue is NEVER an
                authorization. Anything requiring consent gates at the
                executor via the approval record.

status          no shared status enum and no claim field. Disjoint
                single-writer regions: the requester owns cancelRequested and
                expiry; the executor owns started/progress/finish. The claim
                is the existence of the executor's started record keyed to the
                job id; whoever appends first wins, every other observer
                reconciles the same predicate and stops.

idempotency     the executor must be idempotent per job id, or the verb must
                be approval-gated. A verb that is neither (send a message,
                move money) does not ride the mailbox at all.

result          executor-owned, write-once, blob refs for bulk. The job row
                plus child doc is deletable as a unit, so history does not
                grow forever.

error           executor-owned write-once error record beside finish.

approvals       a durable record in the job's child doc that any of the
                person's devices resolves; scoped to the exact visible
                payload; never ambient. This is ADR-0025's approval returning
                in a smaller form: it gates side effects on a headless
                executor, not reasoning (which stays re-askable, ADR-0047).

cancellation    requester-owned advisory flag, honored before the point of no
                return; plus a requester-set expiry the executor checks at
                claim time, so a job enqueued against a sleeping machine
                refuses to fire stale.

claim pools     deferred, exactly as ADR-0025 forecloses: no lease machinery
                until N interchangeable workers per agent actually exist, and
                then via a compare-and-set action, never a raw field.
```

The gates, stated once: a verb may ride the mailbox only if it is (a)
non-urgent (a late run is still a good run), (b) idempotent per job id or
approval-gated, and (c) permitted on the deployment's sync plane. On hosted,
that means ordinary trusted-cloud data only. On self-host, sensitive observe
jobs become viable because the operator is the user. A coding run is the first
fit; a self-hosted iMessage query can fit later.

One honest limit: within a single-user partition, a compromised bearer or an
XSS in any synced surface can write a job and its approval. Sync write access
already meant total data compromise; the mailbox escalates it toward execution.
That is why gate (b) exists at the executor. Money-shaped verbs stay refused
outright; send-message jobs are admissible only with exact-payload approval,
short expiry, a crash-surviving executor-local send ledger, no auto-retry after
unknown outcome, claim before send, and cancellation until the ledger records
intent-to-send.

## 8. Privacy model

The sync plane is operator-readable by decision, not accident (ADR-0004; the
anchor deliberately holds plaintext). Job payloads and results get no
exemption; "it's just a job" is the exact move ADR-0080 already rejected when
it refused "just sync the chat over the sync plane."

The product rule is deliberately shorter than a class ladder:

```txt
hosted      trusted managed sync. Epicenter can read synced payloads.
self-host   the user runs the operator. Epicenter is not in the data path.
```

There is no third "hosted but Epicenter cannot read" mode for v1, and no
per-dataset privacy opt-in dial. If a payload rides hosted sync, the product
treats it as trusted-cloud data. If that is not acceptable, the answer is
self-host. This keeps privacy a deployment decision, not a feature setting, and
prevents the UI from implying that some hosted synced data has a different
reader set than the rest.

Server-derived encryption does not change the rule. A key Epicenter can derive
changes the storage format and may reduce breach surface, but it does not
remove Epicenter from the reader set. Application-layer encryption at rest may
return later only as unmarketed hygiene for a concrete compliance need, never
as a mode, a class, a lock icon, or a reason to put sensitive content on hosted
sync.

This means sensitive observe jobs are deployment-scoped. Hosted can run observe
for ordinary trusted-cloud data, such as coding runs over repos a user is
comfortable syncing. Self-host can run observe over mail bodies, message
bodies, or other sensitive content because the operator is the user. Product
promises can still be stricter than the deployment allows: if "the books never
leave the box" remains the Local Books promise, books stay box/attach even on
hosted and are not softened by a setting.

## 9. Super Chat's place

Super Chat is an app, not a runtime and not a transport. It is the desktop
orchestration surface: one host process composing local action registries
(Honeycrisp, Todos) and local stdio facades (Local Books), per ADR-0080/0111.

Its cross-device story is exactly one thing: attach. A phone is a thin client
to the one host session over the user's overlay. Super Chat does not become
the mobile mail client (materialize owns that), does not become the executor
registry (each app's worker owns its own rows), and does not grow per-app
network endpoints. As a requester it is unprivileged: creating a coding run
from Super Chat writes the same domain row any other surface would write.

Its transcript stays ephemeral until there is a reason to sync it. If it ever
syncs on hosted, it is trusted-cloud data, so tool results that the product is
not willing to expose to Epicenter Cloud must stay out of the synced transcript.
That is a real constraint, and it is another reason attach (not transcript
sync) is Super Chat's remote story.

## 10. What stays deleted

- The relay channel layer: 4-frame protocol, channel router, relay acceptor,
  account room, route table (#2277).
- In-room dispatch and `run --peer` (#2237); typed peer RPC, peer-wait, the
  peer error taxonomy (#1707/#1778 lineage).
- Presence action manifests and `exposedRoutes` (#2238); presence stays
  liveness-only forever.
- The MCP gateway catalog and MCP-over-relay; per-app network `/mcp`
  endpoints; `epicenter tools` / `call` / `--relay-expose`.
- iroh and any Epicenter-owned reachability broker (returns only behind the
  turnkey trigger, as ADR-0079 already gates it).
- The content-readable hosted session broker (rejected in ADR-0080, stays
  rejected).
- Generic job/queue/`generation_requests` tables and CRDT claim fields
  (foreclosed by ADR-0025, reaffirmed here).

One deleted idea returns smaller: durable doc-mediated approval (built for
ADR-0042/0044, deleted by ADR-0047 when the loop moved into the client). What
changed: it no longer gates reasoning in a chat loop where the human is
present; it gates side effects on a headless executor where the human is by
definition elsewhere. It lives in the job's child doc, is scoped to the exact
payload, and is never ambient. ADR-0047's own escape clause ("if a scheduled
or autonomous agent becomes a real need it reopens the daemon loop explicitly")
names this exact reopening; the coding worker is its consumer.

## 11. ADR and spec impact

```txt
ADR-0025   promote Proposed -> Accepted. It is the platform's mailbox kernel;
           this memo generalizes it from conversations to work rows.
ADR-0047   amend, not replace. Client loop stays the default for human-driven
           chat. The async-job tier gains the section-7 semantics, and the
           "autonomous agent reopens the daemon loop" clause is exercised for
           the coding worker: an executor may run its own loop (pi in-process)
           over a run row, as an explicit, named reopening.
ADR-0079   leave standing; amend the status note: the capability plane is
           empty by construction (0086), and the "capabilities directory"
           sketch in its Decision 3 is dead until a named consumer (it was
           never built). The two-plane split survives as sync + attach.
ADR-0080   leave alone. It is the attach shape and the seam-2 constraint.
ADR-0081   flip Proposed -> Accepted; it is load-bearing for materialize.
ADR-0086   leave alone; its "real, named consumer" bar is the governing rule.
ADR-0111   leave alone.
ADR-0043   stays superseded; do not resurrect answer-where-capability-lives
           as a general rule. The coding worker is a scoped exception recorded
           via the 0047 amendment, not a return to per-agent loop placement.
new ADR    record this model: cross-device coordination is replicate,
           materialize, observe, attach; one Epicenter transport; presence is
           liveness-only; hosted is trusted sync; self-host is the privacy
           answer; no third mode; no per-dataset privacy dial; and the
           mailbox gates (non-urgent, idempotent-or-approved, permitted on
           this deployment's sync plane). Supersedes this spec once accepted,
           and this spec is then deleted per hygiene.
seam-2     keep; its open founder question is Q1 below and gates the deferred
spec       books/mail hot-cache design.
```

## 12. Sharpest asymmetric wins, as product refusals

1. Epicenter never routes a capability call. This one sentence keeps roughly
   ten code families dead: channel protocols, route tables, acceptors, peer
   RPC, gateway catalogs, per-app endpoints, CORS hardening, public bearers,
   reachability brokers, reconnect taxonomies.
2. A capable machine exposes no inbound surface. Workers dial out to sync;
   the entire remote-attack class (the `/mcp` CORS write vector) becomes
   unbuildable rather than mitigated, and NAT stops being a design input.
3. Presence carries liveness only. Learned three times; now an invariant.
4. There is no jobs table. An app that wants async work publishes its own
   domain rows and passes the three gates. This refusal is what keeps audit
   whole and status vocabularies from multiplying.
5. If it matters when it runs, it does not ride the mailbox. No urgent verbs
   over sync; urgency is what attach is for.
6. Epicenter does not build a hosted iMessage feature in v1. A self-hosted
   assistant may observe Messages on the user's own deployment, and send only
   under the section-7 safety rules.
7. The phone reads mail from Gmail, not from your desktop. Materialize beats
   remote control whenever the upstream allows it.
8. Job payloads get no privacy exemption. Hosted sync is trusted-cloud sync;
   self-host is the privacy answer. There is no per-dataset privacy dial.
9. Super Chat is reachable as exactly one session. It never becomes the
   universal cross-device runtime.

## 13. Exact next experiment

Build workers V1 with the coding run as the named consumer, entirely on the
existing sync plane. Smallest honest slice:

1. A `runs` table plus per-row child doc in a dev workspace: requester-minted
   id, immutable executor `agent`, a read-only verb first ("run the test suite
   on branch X"), `cancelRequested`, expiry.
2. The desktop daemon extends the shipped V0 observe loop: filter runs bound
   to its agent, claim by writing the started record keyed to the run id,
   stream progress into `Y.Text`, write a write-once finish whose bulk output
   is a blob reference.
3. A second device (a browser is enough; a phone browser is better) creates
   the run, watches presence-decorated status ("desktop offline, will run when
   it wakes"), and exercises durable cancel.
4. One approval-gated second verb (apply the produced patch to the branch) to
   prove the durable approval record round-trips from the non-executor device.

This proves or falsifies every load-bearing claim (existence-claim under a
real second writer, disjoint regions, liveness UX, durable approval, blob-ref
results) while resurrecting zero transport: no new routes, no inbound daemon
surface, no relay machinery. If this slice feels bad in the hand, the vision
is wrong somewhere that matters.

## 14. Open product-owner questions

1. Is offline reading of owned sensitive data (mail on a plane, books with no
   box reachable) a committed product goal? Mail should materialize per device
   where the upstream allows it; books would need the deferred hot-cache design
   or self-host. (This is the seam-2 spec's standing question.)
2. For hosted-sync users, is repo content in coding runs acceptable
   trusted-cloud data, or is the coding agent a self-host/overlay-only feature?
3. Is turnkey mobile remote (no Tailscale) worth building E2E session crypto,
   or does bring-your-own-overlay remain the answer? (ADR-0080's trigger,
   restated; everything in this memo works without deciding it.)
4. Does Whispering ever want cross-device transcription (phone records,
   desktop GPU transcribes via a run row), or is per-device transcription
   final? Nothing should be built ahead of a yes.
5. When Super Chat's replicas converge with app UIs (ADR-0096 slice), does its
   transcript sync too, given tool results can carry sensitive trusted-cloud
   data on hosted, or does it stay ephemeral by design?

## 15. What would falsify this vision

- The experiment in section 13 shows doc-mediated approval is too slow or
  clumsy for real coding-agent workflows; attach becomes the primary model and
  the mailbox demotes to fire-and-forget only.
- Users demonstrably need urgent phone-initiated side effects on a specific
  machine (not served by the mailbox, too heavy for attach); that is the one
  product pressure that would genuinely reopen live capability transport, and
  it should be resisted until a named consumer passes the ADR-0086 bar.
- Hosted-sync users reject operator-readable run payloads (Q2 answered
  self-host/overlay-only); the mailbox then only serves self-hosters for coding
  work, which weakens the claim that one transport serves the whole product.
- A real third-party integration needs a per-app network endpoint and cannot
  be served as a built-in, a stdio facade, or a run row; the capability plane
  returns with a consumer for the first time.
- The always-on premise fails in practice: if most users never leave a machine
  awake, "observe" starves and the product truth becomes phone-plus-cloud,
  which is a different architecture (hosted executors) this memo deliberately
  does not design.

---

## Appendix: greenfield findings for the major decisions

### F1. The mailbox is a per-app pattern, not a platform outbox

Product sentence: an app that needs machine-specific async work publishes its
own domain rows bound to one executor agent; the workspace owns sync and the
observe loop; no shared job infrastructure exists.

Drift: "synced command outbox" drifts toward a generic jobs table with status
enums, retries, and claim fields, which is hidden RPC plus audit fragmentation.

Value owners: durable state = the app's rows; liveness = presence; side
effects = the executor's worker; audit = the rows themselves; consent = the
durable approval record; execution = the machine bound at creation.

Code family created if we drift: a jobs schema, a status vocabulary, a retry
policy engine, a claim/lease module, a cross-app audit UI, migration paths for
every app that outgrows the generic shape.

Greenfield vision: ADR-0025's kernel per app, three gates (non-urgent,
idempotent-or-approved, permitted on this deployment's sync plane), claim pools
deferred until N interchangeable workers exist.

User loss: no universal "all my jobs" screen in v1; each app lists its own
runs. Acceptable; a read-only aggregation view can be earned later without a
shared write schema.

Decision: refuse the platform outbox; keep the per-app mailbox pattern.

### F2. Live per-app capability transport stays deleted

Product sentence: Epicenter syncs state and never routes a capability call.

Drift: every "phone reaches a tool on my Mac, live" story pulls the ten
families back (section 10).

Value owners: reachability = the user's overlay; the only live surface = the
one host session (attach).

Code family created if revived: the entire #2277/#2237 ledger plus token
bootstrap hardening and a reconnect/timeout error taxonomy.

Greenfield vision: observe for async, attach for live, nothing in between.

User loss: no zero-install browser reach to a NAT'd box (already accepted in
ADR-0079); no per-tool remote invocation without a session.

Decision: refuse; ADR-0086's named-consumer bar governs any reopening.

### F3. Materialize replaces "synced derived data"

Product sentence: provider-owned data builds per device from the provider,
gated only by the provider's own OAuth concurrency.

Drift: treating "mobile access to mail" as a sync or remote-control problem
when Google already offers every device its own grant.

Value owners: the upstream owns the source of truth; each device owns its
mirror; synced state owns only the human-authored layer (annotations, rules,
views).

Code family created if we drift: box-to-phone replication channels, partial-
mirror protocols, staleness reconciliation, all to tunnel data the phone could
fetch first-hand.

Greenfield vision: per-device mirrors where allowed (Gmail); box-owned mirror
plus attach where forbidden (QuickBooks); the deferred hot-cache design only
behind Q1.

User loss: none for mail; for books, no offline phone reading until Q1 is
answered yes.

Decision: keep (this is ADR-0081, promoted to a pillar).

### F4. Attach is the only live channel

Product sentence: exactly one thing is remotely reachable, the desktop host
session, end-to-end over the user's own overlay.

Drift: every new live need (terminal streaming, approval latency, "watch the
agent think") tempts a second channel.

Value owners: the desktop host owns the session; the overlay owns transport
and authorization; Epicenter owns nothing in the path.

Code family created if we drift: a second remote protocol, its auth, its
reconnect logic, its privacy review.

Greenfield vision: ADR-0080 unchanged; a hosted variant only ever as a
content-blind E2E relay behind its trigger.

User loss: non-overlay users have no live remote today; they keep replicate,
materialize, and observe.

Decision: keep.

### F5. Durable approval returns, scoped

Product sentence: a side-effecting run on a headless executor pauses on a
durable approval record any of the person's devices resolves.

Drift: either ambient approval (enqueue = consent, which within-partition
forgery breaks) or resurrecting full doc-mediated chat approval that ADR-0047
deleted for good reasons.

Value owners: the executor owns enforcement (nothing runs unapproved); the
requester's human owns the decision; the job child doc owns the record.

Code family created: one approval record shape, one executor-side wait, one
resolve UI; deliberately no policy engine in v1 beyond per-verb
deny/ask/auto.

Greenfield vision: approval gates side effects, never reasoning; scoped to the
exact visible payload; irreversible external verbs stay refused rather than
approval-gated.

User loss: dangerous verbs (money, messages) are simply unavailable via the
mailbox, by design.

Decision: keep, scoped exactly this far.
