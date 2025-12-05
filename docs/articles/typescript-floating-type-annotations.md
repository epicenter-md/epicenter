# The Curious Case of TypeScript's Floating Type Annotations

I was reviewing pull requests last week when I noticed something that made me pause. Three different developers had implemented provider functions for our workspace persistence system, and each had annotated their functions completely differently. My first instinct was to write a comment about consistency, to suggest "the correct way" to type these functions. Then I stopped. Were any of them actually wrong?

Here's what I was looking at. Same function, three different type annotation strategies, all perfectly valid TypeScript:

```typescript
type Provider = (context: ProviderContext) => void;

// Developer 1: Post-function annotation
export const setupPersistence = (async ({ id, ydoc }) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const storagePath = '.epicenter';
    const filePath = path.join(storagePath, `${id}.yjs`);

    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    try {
        const savedState = fs.readFileSync(filePath);
        Y.applyUpdate(ydoc, savedState);
    } catch {
        console.log(`Creating new workspace at ${filePath}`);
    }

    ydoc.on('update', () => {
        const state = Y.encodeStateAsUpdate(ydoc);
        fs.writeFileSync(filePath, state);
    });
}) satisfies Provider;

// Developer 2: Variable type annotation
export const setupPersistence: Provider = async ({ id, ydoc }) => {
    // same implementation
};

// Developer 3: Inline parameter annotation
export const setupPersistence = async ({ id, ydoc }: ProviderContext): void => {
    // same implementation
};
```

All three compiled. All three worked. And here's the thing that got me: hover over the parameters in your IDE for any of these, and TypeScript knows exactly what `id` and `ydoc` should be. The type information flows backward from `satisfies Provider`, forward from `: Provider`, and directly from `: ProviderContext`. Same result, completely different annotation locations.

This is genuinely weird if you think about it. Most statically typed languages have a canonical place for type annotations. You put types where the language tells you to put them. But TypeScript doesn't care. The type information can live before the function, after the function, or inside the function signature itself. As long as it's somewhere in the vicinity, TypeScript will figure it out.

What's happening under the hood is bidirectional type inference. When you write `satisfies Provider` at the end, TypeScript looks at the Provider type definition, sees it expects `(context: ProviderContext) => void`, and infers that your destructured parameters must match ProviderContext. When you write `const x: Provider`, it does the same thing but from the variable declaration. When you annotate the parameters directly, you're just... telling it explicitly.

But here's where it gets interesting. These three approaches aren't actually identical. They're subtle variations with different trade-offs.

The first two (satisfies and variable annotation) enforce a contract. They're saying "this function must match the Provider type." If Provider changes tomorrow to require a return value, both approaches will catch the error. The third approach just annotates the parameters; it has no idea Provider exists. If the Provider contract changes, this code might silently drift out of sync.

Then there's the difference between satisfies and variable annotation, which is even more subtle. With `const x: Provider`, you're declaring that x is of type Provider. TypeScript will treat it that way everywhere. With `const x = ... satisfies Provider`, you're saying "check that this matches Provider, but preserve the specific type I actually wrote." This matters for type narrowing and inference downstream.

Try it yourself. Hover over a function typed with `: Provider` and you'll see `const setupPersistence: Provider`. Hover over one with `satisfies Provider` and you'll see the actual async function signature with its specific parameter destructuring. That difference can matter if other code is making decisions based on this function's type.

So when do you use each approach?

I reach for `satisfies` when I want contract enforcement but also want the precise type to be preserved. This is my default for implementing interfaces or abstract types where the specific implementation details matter for consumers. It's saying "I'm implementing this contract, but I'm also this specific thing."

I use variable annotation (`const x: Provider`) when I genuinely want the variable to be typed as that interface, not as its implementation. This is less common, but useful when you want to intentionally hide implementation details or when you're building a plugin system where the abstract type is what matters.

I use inline parameter annotations when there's no formal contract type to reference, or when the function is simple enough that tying it to a type definition feels like overkill. Just annotate the parameters, let TypeScript infer the return type, and move on.

What struck me about this whole thing is how it reflects TypeScript's philosophy. The language isn't trying to impose a single "correct" way to annotate types. It's meeting JavaScript where it lives. JavaScript has function expressions, arrow functions, function declarations, methods, all with different syntax. TypeScript had to accommodate all of them, and in doing so, created a system where type information can float around the code rather than being locked to a specific syntactic location.

The lesson I took away: TypeScript's type system is more flexible than it first appears. The annotations aren't rigid declarations; they're hints that can be placed wherever they make the most sense for your specific situation. The type checker will figure it out. Your job isn't to find "the right way" to annotate; it's to choose the approach that best communicates your intent.

I ended up not leaving a comment on those PRs. All three developers were right.
