# Cloud inference credit billing and margin

- **Status:** Draft
- **Date:** 2026-08-26
- **Owner:** Braden Wong
- **Branch:** `braden-w/update-autumn-deepwiki-docs` (design only; no implementation yet)
- **Relates:** ADR-0100 (AI credits are product units), ADR-0075 / ADR-0076
  (billing and the relational-auth substrate are Cloud-only), ADR-0054 (the
  gateway is house-key-only, every call is metered).

## One sentence

A hosted AI call is priced in credits at a fixed peg of 1 credit = $0.01,
derived from a models.dev cost snapshot times a per-model/provider markup; chat
pre-charges a guaranteed upper-bound before the call and transcription settles
the provider's authoritative duration under a hard cap, so charged credits
always cover provider cost plus margin, and self-host inherits only the model
catalog, never the pricing.

## How to read this spec

```
Read first:      One sentence, Motivation, Target shape, Success criteria
Read for model:  Research findings, Design decisions, Architecture
Read to build:   Implementation plan, Edge cases, Open questions
```

## Motivation

### Current state

Per-model credit cost lives in the shared catalog and is imported by the
billing-agnostic library route AND by cloud billing:

```ts
// packages/constants/src/ai-providers.ts  (imported by packages/server AND apps/api billing)
export const AI_MODELS = [
  { id: 'gpt-5.4-mini', provider: 'openai', label: 'Fast', credits: 2 },
  { id: 'gpt-5.5',      provider: 'openai', label: 'Best', credits: 10 },
] as const;
```

Chat reserves a fixed per-model credit lock; transcription gates then settles
per audio minute:

```ts
// apps/api/worker/billing/service.ts (chat)  -> a FIXED credit per model, per message
const { credits } = MODELS_BY_ID[model];              // e.g. 10, regardless of context size
await autumn.check({ featureId: 'ai_usage', requiredBalance: credits, lock });
```

This creates problems:

1. **Long-conversation margin leak.** Fixed-per-model is fixed-per-message. Every
   chat turn re-sends the whole conversation as input tokens, so a message in a
   30k-token thread costs the provider many times a message in a fresh thread,
   but is charged the same fixed credit. The undercharge lands on exactly the
   heavy users whose context is large.
2. **Pricing leaks into the shared registry.** `AI_MODELS.credits` couples a
   Cloud-only pricing concern into the catalog that the billing-agnostic library
   route and the self-host instance both import. An instance carries a field it
   must never use (ADR-0075, ADR-0076).
3. **No cost freshness.** Per-model credits are hand-set. When a provider changes
   its token price, the margin silently drifts until someone notices.

### Target shape

- A credit is a fixed, published `$0.01`, never re-rated. Only per-model credit
  cost changes, and only through a reviewed price update.
- Per-model provider cost comes from a committed models.dev snapshot times a
  layered markup; a daily CI job keeps the snapshot fresh through a PR.
- Chat charges a guaranteed upper-bound before the call (profit-safe, abuse-safe,
  no settle). Transcription settles the provider's returned duration under a hard
  upload cap.
- The shared catalog holds only `{ id, provider, label, capabilities }`; all
  pricing lives in Cloud billing.

## Research findings

### How comparable products denominate usage

Two research passes (model providers + developer tools), grounded in primary
sources 2026-08-26. Full source list at the end.

| Product | Unit | Peg | Multi-model handling | Lesson |
|---|---|---|---|---|
| OpenRouter | credits | **1 credit = $1**, no token markup | real per-token cost, no multiplier | cleanest mental model; margin on a purchase fee, not inference |
| Anthropic (marketplace CCU) | Consumption Unit | **1 CCU = $0.01**, defined in contract | rate in dollars, then convert; discounts = fewer units metered | the playbook for a self-priced credit: fixed peg, never devalue the unit |
| GitHub Copilot | abstract "premium request" | ~$0.04 overage backstop | **per-model multiplier** (0.25x to 27x+) | multipliers make cost visible but drive sticker-shock press |
| Cursor / Replit / Windsurf | dollar pool / effort / flow-credits | mixed | raw cost or hidden "effort" | every repricing disaster was a comms/predictability failure, not a price level |
| ChatGPT / Claude.ai | hidden message quotas | none shown | per-tier caps ("5x/20x more") | undefined-in-absolute quotas + silent tightening = backlash |

