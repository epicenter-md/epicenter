# Cloud inference credit billing and margin

- **Status:** In Progress
- **Date:** 2026-08-26
- **Owner:** Braden Wong
- **Branch:** `braden-w/inference-credit-billing` (Phase 1 landed)
- **Relates:** ADR-0100 (AI credits are product units), ADR-0075 / ADR-0076
  (billing and the relational-auth substrate are Cloud-only), ADR-0054 (the
  gateway is house-key-only, every call is metered), ADR-0104 (layered catalog).

## One sentence

A hosted AI call is metered in credits pegged at a fixed $0.01, computed by our
own per-model token cost (models.dev times a markup); every metered call gates on
a positive balance, runs, then settles the provider's actual returned usage with
overflow, so a last call at exhaustion may go a bounded negative that nets against
the next top-up; the whole meter is one Cloud-only middleware that chat and STT
share and self-host omits, and the shared catalog carries no pricing.

## How to read this spec

```
Read first:      One sentence, Motivation, The metering pattern, Success criteria
Read for model:  Research findings, Design decisions
Read to build:   Implementation plan, Edge cases, Open questions
```

## Motivation

### Current state

Phase 1 (landed) already split pricing out of the shared catalog:
`@epicenter/constants/ai-providers` now carries only `{ id, provider, label }`,
and per-model cost lives Cloud-only in `apps/api/worker/billing/model-pricing.ts`.
What remains:

- **Chat** still charges `INTERIM_FIXED_CHAT_CREDITS` (a fixed credit per model,
  2/10/2) through a reservation lock (`reserveAiChat` + `balances.finalize`).
- **Transcription** already gates (`checkAiCredits`) then settles the actual
  audio duration after the call (`trackAiTranscription`).

Problems that remain:

1. **Long-conversation margin leak.** Fixed-per-model is fixed-per-message. Every
   chat turn re-sends the whole conversation as input tokens, so a message in a
   30k-token thread costs the provider many times a message in a fresh thread but
   is charged the same. The undercharge lands on the heaviest users.
2. **Two mechanisms, one job.** Chat reserves a lock; STT settles after. Same
   goal (meter a fallible call), two shapes, more to understand and to keep in
   sync, including for anyone reading the code who will never bill (self-host).

### Target shape

- A credit is a fixed, published $0.01, never re-rated. Only per-model cost
  changes, and only through a reviewed price update.
- One metering pattern for every metered call: **gate on a positive balance, run,
  settle the provider's actual returned usage.** No lock, no pre-call estimate.
- Overspend uses `overageBehavior: "overflow"`: the last call at exhaustion may
  go a bounded negative, netted on the next top-up.
- The meter is a Cloud-only middleware; self-host mounts the bare gateway and
  imports none of it.

## The metering pattern

One shape, shared by chat and transcription:

```
GATE     check({ featureId: ai_usage, requiredBalance: 1 })  -> deny if !allowed
         (free tier additionally restricted to cheap models: FREE_TIER_MAX_CREDITS_PER_CALL)
RUN      proxy to the provider; read the returned usage
         (streaming: request usage in the final chunk, then read it)
SETTLE   credits = perModelCost(realTokens) * (1 + markup) / 0.01, ceil, floor 1
         track({ featureId: ai_usage, value: credits, overageBehavior: "overflow",
                 properties: { model, provider }, async: true })
BOUND    per-call cost cap (request-size + max_tokens) + rate-limit
         + a generous Autumn spend-limit as a backstop
```

Chat's `credits` come from token counts; transcription's from audio minutes.
Everything else is identical. No lock, no `override_value`, no pre-call token
estimate, no tokenizer. The only real work is reading the provider's returned
usage.

Why this is safe without a lock (see Design decisions for the full derivation):
overflow plus netting means any user who tops up again incurs zero bad debt; the
only residual is an abandoning user's single overshoot at exhaustion, bounded by
the per-call cap times the rate-limit, and capped natively by the spend-limit.

## Research findings

### How comparable products denominate usage

Two research passes (providers + dev tools), primary sources 2026-08-26.

| Product | Unit | Peg | Lesson |
|---|---|---|---|
| Anthropic CCU (marketplace) | Consumption Unit | **1 CCU = $0.01**, contract-defined | the self-priced-credit playbook: fix the peg, never devalue the unit |
| OpenRouter | credits | 1 credit = $1, no token markup | cleanest model; margin on a purchase fee |
| GitHub Copilot | premium request | ~$0.04 backstop | per-model multipliers are legible but drive sticker-shock |
| Cursor / Replit / Perplexity | dollar pool / quotas | mixed | every backlash was silent repricing, not the unit |

