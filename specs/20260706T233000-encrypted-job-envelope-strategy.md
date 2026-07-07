# Encrypted job envelopes: strategy review of the class-b refusal

State: Draft

A privacy strategy memo, not a design. It answers one question: is the
cross-device vision memo (`specs/20260706T220000-cross-device-coordination-vision.md`)
too strict when it says class-b payloads never ride hosted sync, or would a
narrow server-derived encrypted envelope for command/job payloads and results
(the ADR-0074 vault posture, applied to work rows) earn a place between
plaintext hosted sync and self-host? Existing ADRs were treated as evidence,
not constraints. Stops at strategy; nothing here is implemented.

## 1. Verdict

Keep the current class model. Reject the encrypted-envelope class.

The one-sentence reason: Epicenter's privacy classes are defined by who can
read, and a server-derived envelope does not change who can read; it changes
what a partial storage breach exposes. That is hygiene inside class a, not a
new class between a and b. The only mechanism that creates an honest middle
class is a client-held key the server never sees, and that is the
zero-knowledge design ADR-0004 rejected with its full cost intact: keyring
lifecycle, unreadable states, recovery cliffs, and the loss of server-side
reads. A job wrapper does not make that math smaller; it makes it per-app.

Two refinements come with the verdict:

1. The vision memo's section 8 asserts "encryption posture: unchanged" without
   saying why an envelope cannot help. It should state the reader-set argument
   in one paragraph, so the next person who asks this question (this memo is
   proof someone will) finds the reasoning foreclosed rather than assumed.
2. The honest strictness dial is deployment, not cryptography. Hosted sync is
   trusted-cloud sync; self-host relocates the operator to the user. If a
   payload is not acceptable on hosted under that sentence, the answer is
   self-host or do not build the hosted feature, never an envelope that implies
   more than it delivers.

## 2. What PR #2023 actually removed, and why

PR #2023 (merged 2026-06-15) removed exactly the candidate under review, at
workspace scale. The layer was:

```txt
ENCRYPTION_SECRETS            root keyring, on Epicenter's server
  -> owner key                auth server derives it (HKDF)
    -> workspace key          client derives it (HKDF)
      -> XChaCha20-Poly1305   encrypt the value, then into the Y.Doc
```

Server-derived keys, ciphertext at rest on the relay, keyring delivered on the
authenticated session. The PR body names the tell: "encrypting at rest still
trusts the server. The root key lived on our infrastructure, so server code
could read your data, a bug could log it, an operator could inspect it. You
were never server-blind; you were trusting the application." Once the relay is
trusted anyway, "the per-owner workspace key buys nothing but a key-recovery
tax and a class of 'unreadable cell' failures."

What the removal cost, concretely: the `unreadable` read state existed only
for encrypted rows (ADR-0002, superseded by ADR-0003); the keyring threaded
through auth, session, and every workspace factory; `/api/session` served key
material; and the KV read contract was a tri-state every consumer branched on.
Deleting the layer collapsed reads to `value | undefined` and dropped the
keyring parameter from six app factories.

ADR-0004 then recorded the decision twice over: it rejected zero-knowledge,
and in its considered alternatives it separately rejected "per-workspace
encryption at rest, server holds keys" as "complexity of an encryption layer
with none of the server-blindness benefit." That second rejection is the
candidate model of this memo, verbatim. The candidate is not a new idea; it is
the deleted idea at smaller scope.

One state-of-the-tree note: the primitives survived the wiring. On main today,
`@epicenter/encryption` (MIT) still exports a tested, versioned AEAD envelope
(`encryptBytes`/`decryptBytes`, XChaCha20-Poly1305, key-version header, AAD
binding) and per-principal derivation (`parseRootKeyring` + `deriveKeyring`,
info label `principal:{id}`), and `createEncryptedYkvLww` sits dormant in
`packages/workspace`. Zero production callers. Feasibility was never the
question; a narrow envelope is buildable in days. The question is whether it
buys anything.

## 3. What ADR-0074 proves, and what it does not

ADR-0074 (the secret vault) is the one accepted narrow exception, and it is
the strongest evidence for the envelope, so it deserves an exact reading.

