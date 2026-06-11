# TypeScript Hover Behavior: Why Type Display is Inconsistent

One of the frustrating things about TypeScript being a structural language is how inconsistent the hover behavior is. Sometimes you hover over a type and see the alias name, like `User`. Other times you see the whole expanded structure, like `{ id: string; name: string }`. And there's no obvious pattern to when you get which.

The language server uses heuristics to decide what to show you. Named type aliases often stay collapsed, but if you hover over a variable that has that type, you might see it fully expanded. Deeply inferred types from function returns or mapped types almost always expand because there's no name to show. Intersections are weird too; sometimes `A & B` stays as-is, sometimes it merges into one big object literal. And generics flip between representations; `Array<string>` might show as `string[]` depending on where you're looking.

The root cause is structural typing itself. There's no nominal identity forcing a single representation, so the language server has to guess what's most helpful. And the heuristics don't always match what you actually want to see.

Some workarounds: hover on the type definition itself rather than a variable. Use explicit type annotations if you want the alias preserved. Or use "Go to Type Definition" to see the canonical source.

But yeah, it's genuinely inconsistent and there's no perfect fix.