**Key findings:** developer surfaces bill raw dollars per token; a fixed-dollar-peg
credit is the strongest self-priced precedent; per-model multipliers as the
user-facing unit are the top complaint; silent repricing is the top backlash
driver. So: credit = fixed $0.01, published, never re-rated; per-model cost is
internal arithmetic surfaced only as a credit count.

### Cost source: models.dev

MIT, public `api.json`, vendorable. Shape: `provider -> model -> cost { input,
output, cache_read, ... }` in **USD per 1M tokens**. All three served models are
present: `gpt-5.4-mini` (0.75 / 4.5), `gpt-5.5` (5 / 30, plus a >272k tier),
`gemini-3.5-flash` (1.5 / 9). Whisper has no per-minute price anywhere, so STT is
a manual $0.006/min. Autumn fetches models.dev live at request time; we use a
committed snapshot instead (audit + no hot-path fetch).

### Tokenizer grounding (why there is no pre-call estimate)

No offline Gemini tokenizer fits a Worker (SentencePiece, ~30MB vocab; only a
`countTokens` round-trip is exact), and a local GPT count under-counts once tool
schemas are present. Exact pre-charge is therefore infeasible. This is what drove
the design to settle on the provider's authoritative returned usage instead of
estimating before the call, which also deletes the tokenizer dependency entirely.

### Autumn primitives (grounded)

- **Negative balances:** `track({ overageBehavior: "overflow" })` lets a balance
  go below zero and stay there (netted against future grants/top-ups); default
  `"cap"` floors at zero. After overspend, `check({ requiredBalance: 1 })` returns
  `allowed: false`, so the gate is a normal `check`. A native **spend-limit** still
  applies under overflow and caps how negative a balance can go.
- **Variable per-model charge:** `track({ value: N })` deducts an arbitrary N we
  compute; `properties: { model, provider }` tags the event; `events.aggregate({
  group_by: "properties.model", aggregate_on: "deducted" })` gives per-model spend.
  Autumn never needs per-model costs; we compute the credit and tag it. This is
  already how `trackAiTranscription` works. (`trackTokens` is `ai_credit_system`-only
  and rejected.)

### `ai_credit_system`: rejected

Present in the pinned `autumn-js@1.2.34` / `atmn@1.1.9`, but token-only
(`trackTokens` cannot meter duration-based STT), dollar-denominated, and it
fractures the single credit wallet ADR-0100 established. The self-priced
`credit_system` keeps one wallet and our pricing sovereignty.

## Design decisions

| Decision | Class | Choice | Rationale |
|---|---|---|---|
| Credit unit | 3 taste + 1 evidence | Fixed peg, 1 credit = $0.01, published, never re-rated | Anthropic CCU precedent; re-rating the unit is the top trust failure. Only per-model cost changes. |
| Metering shape (chat + STT) | 1 evidence + 2 coherence | Gate on positive balance, run, settle the provider's actual returned usage; no lock, no pre-call estimate | Grounding: no offline Gemini tokenizer and GPT under-counts with tools, so pre-call estimation is infeasible and unnecessary; settling on the authoritative returned usage is exact and works for both providers. One uniform pattern. Supersedes pre-charge-ceiling and reserve-hold-settle, both rejected as more machinery for no benefit here. |
| Overspend | 1 evidence | `overageBehavior: "overflow"`, netted on top-up | Native Autumn; returning users incur zero bad debt; the last call at exhaustion may go a bounded negative. |
| Bounding | 2 coherence | Per-call cost cap (request-size + max_tokens) + rate-limit + a generous Autumn spend-limit backstop | The real protection is the per-call cap + rate-limit + netting; the spend-limit is cheap native insurance for the abandoning-user tail, NOT the primary bound. Measure before tightening; an affordability gate or balance-aware restriction is the later escalation if bad debt proves material. |
| Registry split | 2 coherence | Shared catalog id/provider/label; pricing Cloud-only | Keeps the library route and self-host free of pricing (ADR-0075/0076). Phase 1, done. |
| Cost source | 1 evidence | Committed models.dev snapshot; daily CI PR auto-merged when data-validity assertions pass | models.dev is MIT with `api.json`; a committed snapshot gives audit and no hot-path fetch. Assertions (every cost > 0, under an absolute ceiling, model present) catch corrupt data; markup + git revert are the other two layers. No fuzzy magnitude gate. |
| Markup | 3 taste | Layered default/provider/model, most-specific wins; start 1.5x | The profit dial and guaranteed floor margin (profit >= cost * markup). No single market rate exists; start high (raising backfires, discounting does not) and below the self-host-with-own-key escape hatch. |
| Per-model tracking | 1 evidence | We compute credits; `track({ value, properties: { model } })`; dashboard via `events.aggregate` | Autumn stores and aggregates; never needs per-model costs. |
| Reject `ai_credit_system` | 1 evidence | Keep self-priced `credit_system` | Token-only, fractures the STT wallet, cedes pricing sovereignty. |

