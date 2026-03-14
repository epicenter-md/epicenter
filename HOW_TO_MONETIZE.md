# How to Monetize Epicenter

Honestly, we're still figuring this out. I've been thinking about it a lot—talked it through with contributors, posted about it in [#792](https://github.com/EpicenterHQ/epicenter/issues/792), and gone back and forth on a few different models. What follows is where my head is at right now.

## The short version

Epicenter is AGPL-3.0. It stays that way. We require a lightweight CLA (license grant, not copyright assignment—contributors keep their copyright) and we don't need to formally "dual license" anything. When an enterprise wants to self-host our sync server but can't accept AGPL (because their legal team won't let them), we sell them a commercial license. That's just a private contract between us and them—nothing changes on the public repo.

AGPL keeps the code open. When enterprises need a different arrangement, that's where the commercial license comes in.

## What we considered

In issue [#792](https://github.com/EpicenterHQ/epicenter/issues/792), I wrote about wanting Epicenter to become a foundational data framework—an SSO for AI applications where users own their data and developers build on top. That goal hasn't changed. But the question of how to fund it has evolved.

We looked at a few options:

1. Traditional SaaS (like a Proton Suite or Google Suite of apps)
2. Formal dual licensing (AGPL for open source, commercial license for closed-source use)
3. Keeping it simple—AGPL plus selling commercial contracts when enterprises come knocking

Option 3 won. It's the least complicated, stays faithful to open source, and doesn't require any infrastructure or legal overhead we don't need yet.

## How AGPL actually works as leverage

Here's something I didn't fully appreciate until recently: the AGPL basically does the work of surfacing enterprises who need a commercial license. Not because we'd ever sue anyone, but because of how corporate compliance works.

The typical flow looks like this: a developer at a company discovers Epicenter, starts using it, loves it. Then their compliance tooling (Snyk, FOSSA, whatever they use) flags AGPL in a dependency scan. Legal sees the flag and applies their blanket ban—most Fortune 500 companies prohibit AGPL by default. At that point, the company has two options: stop using it, or buy a commercial license. We get a sales conversation we didn't have to create.

This is the same approach Grafana Labs, Bitwarden, and MinIO all use. AGPL creates the constraint. The commercial license removes it.


## What this means for developers building on Epicenter

If you're building on top of Epicenter's libraries, your own code can be under any license that's compatible with AGPL-3.0. That includes most modern permissive licenses—MIT, Apache 2.0, BSD, ISC, and others. You don't have to use AGPL for your own code.

The catch is that the **combined work** (your code + our AGPL library) must comply with AGPL when you distribute it or serve it over a network. In practice, this means users of your app must be able to get the full source code. Your original files keep whatever license you put on them—someone could fork your MIT code, swap out the Epicenter dependency, and redistribute under pure MIT. But as long as our AGPL library is in the mix, the distributed package follows AGPL rules.

This is the same pattern Grafana uses—their UI libraries (`grafana-ui`, `grafana-data`) are Apache 2.0 so plugin developers aren't forced into AGPL for their own code, even though the combined Grafana distribution is AGPL.

## How this sustains the project

We see three ways to become financially sustainable, serving different kinds of customers:

**Hosted sync.** We run the sync server. Users pay for the convenience of not managing infrastructure, plus end-to-end encryption. This is the Obsidian model—individual users and small teams will never self-host; they just want it to work.

**Enterprise self-host licenses.** Banks, healthcare companies, defense contractors, anyone with strict data sovereignty requirements—they need to run the sync server on their own infrastructure. Their legal team flags the AGPL, and that forces a commercial conversation. They're buying AGPL escape plus SSO, audit logs, and a support SLA.

**AI compute.** Epicenter does transcription and AI assistance. Users who don't want to manage their own API keys pay us for bundled access. We negotiate volume pricing with model providers and pass on reasonable rates.

These aren't competing streams. The person paying for hosted sync will never self-host. The enterprise buying a commercial license will never use our hosted sync—their compliance team won't let data leave their network. Different buyers, different motivations, same AGPL foundation.

## Why not a formal dual license?

A formal dual license means you publish the code as "available under AGPL-3.0 OR our Commercial License" with public pricing and self-serve purchasing. That makes sense when you have hundreds of companies needing licenses and you want to scale sales without talking to each one.

We're nowhere near that stage. Adding that complexity now would be solving a problem we don't have. When the first enterprise comes to us, we write them a contract. If we end up writing the same contract ten times, we formalize it into a public offering. Until then, AGPL on the repo is all we need.

## The CLA

Every project on the list below uses a CLA—it's basically table stakes for the AGPL-to-commercial model. So we added one. It's a lightweight Apache ICLA-style agreement that grants us a license to include your code in both the open-source and commercial versions of Epicenter.

The sync server is still 100% my code, but adding this now future-proofs the project as we grow. Here's something I didn't fully appreciate until recently: without a CLA, we'd eventually hit a wall where we couldn't offer a commercial license for the whole stack because of a few small external commits. That feels like a risk we shouldn't take.

Crucially, this is a license grant, NOT copyright assignment. You keep your copyright. You're just giving us permission to use your work in the ecosystem we're building together. You can read the full text in [CLA.md](CLA.md). That feels like an honest trade to me.

## The comps

Projects using this same AGPL approach:

- Grafana Labs—switched to AGPL specifically to prevent cloud providers from strip-mining their value
- Bitwarden—AGPL, sells enterprise self-host licenses
- MinIO—AGPL, enterprise licenses for self-hosted object storage
- AppFlowy—AGPL, open core plus enterprise self-host (closest to our architecture)
- Logseq—AGPL, local-first desktop app (closest comp to Epicenter overall)

Every one of these projects requires a CLA. We do now too.

## What I care about

I wrote in [#792](https://github.com/EpicenterHQ/epicenter/issues/792) that I want to double down on supporting scrappy developers who are building in the open. That hasn't changed. AGPL keeps the project truly open for the community. If you're building open-source software with Epicenter, it's completely free—no strings, no license fees, no gotchas.

The commercial side is for companies that want to take the sync server, run it behind their firewall, and not share their modifications. That feels like an honest trade to me.
