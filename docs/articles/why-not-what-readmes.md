# The README Problem I Kept Running Into

I kept writing READMEs that became stale within a week.

You know the pattern. You organize some code into folders, write a nice README listing everything, feel productive. Then you add a new file. The README is wrong. You add another. Still wrong. Eventually the README is so out of sync that it's worse than useless; it's misleading.

I did this with the transcription services folder. Started writing: "Current providers: openai.ts, groq.ts, deepgram.ts..." and stopped. This list would be wrong the moment someone added mistral. Or removed a provider. Or renamed a file.

Here's what I realized: I was documenting what you can already see.

## The Question READMEs Should Answer

A README shouldn't tell you what's in the folder. You have `ls` for that. You have your file explorer. The file names are right there.

A README should answer: "Why is this organized this way?"

That's the information you can't get from looking at the structure. That's what another developer (or you, six months later) actually needs to know.

## What This Looks Like

In the transcription services folder, there are three subdirectories: `cloud`, `local`, and `self-hosted`. You can see that by running `ls`. What you can't see is why.

The README explains that:
- `cloud` contains API-based services that send audio to external providers
- `local` contains on-device processing that works offline
- `self-hosted` contains services that connect to servers you deploy

That's the organizational principle. That's the "why." Someone adding a new transcription provider now knows which folder it goes in without reading every existing file.

## What Not to Include

Don't list every file. Don't show the directory tree. Don't enumerate current providers.

All of that creates maintenance work. Every new file means updating the README. Every rename means updating the README. You've created a synchronization problem where none needed to exist.

Worse, when the README inevitably gets out of sync, people stop trusting it. Then it's not just useless; it's harmful.

## The Principle

Document design decisions, not implementation details.

Implementation details are already in the code. They're visible. They're grep-able. Duplicating them in prose just creates two places to maintain the same information.

Design decisions are invisible. You can't grep for "why did we organize it this way?" The README is where that belongs.

## Maintenance Burden

Every line you write in a README is a maintenance commitment.

If you write "Current providers: X, Y, Z," you've committed to updating that line every time providers change. If you write "Each provider is in its own file," that's obvious from looking at the folder and adds no value.

But if you write "Providers are grouped by deployment model because each model has different configuration requirements," that explains something non-obvious. And it stays true even when you add ten more providers.

## When I Ignore This

Sometimes you need to list things. API documentation lists endpoints. Configuration files list options. That's fine.

The difference is: are you listing something that changes frequently and is already visible? That's duplication. Or are you listing something that's hard to discover otherwise? That's documentation.

If someone can get the same information faster by running a command or opening a file, don't put it in the README.

## The Test

Before writing a README section, ask: "Could they just look at the files?"

If yes, explain why the files are organized that way instead of what they contain.

Your README should make the codebase more understandable, not more maintenance work.