What it proves: the server-derived posture is livable when scoped. No
passphrase, no unlock ceremony, no `locked` state; the keyring arrives with
the authenticated session, so a present value is always decryptable and the
read contract stays two-state (`available | missing`). The relay and its
backups hold ciphertext while the keyring lives in the auth service, so a
relay or backup leak alone exposes nothing. And the ADR is honest about what
that is: "defense in depth, not a privacy claim. On hosted the operator can
read a stored key, and that is the accepted point."

What it does not prove:

1. It is not yet livable in production. The wiring spec
   (`specs/20260701T150000-api-keyring-and-vault-wiring.md`) is Draft, branch
   not started; `deriveKeyring` has no caller; Whispering's secrets facade is
   device-local plaintext today. ADR-0074 proves the policy is acceptable, not
   that the plumbing is proven.
2. Its justification does not transfer to content. The vault holds brought
   credentials: small, dense, long-lived, and directly exploitable. A leaked
   Groq key is a working credential for a third-party account; encrypting it
   at rest defends against a real, specific blast radius. A job payload is
   content. Content leaking from a storage snapshot is bad, but the user's
   actual question about content ("can Epicenter read my mail query?") has the
   same answer with or without the envelope. Citing ADR-0074 as precedent for
   content envelopes reads the exception wider than its own rationale.
3. It defended one store, once. Jobs are deliberately not one store. The
   vision memo's refusal #4 (no generic jobs table; every app publishes its
   own domain rows) means there is no single integration point to encrypt.
   An envelope would either be re-implemented per app table, or it would
   pressure the generic jobs table back into existence to have one place to
   bolt itself on. The envelope is structurally in tension with a refusal the
   memo fought three teardowns to earn.

There is one more piece of settled evidence: ADR-0090 already decided that the
blob layer stays plaintext and "confidentiality belongs to the encrypting
consumer," who encrypts before `blobs.add` and owns key management. So the
seam for a consumer-owned envelope over bulk payloads exists, sanctioned, and
requires no new decision. If the trigger in section 9 ever fires, that seam is
where the work lands; nothing needs to be pre-built to keep it open.

## 4. The reader-set argument (why no honest middle class exists)

```txt
Question:
  does encrypting a job payload under a server-derived key move it
  between privacy classes?

Model:
  class    = the set of parties who can read the payload
  class a  = {user's devices, Epicenter operator}     (hosted plaintext)
  class c  = {user's devices, user-as-operator}       (self-host)
  envelope = same reader set as class a; smaller breach surface

Rule:
  encryption moves a payload between classes only when it removes a
  reader. A key the operator derives removes no reader. Therefore the
  envelope cannot admit class-b data to hosted sync; it can only make
  class-a data cheaper to hold safely.
```

Class b exists because of promises about readers: "the books never leave the
box" is a claim about who can read ledger rows, and ADR-0080's seam-2
constraint bars class-b tool results from "any operator-readable channel,"
naming "just sync it over the sync plane" as the exact costume to refuse. An
envelope whose key sits in Epicenter's auth service leaves the channel
operator-readable. The promise breaks identically; the machinery just makes
the break harder to see, which is worse. ADR-0068 has a name for a
configuration that implies privacy it does not deliver: a false privacy claim.

The infra baseline also matters here. Cloudflare already encrypts Durable
Object storage at rest below the application. The envelope's real marginal
protection over that baseline is application-layer exposure: server logs,
backups readable by app code, an operator inspecting the DB, a leaked storage
export. Real, but thin, and identical in kind to what every hosted SaaS means
by "encrypted at rest." It is a hygiene property, not a product tier.

## 5. Revised privacy class table

This table records the original memo's intermediate framing. The addendum below
supersedes it with the final owner decision: hosted is trusted managed sync,
self-host is the privacy answer, and there is no per-dataset privacy dial. The
useful part that survives is the reader-set argument, not the class vocabulary.

```txt
class a   may ride hosted sync. Reader set: user + operator. Data the
          user already trusts to the plane: notes, todos, transcripts,
          mail annotations, run rows for opted-in repos.

          (hygiene option inside class a, not a class: a consumer MAY
          encrypt its bulk payload blobs before blobs.add under the
          vault keyring, per ADR-0090. Reader set unchanged; breach
          surface smaller. Built only behind the section-9 trigger.)

class b   never rides hosted sync, in any costume, including inside a
          server-derived envelope: ledger rows, mail bodies, message
          bodies. The class is defined by a reader-set promise no
          operator-held key can satisfy. Cross-device class-b is
          attach (E2E session) or nothing.

class c   self-host relocates the operator and dissolves class b for
          that deployment. Unchanged.
```