**Key findings:**

- Developer/API surfaces converge on **raw dollars per token**; nobody invents an
  abstract credit there. Abstract credits appear only to hide token math or where
  a marketplace forces a single line item.
- The strongest precedent for a self-priced credit is a **fixed dollar peg**
  (Anthropic CCU = $0.01), with discounts applied at conversion, never by
  changing what a unit is worth.
- **Per-model multipliers as the user-facing unit** ("5x/20x") are the top
  complaint: undefined in absolute terms.
- **Repricing and silent quota-tightening are the top backlash driver**, more
  than the choice of unit.

**Implication:** credit = fixed $0.01 peg, published, never re-rated; per-model
cost is internal arithmetic surfaced only as a credit count.

### The cost source: models.dev

- **models.dev is MIT**, with public `api.json` / `catalog.json` endpoints and
  per-provider TOML source, explicitly "vendorable and downloadable." Shape:
  `provider -> model -> cost { input, output, cache_read, cache_write,
  input_audio, output_audio, reasoning, tiers }` per million tokens.
- **Autumn is Apache-2.0** and fetches `https://models.dev/api.json` **live at
  request time** (5s timeout, Redis cache, stale fallback). We take the idea
  (models.dev is the price oracle) but not the pattern: a live fetch in the
  billing hot path is the wrong default for fail-closed billing and would ingest
  a bad community edit instantly. A committed snapshot behind a PR is safer.

### Autumn's `ai_credit_system`, and why it is rejected

Present and typed in the pinned `autumn-js@1.2.34` / `atmn@1.1.9`. It is a
dollar balance priced from models.dev + markups, metered by `trackTokens`. It is
**rejected** because it is token-only (`trackTokens` cannot meter duration-based
STT), which fractures the single credit wallet ADR-0100 established, and its
native flow has no pre-spend lock. The self-priced credit_system keeps one
wallet, keeps the pre-spend guard, and keeps pricing sovereignty.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Credit unit | 3 taste + 1 evidence | Fixed peg, 1 credit = $0.01, published, never re-rated | Anthropic CCU precedent; re-rating the unit is the top trust failure. Only per-model credit cost changes. |
| Chat billing shape | 2 coherence | Pre-charge a guaranteed ceiling before the call, no settle | For chat the ceiling is tight (input exact + output capped), so charging it overcharges little; deducting up front is profit-safe, abuse-safe, concurrency-safe, and needs no settle infra. |
| STT billing shape | 2 coherence | Pre-gate + hard upload cap, then settle the provider's returned duration | For STT the ceiling is far above the actual (a clip is 3s to 60min), so charging the ceiling would overcharge 20-100x. Provider duration is authoritative and matches what we are billed. |
| Registry split | 2 coherence | Shared catalog `{id, provider, label, capabilities}`; pricing Cloud-only | Keeps the library route and self-host free of any pricing (ADR-0075, ADR-0076). |
| Cost source | 1 evidence | Committed models.dev snapshot; daily CI PR that auto-merges when data-validity assertions pass, else blocks | models.dev is MIT with `api.json`; a committed snapshot gives audit history and no hot-path fetch. Bright-line assertions catch corrupt data; markup + git revert are the other two defense layers. No fuzzy magnitude gate. |
| Markup model | 3 taste | Layered `defaultMarkup` / `providerMarkups` / `modelMarkups`, most-specific wins; start 1.5x to 2x cost | The profit dial. No single market rate exists (OpenRouter ~0% + fees, wrappers 2x-5x), so it is positioning. Start high (raising prices triggers backlash, discounting does not) and below the self-host-with-own-key escape hatch. |
| Reject `ai_credit_system` | 1 evidence | Keep self-priced `credit_system` | Token-only, fractures the STT wallet, cedes pricing sovereignty. |
| Full reserve-then-settle token accuracy | Deferred | Deferred | Graduate only if the ceiling overcharge is shown to cost real fairness or the margin proves coarse. Not needed for the profit goal. |