## Architecture

### Registry split (done)

```
@epicenter/constants/ai-providers   { id, provider, label }        <- shared: library route + self-host
apps/api/worker/billing/model-pricing.ts   cost table, markup, peg, credit fns   <- Cloud-only
```

### The pricing loop

```
models.dev/api.json
     |  daily GitHub Actions
     v
update the cost snapshot for the served set  ->  open a PR
     - auto-merge when assertions pass (every cost > 0, under an absolute ceiling, model present)
     - a served model missing from models.dev fails the job -> set manualCost or block
     v
committed Cloud pricing registry  ->  read at request time (no live fetch)
```

### Metering middleware (Cloud-only)

Billing is one middleware the cloud wraps around the library's billing-agnostic
`mountInferenceApp` seam (ADR-0076). Self-host mounts the bare gateway with no
policy and imports none of the billing module.

```
cloud:      mountInferenceApp(app, { policies: [meterInference] })
self-host:  mountInferenceApp(app)                                  // unmetered
```

`meterInference` is the gate/run/settle pattern above, for both `/v1/chat/completions`
and `/v1/audio/transcriptions`.

## The profit invariant

For any call:

```
profit = credits_charged * $0.01 - actual_provider_cost
```

Because `credits_charged = ceil(actual_cost * (1 + markup) / 0.01)`, this gives a
guarantee:

```
profit per call >= actual_provider_cost * markup
```

The markup is the guaranteed floor margin. Settling on actual usage (not a fixed
or estimated amount) is what makes `actual_cost` the real number.

### Worked example: chat (gpt-5.5, markup 1.5x, real models.dev rates 5/30 per MTok)

| | long thread | fresh thread |
|---|---|---|
| input / output tokens (from the response) | 20,000 / 500 | 1,000 / 500 |
| actual cost = in*5/1M + out*30/1M | $0.115 | $0.020 |
| priced = cost * 1.5 | $0.1725 | $0.030 |
| **credits charged** = ceil(priced / 0.01) | **18** | **3** |
| profit = credits*0.01 - cost | $0.065 | $0.010 |

The long thread costs 6x the short one, automatically: the leak is closed by
settling on real input tokens.

### Worked example: transcription (90s clip, whisper, markup 1.5x)

Duration 1.5 min * $0.006 = $0.009 cost; * 1.5 = $0.0135; ceil(/0.01) = **2 credits**;
profit $0.011. Settled on the provider's returned duration.

## Implementation plan

### Phase 1: split the registry (DONE)

- [x] Shared catalog reduced to `{ id, provider, label }`; `credits` removed.
- [x] Cloud `model-pricing.ts`: token cost table (models.dev), layered markup, peg, `creditsForChat` / `transcriptionCredits`, and interim fixed credits.
- [x] `reserveAiChat` charges the interim fixed credit; UI drops the fixed per-model display. Typechecks + billing tests green.

### Phase 2: pricing resolver (mostly done)

- [x] Cost table + markup + peg + credit functions in `model-pricing.ts`.
- [ ] **2.1** Confirm `creditsForChat` handles the >272k tier for `gpt-5.5` (defer if no call can exceed it) and fails closed on a model with no cost.

### Phase 3: chat gate + settle-after (replaces the lock)