The honest ladder of "who can read," for completeness: class a and the
envelope share a rung; the next rung up is E2E artifacts (the ADR-0080
content-blind session relay, a client-held-key store), and the top is class c.
The envelope is not a rung.

## 6. Use-case matrix

The mission's four use cases, tested against the envelope. The pattern across
the matrix: in no case is operator-readability the binding constraint that
encryption would relieve. Each case fails or succeeds for reasons the envelope
cannot touch.

```txt
use case            envelope changes verdict?   binding constraint            verdict
iMessage summary/   no                          urgency (a summary is wanted  stays refused
query                                           now); phantom need (Apple
                                                already syncs Messages to
                                                the user's devices); result
                                                bodies still operator-
                                                readable either way

iMessage send       no                          no upstream idempotency key;  stays refused
                                                maximally urgent; irrevers-
                                                ible external side effect
                                                (refused outright, not
                                                approval-gated). Encryption
                                                is orthogonal to all three.

Local Mail body     no                          materialize already gives     stays materialize;
queries                                         every device its own Gmail    no job exists to
                                                mirror (100 grants, ADR-      encrypt
                                                0081). A desktop-query job
                                                solves a problem the phone
                                                solves better first-hand.

Local Books         no                          the promise is a reader-set   stays attach /
queries                                         claim ("never leaves the      self-host; hot-
                                                box"); an operator-derivable  cache stays behind
                                                key leaves the operator a     seam-2 Q1
                                                reader. Only self-host or
                                                the E2E hot-cache honors it.

coding-agent runs   marginally (at-rest         (1) the class question is     stays trusted-cloud
                    hygiene on payload/result   Q2, and the envelope does     data if hosted,
                    blobs), but under-covers    not change its honest         or self-host;
                                                answer; (2) the sensitive     revisit on the
                                                content also flows through    section-9 trigger
                                                the child doc's Y.Text
                                                progress stream, which an
                                                envelope cannot cover
                                                without reviving encrypted-
                                                CRDT machinery (PR #2023's
                                                deleted layer)
```

The coding agent deserves the extra sentence because it is the only real
candidate. Its transcript stream is the trap: a coding run's sensitive content
is the streamed diff and log, not just the enqueued payload and final result
blob. An envelope over the blobs with a plaintext Y.Text transcript protects
the part nobody was worried about and leaks the part they were. Covering the
stream means per-update CRDT encryption, which is `createEncryptedYkvLww`
generalized to Y.Text: the exact layer PR #2023 deleted, with compaction and
tri-state reads back in tow. So the envelope either under-covers (dishonest)
or grows back into the thing it promised to stay smaller than.

## 7. Honest product copy

The copy test is the cheapest way to see the verdict. Write the sentence each
tier can honestly say:

```txt
class a today       "Synced through Epicenter Cloud. Epicenter can
                    read it, like your notes."

with envelope       "Encrypted in sync storage. Epicenter's service
                    can still decrypt it on hosted."

E2E / class c       "Epicenter cannot read this."
```

The envelope sentence is the problem. Written honestly, it promises nothing
the class-a sentence did not already cover; no user upgrades their trust
because of it. Written shorter ("encrypted," "private," a lock icon), it
implies the third sentence while delivering the first, which is the false
privacy claim ADR-0068 forecloses. There is no wording between honest-and-
worthless and dishonest, because the underlying property has no user-visible
edge. The vault survives this test only because its copy never mentions
encryption at all ("Synced to your devices" vs "Saved only on this device");
the encryption is an operational detail, not a promise. Job payloads have no
equivalent promise-free framing that would make the envelope worth stating.

## 8. Code families the envelope reintroduces

Counted against PR #2023's deletion ledger. "Narrow" shrinks N; it does not
delete the family.

