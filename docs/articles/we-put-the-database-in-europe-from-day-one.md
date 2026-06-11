# We Put the Database in Europe from Day One

PlanetScale PostgreSQL regions are immutable. Once you pick a region, that's it. You can't move the database. If you need to relocate later, you're looking at creating a new branch in the target region, dumping your data, restoring it, promoting the new branch, and swapping credentials. That means downtime, dual-running costs, and a migration weekend nobody wants. So we picked Frankfurt from the start.

## The compliance math is simple

GDPR doesn't technically require EU storage. You can store personal data in the US if you maintain Standard Contractual Clauses, perform Transfer Impact Assessments, and implement supplementary measures post-Schrems II. It's legal. It's also a perpetual paperwork machine.

Putting the database in the EU eliminates that entire surface area. No TIAs to conduct, no SCCs to maintain, no supplementary measures to document. The data never leaves the EU, so the cross-border transfer chapter of GDPR doesn't apply to us. One decision at database creation time saved us from an ongoing compliance obligation.

We went with Frankfurt specifically. AWS `eu-central-1`. Germany has the strictest GDPR enforcement in the EU. The BfDI and state-level DPAs are the most active regulators in Europe. Hosting in Germany is the strongest signal you can send to an enterprise customer that you take data residency seriously.

## The latency doesn't matter for local-first

The obvious concern: what about US users? Frankfurt adds 100-150ms of round-trip time compared to `us-east-1`. For a traditional server-rendered app, that would compound across every database query and make the experience noticeably sluggish.

Epicenter isn't a traditional app. It's local-first. Your notes, transcripts, and workspace data live in Yjs CRDTs on your device. Reads hit local IndexedDB or SQLite. Zero network latency. Writes go into the local CRDT first, then sync asynchronously to the server. The user never waits for a transatlantic round trip during normal use.

The server handles auth, billing, and sync relay. Auth is a one-time operation per session. Billing queries are infrequent. Sync is asynchronous by design. An extra 100ms on a background WebSocket message is invisible. The architecture absorbs the latency penalty without the user feeling it.

## EU-first removes a future sales blocker

Enterprise customers in Europe increasingly require contractual data residency guarantees. German companies in particular want to see EU hosting before they'll sign. If you start in the US and try to add EU hosting later, you're either migrating your entire database (downtime, risk, engineering time) or running a multi-region setup (complexity, cost, operational burden).

Starting in the EU means the answer to "where is our data stored?" is already the right one. No migration project, no multi-region architecture, no rushed compliance work when a deal depends on it.

We deleted the US database, created a new one in Frankfurt, and moved on. Five minutes on day one saved us from a migration project later.