Load-bearing decisions to record as ADRs when this lands: amend ADR-0100 for the
credit peg and the pre-charge-chat / settle-STT pricing shape; a new ADR for the
catalog/pricing split and the models.dev CI registry.

## Architecture

### Registry split

```
@epicenter/constants/ai-providers   { id, provider, label, capabilities }   <- shared: library route + self-host
apps/api/worker/billing/pricing/    { modelId -> cost, markup, peg -> credits }   <- Cloud-only
```

The library `mountInferenceApp` stays billing-agnostic. Cloud wraps it with the
billing policy; self-host mounts it bare and unmetered. Nothing changes for
self-host except that it stops importing a `credits` field it never used.

### The pricing loop

```
models.dev/api.json
     |  daily GitHub Actions job
     v
recompute cost snapshot for the served set  ->  recompute per-model credit cost
     |
     v
open a PR that auto-merges when data-validity assertions pass, else blocks for review
   - assertions (bright lines, not a fuzzy magnitude gate): every cost > 0,
     every cost under an absolute per-token ceiling, every served model present
   - a served model missing from models.dev fails the job -> set manualCost or block
   - backstops: the markup absorbs normal drift; git history makes any merge one revert away
     |
     v
committed Cloud pricing registry  ->  read at request time (no live fetch)
```

### Chat: pre-charge the guaranteed ceiling

```
1. count input tokens with the provider's tokenizer, padded so the count >= the provider's billed prompt_tokens
2. output tokens = the request's max_tokens, clamped to the per-deployment ceiling
3. ceilingCost = inputTokens * inputRate + outputTokens * outputRate
4. credits = ceil( ceilingCost * (1 + markup) / 0.01 ), floor 1
5. deduct `credits` BEFORE forwarding; deny fail-closed if the wallet cannot cover it
6. forward the call
```

No lock-then-settle, no `override_value`, no streaming usage extraction. Apps
request the `max_tokens` they need; the gateway clamps it to a per-deployment
ceiling (Cloud enforces one as an abuse bound, self-host may leave it loose) and
charges the clamped value, so a short-output app is charged less.

### Transcription: cap, gate, settle

```
1. reject the upload if longer than the max duration/size cap (abuse bound)
2. pre-gate: wallet non-empty (fail closed)
3. forward the call
4. after 200: credits = ceil( durationMin * perMinuteCost * (1 + markup) / 0.01 ), floor 1
   (durationMin from the provider's returned verbose_json duration)
5. track `credits` off the after-response queue
```

## The profit invariant

For any call:

```
profit = (credits_charged * $0.01) - actual_provider_cost
```

Because `credits_charged * $0.01 >= actual_cost * (1 + markup)` (chat charges a
ceiling >= actual; STT charges the actual), this reduces to a guarantee:

```
profit per call  >=  actual_provider_cost * markup
```

**The markup is the guaranteed floor margin.** The ceiling overcharge (chat) and
the round-up are bonus. Profit is never negative while the cost snapshot is fresh
and markup > 0.

### Worked example: chat (gpt-5.5, 20k-token thread, 40% markup)

Rates illustrative; the CI registry supplies real numbers.

| step | value |
|---|---|
| input / output rate (models.dev) | $1.25 / $10 per 1M tok |
| input tokens (exact, before call) | 20,000 |
| output cap (`max_tokens`) | 2,000 |
| ceiling cost = 20000*1.25/1M + 2000*10/1M | $0.045 |
| priced = ceiling * 1.40 | $0.063 |
| credits charged = ceil(0.063 / 0.01), deducted before call | 7 |
| actual output (after) | 500 tok |
| actual cost = 20000*1.25/1M + 500*10/1M | $0.030 |
| revenue = 7 * $0.01 | $0.070 |
| profit | $0.040 |