```txt
family                        avoided by narrowing?
server keyring plumbing       shared with the vault wiring (coming anyway
                              if the vault ships), so marginal cost is low;
                              but the envelope makes it load-bearing for
                              every job-emitting app, not one store
key rotation / version        no. Root rotation means every surviving blob's
retention                     key version must stay derivable forever;
                              dropping a version is silent data loss
unreadable states             shrunk, not avoided. A device whose keyring
                              fetch failed (offline boot, auth hiccup) holds
                              ciphertext rows; every job list, approval
                              screen, and audit view grows a third state.
                              This is ADR-0003's collapse reversing.
approval over ciphertext      new, and consent-critical. The memo's rule is
                              approval "scoped to the exact visible payload";
                              decrypt-before-display becomes part of the
                              consent path, and a decrypt failure is now an
                              approval-blocking error class
boot ordering                 new dependency: keyring before job UI, per app
per-app integration           multiplied by design: no generic jobs table
                              means each app's runs table re-pays encrypt/
                              decrypt/error wiring
migration + dual-read         once per adopting table
server-side blindness         the plane's whole reason for plaintext (ADR-
                              0004): any future server-side run search,
                              hosted dashboard, or server materialization
                              over jobs goes blind on payloads
UI copy / trust lines         once per job-creating surface, and per section
                              7 there is no good sentence to put there
```

Verdict on the packet-4 question (does a narrow envelope avoid these or hide
them): it hides them. Blob-only scope genuinely avoids the CRDT-encryption and
compaction families, but rotation, unreadable states, approval-over-
ciphertext, and boot ordering return at reduced N, and the per-app structure
of the mailbox multiplies them back up.

## 9. Smallest next experiment, and the trigger to revisit

No encryption experiment now. The experiments that actually gate this space:

1. Workers V1 (vision memo section 13), unchanged. It tests the mailbox on
   class-a payloads and needs no envelope.
2. Ship the vault keyring wiring
   (`specs/20260701T150000-api-keyring-and-vault-wiring.md`). It is the shared
   prerequisite for any future envelope, it is already specified, and it has
   its own consumer. If the envelope is ever earned, its keys come from there
   and the marginal server work is near zero.
3. Put Q2 in front of real hosted users as a copy test, not a crypto test:
   "run payloads and transcripts are readable by Epicenter, like your notes."
   If that sentence loses the segment, the remedy on the table is self-host
   reachability or E2E, and knowing that early is cheaper than building the
   middle thing nobody asked for.

