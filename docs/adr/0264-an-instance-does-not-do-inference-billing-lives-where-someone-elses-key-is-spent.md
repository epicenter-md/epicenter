# 0264. An instance does not do inference; metering lives exactly where someone else's key is spent

- **Status:** Accepted
- **Date:** 2026-08-26
- **Relates:** [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (the two-backend model this completes; its CORS consequence is corrected below), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the OpenAI-compatible wire; its "self-hosting and local models are first-class" promise is finally delivered by the client, not by the instance gateway), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) and [ADR-0059](0059-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md) (the client connection registry that makes this possible), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (one principal, which is why an instance can never bill), [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) (the burn-rate cap this retires for self-host), [ADR-0104](0104-hosted-models-are-a-build-time-seed-not-discovered-the-runtime-overlay-is-deferred.md) (the hosted catalog stays a Cloud product), [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) (the credit wallet, unchanged)

## Context

`packages/server/src/routes/inference.ts` validates every request against `HOSTED_MODELS_BY_ID` and routes it through a two-entry `PROVIDER_UPSTREAM` table. Both are Epicenter Cloud's commercial facts: what Cloud sells, and which two vendors Cloud holds house keys for. `apps/self-host` mounts that same route, so a self-hosted instance serves exactly the three ids Epicenter sells, proxied to Epicenter's two vendors, spending the *operator's* key.

That is a category error with a visible symptom: a self-hoster with their own OpenAI key can use `gpt-5.4-mini` and `gpt-5.5` through their own box and nothing else, because Epicenter does not sell anything else. Their key, our storefront.

A design pass looked for the seam that would let a deployment supply its own routing table. Working backwards from what such a seam would buy revealed that the instance gateway has almost no remaining justification:

- **Reachability is solved elsewhere.** Tailscale and equivalents make any box reachable, so "my family cannot reach my localhost" is not an argument for a proxy.
- **Model breadth is solved by the client.** The device-local connection registry ([ADR-0059](0059-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md)) already holds N OpenAI-compatible endpoints with per-connection keys and `/v1/models` discovery. Multi-upstream routing on the server would rebuild a capability that already ships.
- **Multi-vendor routing is commoditized.** LiteLLM, OpenRouter, and Ollama speak this exact wire. An instance that wants five vendors points at one of them.
- **Browsers can reach providers directly.** Verified 2026-08-26 by preflight: `api.openai.com` and `generativelanguage.googleapis.com/v1beta/openai` reflect the request origin and allow the `authorization` header; `api.anthropic.com` answers `Access-Control-Allow-Origin: *`. Every provider in the catalog permits direct browser calls with a user-supplied key.
- **Providers issue per-user keys.** OpenAI project keys, OpenRouter provisioning keys, and equivalents give each person their own credential with its own spend limit, and give the payer per-person accounting that an instance structurally cannot (one principal).

What remains is one thing: an instance gateway lets people spend the operator's key without holding it.

## Decision

**An Epicenter instance is identity, sync, and storage. It does not do inference. `mountInferenceApp` and `mountTranscriptionApp` are mounted by Epicenter Cloud only, and metering exists exactly where someone else's key is spent.**

- **Billing follows key ownership, not deployment.** Cloud spends Epicenter's house key on behalf of strangers who pay Epicenter, so it meters. Nobody else spends anybody else's key, so nobody else meters. This is why an instance has no billing: not because it is unbuilt, but because with one principal ([ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md)) there is no second party to charge.
- **Inference is a URL the client picks.** The two axes are independent. A workspace binds to one data authority (Cloud or an instance); a conversation resolves its model to one of N inference connections per turn. Epicenter Cloud's gateway is one row in that list, distinguished only by whose key it spends.
- **The hosted entry is not offered on a self-host session.** A single instance selection yields a single credential model ([ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md)), so a self-host session holds an instance token and no Cloud session. Offering the Cloud gateway there sends the wrong audience ([ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md)) and fails with a bare 401. It is hidden instead.
- **Self-host inference is configured on the client, not on the server.** The provider key moves from a server env var to a device-local connection. No redeploy to change models, and the model list stops being ours.
- **No routing seam is built.** `resolveUpstream`, a deployment-supplied catalog, and a `/v1/models` route on our own servers are all rejected: they exist to serve a consumer this decision removes.

## Consequences

- **`packages/server` keeps its inference and transcription routes for one consumer.** `HOSTED_MODELS_BY_ID` and `PROVIDER_UPSTREAM` stay, and are no longer wrong, because Cloud is the only mount site. Moving both routes into `apps/api/worker/` so the shared library holds zero commercial facts is the natural completion and is left as a follow-on, not bundled here.
- **`rateLimit` loses every consumer.** Its only call sites were the four self-host mounts; Cloud's abuse bound is the credit balance. [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md)'s burn-rate cap existed to protect an unmetered house key, and this removes the last one. The middleware and its test are deletable.
- **Self-host loses `OPENAI_API_KEY` and `GEMINI_API_KEY`** and the README section explaining house keys and provider spend caps. `runtime-profile.test.ts` inverts those rows from "mounted" to "must not be mounted."
- **Accepted loss: scope containment.** A shared provider key works everywhere (curl, another app, someone's script); an instance token only worked against the instance. Per-user provider keys recover revocation and accounting but not scope. A self-hoster sharing one key with a group accepts that broader scope, or issues per-user keys. This is the one thing the instance gateway did that nothing else does, and it is given up deliberately.
- **Transcription is sequenced separately.** The client has a full connection registry for chat and nothing equivalent for STT, so deleting `mountTranscriptionApp` before a custom STT connection exists would leave a self-hoster with no transcription path on any target that is not the desktop host (which runs local models on device). Chat lands first; STT lands once the client can point at an STT endpoint.
- **First-run needs an empty state.** A fresh self-host session opens chat with no connections configured. The picker must say what to configure rather than render blank.
- **The closed quadrant stays closed.** Self-hosted data plus Cloud inference would require the client to hold two credentials at once, which [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) deliberately collapsed. It is additive later (a Cloud sign-in granting only the inference audience) and is not a prerequisite for anything here.
- **Timing.** There are no users on the self-host gateway, which is why this lands as a deletion now rather than a deprecation later.

## Considered alternatives

- **A deployment-supplied `resolveUpstream` seam** (the library takes `(model) => { baseURL, apiKey } | null`; Cloud passes its table, self-host passes one env-configured upstream). Rejected: it fixes the storefront leak by adding a seam where removing the wrong consumer fixes it by subtraction, and it puts multi-upstream routing on the server that the client's connection registry already provides.
- **Keep the gateway, make it a single-upstream dumb pipe** (`UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`, forward any id, proxy `/v1/models`). The strongest alternative, and the right answer if key custody were a goal. Rejected because per-user provider keys serve that need better on every axis except scope, and a proxy is maintained forever.
- **A `/v1/models` route on Epicenter servers.** Rejected for Cloud by [ADR-0104](0104-hosted-models-are-a-build-time-seed-not-discovered-the-runtime-overlay-is-deferred.md) (a hosted model is a product with a label; discovery cannot carry that) and moot for an instance that serves no models.
- **Deprecate rather than delete.** Rejected: a deprecated gateway keeps the house keys, the rate limits, the catalog import, and the storefront leak, which is the entire cost, while signalling that the shape might return.
