# We Went to Fix Our CLA Bot and Ended Up Changing Our Licensing Model

Our CLA bot broke. We pinned a version, fixed it, and then asked a question we probably should have asked earlier: is this bot even worth running?

Two weeks later we had a completely different licensing model. This is that story. It's operational research, not legal advice.

## The bot that pointed at nothing

PR #1540 was a one-liner. The `contributor-assistant/github-action` workflow was failing because it referenced `@v2`, and `v2` didn't exist as a tag. We pinned it to `v2.6.1` and moved on.

Then someone asked: should we actually be using this?

We looked at the hosted alternative, `cla-assistant.io`, which SAP maintains. The GitHub repo had 226 open issues. Users were reporting they couldn't sign CLAs at all. The last commit was October 2023. The maintainers weren't responding. The self-hosted action we'd just pinned had similar energy: functional enough to not be obviously broken, but clearly not a priority for anyone.

Every CLA tool in the ecosystem is in some state of semi-abandonment. That's not a criticism; it's just the reality of niche infrastructure software. But it raised the obvious question: why are we requiring contributors to sign a CLA in the first place?

## What CLAs are actually for

A CLA (Contributor License Agreement) gives the project owner the right to relicense contributions. The canonical use case is dual licensing: you publish under AGPL so companies can't take your code proprietary, but you also sell a commercial license to companies that don't want AGPL's copyleft obligations. To do that cleanly, you need to own the copyright on every line, which means every contributor has to sign over their rights.

That's the theory. We went looking at what projects actually do.

| Project | License | CLA? | Model |
|---|---|---|---|
| Yjs | MIT (core), AGPL (y-redis) | No | MIT library + AGPL server |
| Liveblocks | Apache (clients), AGPL (server) | No | Open core + hosted |
| Bitwarden | GPL (clients), AGPL (server) | No | Open core + proprietary enterprise |
| Cal.com | AGPL | No | SaaS |
| dub.sh | AGPL | No | SaaS |
| Nextcloud | AGPL | Explicitly no | Community |
| Grafana | AGPL | Yes (CLA) | Open core + hosted |
| GitLab | MIT (CE) | DCO (not CLA) | Open core + proprietary EE |

The narrative around "dual-licensed open source" is mostly a myth. Cal.com and dub.sh are just AGPL with a hosted SaaS on top. They don't sell a commercial license; they sell the service. Bitwarden has proprietary enterprise modules, but those are written entirely by the Bitwarden team and live in a separate directory. Nextcloud's contributor guide explicitly says no CLA required. GitLab uses a DCO (Developer Certificate of Origin), which is just a sign-off saying "I wrote this and I have the right to contribute it". Not a copyright assignment.

Grafana does use a CLA, and it's one of the few projects where it makes sense: they sell Grafana Enterprise, which includes features that ship under a proprietary license. To relicense community contributions into that product, they need the copyright. That's the actual use case.

## The pattern nobody documents

Once you look at enough projects, a pattern emerges. Client libraries and core packages are permissive (MIT, Apache). Server infrastructure is copyleft (AGPL). Nobody writes this down as a strategy, but it's everywhere.

Yjs is MIT. `y-redis`, the server-side sync adapter, is AGPL. Liveblocks ships Apache-licensed client SDKs and an AGPL server. Bitwarden's desktop and mobile clients are GPL; the server is AGPL with proprietary enterprise modules layered on top.

The logic is consistent: permissive licenses on the client side lower the barrier to adoption. Copyleft on the server side means anyone running the infrastructure commercially has to either open-source their modifications or buy a commercial arrangement. The business model lives at the server boundary, not in the client code.

## What this meant for Epicenter

Epicenter is a local-first workspace platform. The core library (`packages/workspace`) is a TypeScript/Yjs CRDT layer that any developer should be able to use freely. The sync server (`apps/api`) is where the infrastructure lives, and where a hosted service (Epicenter Cloud) makes sense.

We were running a CLA for a dual-licensing model we weren't actually doing. We had no plans to sell a commercial license to the AGPL codebase. Our path to financial sustainability was always going to be hosted sync and future proprietary enterprise features written by our team.

The CLA was friction with no corresponding benefit.

So we split the licenses. MIT for the library packages and apps: `packages/workspace`, `packages/ui`, `apps/whispering`, `apps/tab-manager`. AGPL for the sync server and sync protocol: `apps/api`, `packages/sync`. No CLA.

Enterprise features, when we build them, will live in a separate directory and be written entirely by the Epicenter team. That's the open-core model: AGPL base, proprietary enterprise layer on top. It achieves the same business outcome as dual licensing without requiring copyright assignment from contributors.

## When you actually need a CLA

If you're planning to sell a commercial license to your open-source codebase, you need a CLA. There's no way around it. You need to own the copyright on every contribution to relicense it. Grafana does this. HashiCorp did this before their BSL switch. It's a real model with real legal requirements.

If you're doing open core, where enterprise features are written by your team in a separate module, you don't need a CLA. External contributions go into the open-source base and stay there. Your proprietary code is yours because you wrote it, not because contributors signed anything.

If you're just running a SaaS on top of AGPL code, you definitely don't need a CLA. Cal.com, dub.sh, and most "dual-licensed" projects people cite are actually in this bucket.

As for tooling: if you do need a CLA, the options are `cla-assistant.io` (SAP-maintained, currently neglected), the `contributor-assistant/github-action` (self-hosted, pin to a specific version), or a custom GitHub Action. They all work well enough. None of them are actively developed. Budget time for maintenance.

The CLA bot breaking was annoying. But it pointed us at a question worth asking.