Worst case (reply hits the 2,000 cap, actual cost $0.045): revenue $0.070,
profit $0.025. Still positive: the markup plus round-up. Cannot lose.

### Worked example: transcription (90s clip, whisper, 40% markup)

| step | value |
|---|---|
| per-minute cost | $0.006 / min |
| upload cap | 60 min (reject if longer) |
| provider-returned duration | 90s = 1.5 min |
| actual cost = 1.5 * $0.006 | $0.009 |
| priced = 0.009 * 1.40 | $0.0126 |
| credits charged = ceil(0.0126/0.01), floor 1 | 2 |
| revenue = 2 * $0.01 | $0.020 |
| profit | $0.011 |

Worst-case abuse: a 60-min upload costs 60 * $0.006 = $0.36 before the
after-charge lands. Bounded by the cap, and cheap; that is why settle-after is
safe for STT and not for chat.

## Implementation plan

### Phase 1: split the registry

- [ ] **1.1** Reduce `@epicenter/constants/ai-providers` to `{ id, provider, label, capabilities }`; remove `credits`.
- [ ] **1.2** Confirm the library route (`packages/server/src/routes/inference.ts`) only needs the catalog (model allow-list, provider routing).
- [ ] **1.3** Move per-model pricing to `apps/api/worker/billing/pricing/`.

### Phase 2: pricing registry and peg

- [ ] **2.1** Cloud pricing registry: `modelId -> { inputCost, outputCost, ... }` cost snapshot (seeded from models.dev) plus layered markup config.
- [ ] **2.2** Resolver: `creditsForCeiling(model, inputTokens, outputCap)` and `creditsForDuration(model, minutes)`, peg `$0.01`, `ceil` + floor 1.
- [ ] **2.3** Fail closed on a model with no cost.

### Phase 3: chat pre-charge (replace fixed reserve)

- [ ] **3.1** Count input tokens with the provider's tokenizer (padded so the count >= billed `prompt_tokens`); take the request's `max_tokens` clamped to the per-deployment ceiling as the output term.
- [ ] **3.2** Deduct the ceiling credits before forwarding; deny fail-closed on insufficient balance.
- [ ] **3.3** Remove the fixed per-model reserve/lock path for chat.

### Phase 4: transcription cap + settle

- [ ] **4.1** Enforce the max duration/size cap before forwarding.
- [ ] **4.2** Keep the wallet pre-gate; settle the provider's returned duration after 200.

### Phase 5: models.dev CI sync

- [ ] **5.1** Daily GitHub Actions job: fetch `api.json`, update the cost snapshot for the served set, recompute credits.
- [ ] **5.2** Open a PR that auto-merges when data-validity assertions pass (every cost > 0, under an absolute per-token ceiling, every served model present); otherwise block for review.
- [ ] **5.3** Fail the job (or block the model) when a served model is missing from models.dev with no `manualCost`.

### Phase 6: prove and remove

- [ ] **6.1** Property test: `credits_charged * peg >= provider_cost` across a fuzzed matrix of models, context sizes, and output lengths.
- [ ] **6.2** Typecheck self-host and confirm it imports no pricing.
- [ ] **6.3** Delete the dead fixed-credit path.

## Edge cases

### Stale snapshot vs a provider price rise
The daily CI narrows the window; the markup buffer absorbs normal drift; a rise
appears as a PR that raises the charge. Keep the markup healthy, not razor-thin.

### A served model missing from models.dev
CI flags it. Set a `manualCost` in the registry or block the model. Never charge
$0 for an unknown-cost model.

### Cache discounts
Do not assume them. Charge the full input rate. Getting the discount over-profits
(fine); assuming it and not getting it would lose money.

