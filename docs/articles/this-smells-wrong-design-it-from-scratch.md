# "This Smells Wrong. Design It from Scratch"

The most effective prompt I give an AI coding agent isn't "fix this" or "refactor that." It's: "This feels like a code smell. If you were designing this from scratch, what would you have done differently?"

That framing does three things no other prompt does: it invites the agent to critique without being defensive, it detaches the agent from sunk-cost loyalty to existing code, and it forces architectural thinking instead of line-level fixes.

## Why "fix this" produces bad results

When you tell an AI to fix something, it tries to preserve what's there. It patches. It adds null checks, wraps things in try-catch, introduces a helper function that smooths over the real problem. The fix works, technically, but the architecture stays wrong.

```typescript
// You say: "fix the race condition in auth"
// AI adds:
if (isAlreadyChecking) return; // band-aid
isAlreadyChecking = true;
```

The agent treats existing code as correct-but-broken. It never questions whether the structure should exist at all.

## Why "from scratch" changes the output

"Design it from scratch" gives the agent permission to throw away the current approach. It stops trying to preserve. And starts evaluating. The internal reasoning shifts from "how do I make this work" to "what's the right way to solve this problem."

Here's a real example. A browser extension had two methods on an auth state object that consumers had to call inside a `$effect` block:

```typescript
// The code that smelled wrong
$effect(() => {
    authState.reactToTokenCleared();
    if (authState.reactToTokenSet()) reconnectSync();
});
```

Two methods that only work when called inside a reactive scope, with an implicit contract that nothing in the type system enforces. Asking "fix this" would produce a comment explaining the contract, or maybe a runtime check that throws if called outside `$effect`. Asking "design it from scratch" produced something different: the auth module should manage its own reactive lifecycle with `$effect.root()`, expose a clean `onExternalSignIn(callback)` subscription, and never require consumers to know about its internal state machine.

The consumer went from this:

```svelte
$effect(() => {
    authState.reactToTokenCleared();
    if (authState.reactToTokenSet()) reconnectSync();
});
```

To this:

```svelte
onMount(() => {
    return authState.onExternalSignIn(() => reconnectSync());
});
```

Same behavior. The smell is gone. The agent found it because the prompt gave it room to think architecturally instead of surgically.

## The three-part structure

The full prompt has three parts, and each one matters:

**"This feels like a code smell"** tells the agent something is wrong without specifying what. It has to identify the problem, not just apply a pre-selected fix. This is important. You might be wrong about what the smell is, and the agent might find the real issue is somewhere you didn't expect.

**"If you were designing this from scratch"** detaches the agent from the current implementation. It stops anchoring to variable names, function boundaries, and file structure. It can propose moving responsibility to a different module, splitting a file, or eliminating a layer entirely.

**"What would you have done differently?"** invites comparison. The agent has to articulate why the new approach is better than the old one. This forces it to identify the specific properties that make the current code problematic. Not just "it's messy" but "it exposes internal state transitions as public API" or "it creates an implicit dependency between modules."

## When to use it

This prompt works best on code that technically works but feels wrong. The kind of code where you look at it and think "there has to be a better way" but can't immediately articulate what that way is.

It's less useful for straightforward bugs (just describe the bug) or trivial cleanup (just ask for the refactor). It shines on architectural smells: tight coupling, leaky abstractions, responsibilities in the wrong place, patterns that force consumers to know too much about internals.

## When it goes wrong

The failure mode is over-engineering. "From scratch" can lead an agent to propose a complete rewrite when the existing code just needs a small adjustment. If the agent comes back with three new abstractions and a design pattern you've never heard of, it overshot. The response should be a simpler version of what exists, not a more complex one.

The antidote: follow up with "what's the simplest version of this?" If the agent's from-scratch design is genuinely simpler than what exists, it's probably right. If it's more complex, the original code might not have been as smelly as you thought.

## The real insight

The reason this prompt works is that it mirrors how experienced engineers think. You don't look at messy code and immediately start editing. You step back, understand what it's trying to do, and ask yourself how you'd build it if you were starting today with everything you now know. The gap between "what exists" and "what I'd build" is the refactoring plan.

Giving an AI agent that same framing produces the same kind of thinking. It's not a hack or a jailbreak. It's just the right question.