- [ ] **3.1** Replace `reserveAiChat`'s lock with the shared gate: `check({ requiredBalance: 1 })`, keeping the free-tier cheap-model restriction.
- [ ] **3.2** Extract the provider's returned usage; for streaming, request it in the final chunk (OpenAI `stream_options.include_usage`, Gemini `usageMetadata`) and read it as the response passes through.
- [ ] **3.3** Settle with `track({ value: creditsForChat(realUsage), overageBehavior: "overflow", properties: { model, provider }, async: true })` on the after-response queue; retire `INTERIM_FIXED_CHAT_CREDITS` and the lock/finalize path.

### Phase 4: transcription overflow

- [ ] **4.1** Add `overageBehavior: "overflow"` to `trackAiTranscription`; switch its per-minute rate to `transcriptionCredits` from `model-pricing.ts`.
- [ ] **4.2** Enforce the max duration/size cap before forwarding.

### Phase 5: models.dev CI sync

- [ ] **5.1** Daily GitHub Actions job: fetch `api.json`, update the cost snapshot for the served set.
- [ ] **5.2** Open a PR that auto-merges when data-validity assertions pass; otherwise block for review.
- [ ] **5.3** Fail (or block the model) when a served model is missing with no `manualCost`.

### Phase 6: prove, bound, remove

- [ ] **6.1** Property test: `credits_charged * peg >= provider_cost` across a fuzzed matrix of models, context sizes, and output lengths.
- [ ] **6.2** Configure a generous Autumn spend-limit as the bad-debt backstop.
- [ ] **6.3** Typecheck self-host: imports no pricing, no billing.
- [ ] **6.4** Delete the dead reserve-lock path.

## Edge cases

### Concurrency / bad debt
No lock, so N concurrent calls at exhaustion can each run before any settles;
overspend is bounded by the per-call cap times the rate-limit, one-time, and
capped by the spend-limit. Netted on top-up, so only an abandoning user's single
overshoot is real bad debt. Revisit only if measured bad debt is material.

### Stale snapshot vs a provider price rise
The daily CI narrows the window; the markup buffer absorbs normal drift; a rise
appears as a PR that raises the charge.

### Unknown-cost model
CI flags it; set a `manualCost` or block. `creditsForChat` throws on a missing
cost (a real 500), never charges zero.

### Cache discounts
Settle on the provider's returned token counts at the full input rate; if the
provider gave a cache discount we over-profit (fine), never under-charge.

### Free tier
Restricted to cheap models already, so an overshoot is a couple of cents.

## Open questions

1. **Streaming usage extraction (the one real infra).** The gateway proxies the
   response stream to the client; to read `usage` it must tee/inspect the stream
   and grab the final chunk without disturbing the client copy.
   - **Recommendation:** `stream_options: { include_usage: true }` on the upstream
     request, then a `TransformStream` that passes bytes through while capturing
     the final usage chunk; settle from it on the after-response queue. Non-streaming
     responses carry `usage` in the body directly (the existing clone-and-parse
     pattern from STT).

2. **Per-deployment caps.** The `max_tokens` output ceiling and the request-size
   (input) cap. **Recommendation:** start ~4k output, ~200k-token input; tune with
   real data. Self-host may leave them loose.

3. **Markup values.** Start 1.5x default; per-model overrides where economics differ.

4. **Spend-limit value.** Generous backstop, essentially never bites a real user;
   tighten only on measured bad debt.

## Success criteria

- [ ] Property test holds: `credits_charged * $0.01 >= provider_cost` across a fuzzed matrix.
- [ ] A message in a long thread costs more credits than the same message in a fresh thread.
- [ ] Chat and STT share one gate/run/settle path; the reserve-lock is gone.
- [ ] Self-host typechecks and runs with no pricing import and no billing surface.
- [ ] The CI job opens a PR on models.dev drift and blocks a served model missing from models.dev.
- [ ] The credit peg ($0.01) is never changed by the pricing job; only per-model cost changes.

## References

- `packages/constants/src/ai-providers.ts` - the slimmed catalog (done).
- `apps/api/worker/billing/model-pricing.ts` - the Cloud-only pricing home.
- `apps/api/worker/billing/service.ts` - `reserveAiChat` (lock to remove), `checkAiCredits`, `trackAiTranscription`.
- `apps/api/worker/billing/policies.ts` - the Cloud-only gateway middleware.
- `packages/server/src/routes/inference.ts` - billing-agnostic library route + `policies` seam.
- `docs/guides/billing-autumn-boundary.md` - the current billing design.
- models.dev (MIT, `api.json`); Autumn (Apache-2.0). Pricing comparables captured 2026-08-26.
