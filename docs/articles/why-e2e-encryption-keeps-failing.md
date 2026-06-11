# Why E2E Encryption Keeps Failing

End-to-end encryption's adoption problem isn't a UX problem waiting to be solved. It's a structural property of the model. Three case studies. Spanning thirty years, a Hacker News thread, and the one app that actually got it right. Show the same pattern from different angles.

## PGP has been failing for thirty years

PGP was released in 1991. The encryption is technically sound. It solves the "server can't read your data" problem completely. Virtually nobody uses it for email.

The failure isn't cryptographic. It's operational. To use PGP, you need to generate a keypair, publish your public key, find your recipient's public key, verify it (the web of trust), manage revocation when keys are compromised, and store your private key somewhere you won't lose it. Every step is friction. Every step is a place where a non-technical user. Or a busy technical user. Gives up.

The crypto community spent decades trying to fix this. Key servers. Keybase. Autocrypt. ProtonMail (which handles keys invisibly but locks you into their ecosystem. Reintroducing the trusted third party). None of them achieved mainstream adoption for general email encryption.

The lesson isn't "we need better PGP UX." The lesson is that key management is inherently complex. You can hide it behind abstractions, but the complexity leaks: through recovery flows, through device migration, through the moment a user loses their key and their data is gone forever. Thirty years of evidence suggests this friction is structural, not solvable.

## Even technical people choose convenience over their own ideals

A [Hacker News thread](https://news.ycombinator.com/item?id=47346261) about decentralized social networking produced an observation more interesting than the project itself. A commenter pointed out that the people advocating for decentralization and E2E encryption are:

- Posting on centralized Hacker News
- Hosting their code on centralized GitHub
- Chatting on centralized Discord
- The decentralized project itself was hosted on GitHub

Technical people who could self-host their git repos, run their own forums, and host their own chat choose not to. Not because they're lazy. Self-hosting is its own kind of prison. You trade the risk of a centralized service misusing your data for the certainty of maintaining servers, applying updates, rotating certificates, and debugging DNS at 2am.

This isn't hypocrisy. It's a rational tradeoff. The friction of self-hosting (and by extension, of managing encryption keys) outweighs the theoretical risk of centralization for almost every practical use case. Even for people who fully understand the risks and have the skills to avoid them.

If technical people on Hacker News consistently make this tradeoff for themselves, building consumer products that demand even more friction from non-technical users isn't principled. It's setting those products up to fail. The friction argument applies to experts and non-experts alike. It's not a matter of education, it's a matter of economics.

## Signal is the exception that proves the rule

Signal is the standard counterexample whenever someone argues E2E encryption doesn't work at scale. And Signal does work. Billions of messages, seamless key management, strong adoption. So why doesn't this generalize?

Because messaging is one-dimensional. Text goes in, text comes out. The Signal server is a relay. It stores encrypted blobs, forwards them to recipients, and deletes them. It never needs to read, index, search, or process the content. The server's inability to read data costs nothing because the server was never going to do anything with the data anyway.

Most apps aren't relays. A workspace tool needs to search your documents. An AI assistant needs to read your notes to summarize them. A transcription service needs to process your audio on the server. Password recovery requires the server to re-derive your session without your original credentials. Every one of these features requires the server to read your data, which E2E encryption prevents by definition.

Signal's success proves that E2E works when the server is a pipe. It says nothing about apps where the server is a participant.

## The pattern

Each case shows the same structural problem from a different angle. PGP shows that key management friction persists across decades of improvement. The HN thread shows that even experts choose convenience when the friction is real. Signal shows that E2E only works when the server doesn't need to process data, which is the exception, not the rule.

The common thread: E2E encryption's friction isn't a bug to be fixed. It's the definition. When the server can't read data, the server can't do useful things with data. For relay-style apps, that's fine. For everything else, it's a permanent tax on every feature you build.

## Related

- [Let the Server Handle Encryption](./let-the-server-handle-encryption.md): the pragmatic alternative
- [If You Don't Trust the Server, Become the Server](./if-you-dont-trust-the-server-become-the-server.md): why self-hosting solves the trust problem without the friction