### Concurrency
Chat deducts up front, so N simultaneous calls each deduct before forwarding; no
call slips past a stale balance. STT retains a bounded overspend window, capped
by the upload limit.

### Free tier / promotions
Deliberate bounded losses, capped by the grant. A business choice, not a leak.

## Open questions

Items 1 to 4 were resolved in design review; item 5 stays deferred.

1. **Input token counting before the chat call. Decided: per-provider tokenizer, padded.**
   Tokenize the full payload with the provider's own tokenizer (tiktoken for
   OpenAI, Gemini's for Gemini) and pad up so the count is >= the provider's
   billed `prompt_tokens`; undercounting is the only way a tokenizer loses money.
   Output stays the clamped `max_tokens`, no tokenizer. Evidence item for the
   implementer: confirm both tokenizers run in a Cloudflare Worker (tiktoken has
   a WASM build; verify the Gemini one).

2. **Output cap. Decided: per-request, clamped by a per-deployment ceiling.**
   The app sends `max_tokens` for what it needs; the deployment clamps it to a
   hard ceiling (Cloud enforces one as an abuse bound, self-host may leave it
   loose) and charges the clamped value, so a short-output app is charged less
   and its overcharge shrinks on its own. Not a per-app config axis: the gateway
   is keyed by principal, and the app already expresses its need through the
   `max_tokens` it sends.

3. **Markup. Decided: start 1.5x to 2x cost (default), tune per model.**
   No single market rate exists (OpenRouter ~0% plus fees; wrappers 2x to 5x), so
   it is positioning, not a lookup. Two constraints: start high, because raising
   prices triggers backlash while discounting never does; and stay below the point
   where self-hosting with an own key is obviously worth it (the metered gateway
   is house-key-only, so self-host is the only escape hatch). Revisit with usage
   data.

4. **models.dev sync merge policy. Decided: auto-merge on data-validity assertions, no fuzzy threshold.**
   A relative "is this move big" gate is a band-aid that needs tuning. Replace it
   with hard assertions (every cost > 0, every cost under an absolute per-token
   ceiling, every served model present) and auto-merge anything that passes. That
   catches corrupt data (a $0 or 100x edit, a vanished model) on a bright line,
   while the markup absorbs normal drift and git history makes any merge one
   revert away. Always-manual is rejected: a daily boring diff degrades into
   rubber-stamping, which is worse than a machine assertion you can trust.

5. **Ever settle chat output down?**
   - Deferred. Only if the ceiling overcharge is shown to cost real fairness.

## Success criteria

- [ ] Property test holds: `credits_charged * $0.01 >= provider_cost` for every served call across a fuzzed matrix.
- [ ] A message in a long thread costs more credits than the same message in a fresh thread.
- [ ] Self-host typechecks and runs with no pricing import and no billing surface.
- [ ] The CI job opens a PR on models.dev drift and blocks (or flags) a served model missing from models.dev.
- [ ] The credit peg ($0.01) is published and never changed by the pricing job; only per-model credit cost changes.

## References

- `packages/constants/src/ai-providers.ts` - the catalog to slim (remove `credits`).
- `packages/server/src/routes/inference.ts` - billing-agnostic library route; catalog consumer.
- `apps/api/worker/billing/service.ts` - chat reserve and STT settle to rework.
- `apps/api/worker/billing/policies.ts` - the Cloud-only gateway wrappers.
- `apps/api/worker/billing/catalog.ts` - current pricing home; where the registry grows.
- `docs/guides/billing-autumn-boundary.md` - the current billing design.
- `.agents/skills/autumn/SKILL.md` - Autumn conventions and the `ai_credit_system` note.
- models.dev (MIT, `api.json`); Autumn (Apache-2.0). Comparable pricing sources
  captured 2026-08-26: GitHub Copilot request multipliers, OpenRouter FAQ,
  Anthropic pricing (CCU), Cursor/Replit/Windsurf repricing write-ups.
```