The trigger that reopens this memo, stated so it is checkable: a real, named,
paying segment says it would run hosted coding agents if run content were
encrypted at rest, while explicitly accepting the "Epicenter can decrypt"
sentence (this is ADR-0068's deferred segment becoming real, applied to runs);
or a compliance requirement from a committed customer demands application-
layer encryption at rest. If either fires, the build is the narrow shape from
the feasibility evidence: consumer-side `encryptBytes` before `blobs.add`
(the ADR-0090 seam), keys from the vault keyring endpoint, plaintext rows,
blob-only scope, one consuming app; plus a solved design for the transcript
stream (for example: the Y.Text stream carries operational plaintext only,
status and progress, while all content chunks ride encrypted blobs). Without
the stream design, the envelope under-covers and should not ship.

What would falsify the reject beyond those triggers: nothing else. In
particular, "it would be easy" is not a trigger; section 2 shows it was always
easy, and easy was never the question.

## 10. ADR and spec impact

```txt
vision memo    amend section 8 with the reader-set paragraph (section 4
               here) and the class-a hygiene annotation (section 5 here).
               The class model itself is unchanged and correct.

new ADR        when the memo's cross-device ADR is written (its section 11),
               include one line: "server-derived encryption of job payloads
               is refused; it shrinks breach surface, not the reader set,
               and cannot move a payload between classes." That forecloses
               the re-litigation this memo answers.

ADR-0004       no amendment. Its considered-alternatives already rejected
               this memo's candidate by name.

ADR-0068       no amendment. Its deferred "encrypted hosted mode" trigger is
               restated, checkably, in section 9 here.

ADR-0074       no amendment, one caution: do not cite it as precedent for
               content envelopes. Its rationale is credential density; the
               exception does not widen to content.

ADR-0090       no amendment. It is the sanctioned seam if the trigger fires.

this spec      deleted once the vision memo's section 8 is amended and the
               cross-device ADR carries the one-line refusal; git keeps the
               body recoverable.
```

## 11. Open product-owner questions

1. Q2, restated under the addendum and still the real question: for hosted-sync users, is repo
   content acceptable trusted-cloud data, or is the coding agent a self-host/
   overlay feature? The envelope does not change the honest answer; only the
   user's trust in the operator does.
2. If a compliance-driven segment appears ("encrypted at rest" as a
   procurement checkbox), do we serve it with the narrow blob envelope, or
   route it to self-host on principle? The checkbox is satisfiable honestly;
   the question is whether Epicenter wants to sell a property with no
   user-visible edge.
3. Does the vault stay the only server-derived-keyring consumer until a
   section-9 trigger fires? Recommendation: yes, and the vault wiring should
   ship on its own merits regardless.
4. Mail-query results: if product ever wants them on hosted sync, are they
   acceptable trusted-cloud data? Moot while materialize covers the phone
   story, but worth answering once so nobody reaches for the envelope as a
   compromise.

---

## Addendum: no third mode, no opt-in dial (2026-07-06, founder direction)

Product rule, stated by the owner after the verdict above:

```txt
Hosted Epicenter is trusted managed sync. Epicenter can read synced payloads.
Self-hosted Epicenter relocates the operator to the user.
There is no third "hosted but Epicenter cannot read" mode for v1.
There is also no per-dataset privacy opt-in dial in v1.
```

This addendum supersedes the earlier deployment-plus-opt-in framing. The
collapse goes one step further: privacy is chosen at deployment time, not per
feature, per dataset, or per command. If a payload rides hosted sync, the
product treats it as trusted-cloud data. If that is not acceptable, the answer
is self-host.

### A1. Does this simplify the privacy model?

Yes. The model is now two deployments and zero privacy dials:

```txt
hosted      operator = Epicenter. Epicenter can read synced payloads.
self-host   operator = the user. Epicenter is not in the data path.
```

This is the shortest honest rule and it aligns directly with ADR-0068:
privacy is the choice of which computer runs the program, not a toggle inside
the app. A per-dataset "Epicenter can read this" dial sounds precise, but it
reintroduces a privacy settings surface and implies other hosted data may have
a different reader set. It does not. Hosted sync is trusted sync.

The rule governs the sync plane only. Attach (ADR-0080) stays a live session
over the user's own overlay, and a future content-blind relay remains a
transport question, not a hosted-sync privacy mode. Server-derived encryption
also stays outside the product model: it may be used later as unmarketed
storage hygiene for a concrete compliance need, but never as a mode, a class,
a lock icon, or a reason to move sensitive data onto hosted sync.

### A2. Does the iMessage verdict change?

Yes, but only by deployment.

```txt
hosted      no iMessage feature in v1. Hosted sync is readable by Epicenter,
            and message bodies are too sensitive to make a default hosted
            product promise around them.

self-host   query and summarize jobs are viable because the operator is the
            user. Send jobs are admissible only under A4.
```

The original refusal stacked four arguments: bodies on the hosted anchor, no
send idempotency, urgency, and phantom product need. Self-host dissolves the
hosted-reader problem. The phantom-need argument also narrows: Apple syncs the
Messages app to the user's devices, but it does not give an agent query
access. "What did Mom say about Thursday?" asked from a phone to a self-hosted
assistant whose Mac holds `chat.db` is a real agentic need Apple does not
serve.

Send remains the hard case. Money stays refused. A duplicate or late text is
apology-recoverable, so send can be admitted on self-host, but only with every
rule in A4; missing any one of them, it reverts to refused.

### A3. The observe/job model for a self-hosted iMessage assistant

The section-7 kernel, applied. No new platform machinery.

```txt
tables       the Messages app owns its own domain tables: queries and sends.
             There is no generic jobs table.

executor     one immutable AgentId: the Mac running the daemon with access to
             chat.db for reads and Messages automation for sends. Set at row
             creation, never reassigned.

query row    question/filters as columns; executor claims by writing the
             started record keyed to the job id; streams progress into the
             child doc; writes a write-once result with bodies as blob refs.
             Results land on the self-hosted plane, whose operator is the
             user.

send row     recipient + exact literal text (+ attachment hashes) as the
             payload; durable approval record in the child doc scoped to
             exactly that content; short expiry; outcome write-once.

presence     decoration only: "Mac asleep; will answer when it wakes."

hosted       not offered in v1. There is no opt-in dial to convert iMessage
             payloads into a hosted feature.
```

The same observe structure still works on hosted for ordinary trusted-cloud
features. The distinction is product permission, not a different mechanism.
The coordination layer remains sync in both deployments.

### A4. Mandatory safety rules for send-message jobs

All seven, conjunctive; any missing rule reverts send to refused.

1. Exact-payload approval: the durable approval record binds recipient and
   the full literal text (and attachment hashes) by content hash to the job
   id. Any edit invalidates the approval. Approval policy for send verbs is
   always ask; there is no per-verb auto for sends, ever.
2. Short expiry, set at creation (minutes, not hours). The executor checks
   it at claim time and again immediately before the send call, so a job
   enqueued against a sleeping Mac expires cleanly instead of firing stale.
3. Requester-minted job id as the idempotency key, enforced by a durable
   executor-local send ledger: the executor records intent-to-send in the
   ledger before invoking the send, and consults it on every claim. iMessage
   offers no upstream idempotency; this ledger is the substitute, and it
   must survive crash and restart.
4. No auto-retry after unknown outcome: a crash between intent-to-send and
   the outcome record terminates the job in a write-once `unknown` state
   surfaced to the human. Retry is a new row with a new approval.
5. Claim before send: the started record keyed to the job id is written
   before any side effect, so a second observer reconciles and stops.
6. Cancellation honored up to the point of no return, which is defined as
   the moment intent-to-send hits the local ledger.
7. Money-shaped verbs stay refused outright. The message/money split in A2
   is a floor, not a precedent for other irreversible verbs.

### A5. Exact edits to the two specs

`specs/20260706T220000-cross-device-coordination-vision.md`:

1. Section 8: replace the three-class table with the two-deployment model:
   hosted means trusted managed sync; self-host relocates the operator to the
   user; no third mode and no per-dataset privacy dial in v1. Keep the
   reader-set paragraph from this memo.
2. Section 7, the gates: gate (c) becomes "permitted on this deployment's
   sync plane." On hosted, that means ordinary trusted-cloud data only. On
   self-host, sensitive observe jobs become viable because the operator is the
   user. Money remains refused; send-message is admissible only under A4.
3. Section 4, iMessage row and prose: from "refused (fails every gate)" to
   "hosted: not offered in v1; self-host: query/summarize via observe, send
   only under the safety ruleset." The old counterexample paragraph is
   rescoped to hosted.
4. Section 12, refusal #6: reword to "Epicenter does not build a hosted
   iMessage feature; a self-hosted assistant may observe Messages on the
   user's own deployment."
5. Section 14: remove the hosted opt-in wording. Keep the concrete product
   question: is repo content acceptable trusted-cloud data, or is the coding
   agent self-host/overlay-only?

This memo (`20260706T233000-encrypted-job-envelope-strategy.md`):

6. Section 5's table is now transitional. The final model is deployment-based,
   not class-based: hosted trusted sync vs self-host.
7. Section 9's compliance trigger is subordinated to the no-third-mode rule:
   unmarketed storage hygiene only, never a mode.
8. Section 11 Q4 is answered: there is no opt-in dial for mail-query results
   in v1. If mail bodies are not acceptable trusted-cloud data, they do not
   ride hosted sync.

### A6. Which ADR records this

The new cross-device coordination ADR, not an ADR-0068 amendment. ADR-0068
already says the load-bearing sentence: privacy is the choice of which
computer runs the program, not a toggle inside the app. The new ADR should
carry this concrete application of that rule: replicate/materialize/observe/
attach; hosted as trusted sync; self-host as the privacy answer; no third mode;
no per-dataset privacy dial; the one-line envelope refusal; the reworded
mailbox gates; and the A4 send ruleset. It cites ADR-0004, ADR-0068, ADR-0074,
ADR-0080, and ADR-0090 as evidence. Both this spec and the vision memo are
then deleted per hygiene once the ADR lands.
