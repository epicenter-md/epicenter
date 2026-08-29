# 0265. An in-process local engine is served over a custom URI scheme, not a loopback socket

- **Status:** Accepted
- **Unbuilt:** the host (`apps/epicenter`) is a clean-break rebuild in progress (ADR-0227). This decision is recorded now so the rebuild inherits it; no code implements it yet.
- **Date:** 2026-08-26
- **Relates:** [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) (the three-route local seam this gives a transport to), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the wire), [ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) (a connection is a base URL, which this makes true for local too), [ADR-0264](0264-an-instance-does-not-do-inference-billing-lives-where-someone-elses-key-is-spent.md) (inference is a URL the client picks; this extends that to the last lane), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (the host that owns this), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (the rebuild this waits on)

## Context

[ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) put every local engine behind the OpenAI-compatible wire and named three routes: `/v1/chat/completions` (delegated to Ollama), `/v1/audio/transcriptions` (WhisperKit or whisper.cpp), and `/v1/audio/speech` (Kokoro or Piper). It explicitly contemplates an engine running **in-process**, via Core ML or an embedded whisper.cpp.

That leaves a hole. A delegated engine in a separate process (Ollama, Speaches) already has a URL, so it is a normal connection. An in-process engine has no URL, so today it is reached by Tauri `invoke` and is the only inference lane in the system that is not a base URL. Every consumer then needs a second shape for it: Whispering's dispatch carries a `bespoke` kind alongside `wire`, and each app that wants local models hand-encodes the wiring.

Two obvious fixes are both wrong.

- **Bind a loopback HTTP server.** Gives it a real URL, but a `127.0.0.1` listener is reachable by every process on the machine and by any web page that fetches localhost. It needs a per-launch token and strict CORS to not be a hole, plus port allocation and bind lifecycle. Ollama has shipped this class of bug.
- **Synthesize a `fetch` that dispatches to `invoke`.** Looks uniform, but the adapter must unpack a `FormData`, call `invoke`, and re-wrap the result as a fake `Response`. That is more code than the `bespoke` closure it replaces, and all of it exists to pretend IPC is HTTP.

## Decision

**The host serves its in-process engines over a Tauri custom URI scheme registered with `register_asynchronous_uri_scheme_protocol`, speaking the same OpenAI routes as every other engine. A local model is therefore a normal connection: a base URL.**

- **It is a real fetch, not a pretense.** The WebView's network stack routes the scheme to Rust, which is where the engine already lives. `complete()`, `transcribe()`, and `listModels()` work unchanged because nothing is being simulated.
- **It is not a network service.** A registered scheme is reachable only from the app's own webviews. It is not registered with the system, so no other process and no web page can reach it. There is no port, no bind lifecycle, no CORS surface, and no token to invent.
- **The scheme is a transport, and the route list follows what the host actually runs.** It serves `GET /v1/models` plus whichever of [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md)'s routes have an in-process engine behind them. Transcription first, since that is what the host runs today; `/v1/audio/speech` joins it if TTS ever lands in-process. **`/v1/chat/completions` is not served**: [ADR-0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) delegates local chat to Ollama and we do not build an inference engine. If that ever changes, the route is added here with no client change.
- **Discovery is how the picker fills.** `GET /v1/models` lists the resident local model, so the connection populates itself the way any other OpenAI-compatible endpoint does ([ADR-0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md)), instead of an app hard-coding what the host can do.
- **The base URL is computed at boot and injected**, because schemes resolve per platform: `http://<scheme>.localhost/...` on Windows, `<scheme>://...` on macOS and Linux. Same shape as `convertFileSrc`. Apps receive a resolved base URL, never a literal.
- **`bespoke` keeps its real job.** It is correct for a provider whose API genuinely is not the OpenAI wire (ElevenLabs, Deepgram, Mistral). It is the wrong tool for papering over a transport difference in a capability that can speak the wire.

## Consequences

- **`@epicenter/client` needs no Tauri dependency.** A URL is a URL. The client stays platform-neutral and keeps working in a browser tab, without a `#platform/*` seam for local inference and without an import that no-ops off-desktop.
- **Local models cost each app zero code.** The wiring is written once, in the host, next to the engine. An app in an Epicenter window receives a connection like any other, which is what makes the "every app gets local models" property real rather than aspirational.
- **The host implements OpenAI route handlers in Rust.** Multipart in, JSON out, plus a model list. Bounded, and the honest price of the uniformity.
- **Local inference is desktop-only, stated plainly.** A browser tab cannot reach a registered scheme. That is correct rather than a gap: local engines need model files and local compute.
- **[ADR-0264](0264-an-instance-does-not-do-inference-billing-lives-where-someone-elses-key-is-spent.md)'s rule holds to the last lane.** Every inference lane is now a URL the client picks: Cloud's metered gateway, a box you run, a provider directly, and now the engine inside the host. Nothing is metered here because nobody else's key is spent.
- **Blocked on the host rebuild.** `apps/epicenter` is broken on purpose under [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md). Recording the decision now is the point: the rebuild should not re-derive it or reach for `invoke` by default.

## Considered alternatives

- **A loopback HTTP server.** Rejected above on attack surface and lifecycle. The cases it uniquely serves (another app, another device, a browser tab reaching your GPU box) are already served by Ollama and Speaches, which are loopback servers whose job this is. Epicenter does not need to become one.
- **A synthetic `invoke`-backed `fetch`.** Rejected above: more code than what it replaces, and every line of it simulates HTTP.
- **A `bespoke` dispatch entry calling `invoke`.** The cheapest option today and the one the code is already shaped for. Rejected because it pushes hand-encoding into every consuming app, which is the cost this decision exists to remove, and because it misuses a slot built for genuinely non-wire providers.
- **`@epicenter/client` imports `@tauri-apps/api` directly and no-ops off-desktop.** Technically fine: `invoke` resolves `window.__TAURI_INTERNALS__` at call time, not import time, so importing is safe. Rejected because this decision makes it unnecessary, and a platform-neutral client with no desktop dependency is strictly better than one that carries a dependency it usually cannot use.
