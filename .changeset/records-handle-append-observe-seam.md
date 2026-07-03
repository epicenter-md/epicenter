---
'@epicenter/workspace': minor
---

Narrow the public `RecordsHandle<T>` returned by `attachRecords` to the three methods its consumers actually use: `set`, `entries`, and `observe`. The `get` and `delete` methods were advertised but called by no production consumer (the agent loop appends and re-reads wholesale), so they are dropped from the exported type. `AgentMessageStore` collapses from `Pick<RecordsHandle<AgentMessage>, ...>` to `RecordsHandle<AgentMessage> & Disposable`.

This is a type-only narrowing: the durable `'entries'` Yjs slot, the per-id last-write-wins blob layout, and the backing `YKeyValueLww` semantics are unchanged. Existing conversation documents read back identically. Callers that need by-id reads or removal would widen the handle alongside a live consumer.
