# Typia Validates External Types With Zero Duplication

Typia is the only validator that can take a TypeScript type from any external library and turn it into a runtime validator without duplicating the schema. If TypeScript can type-check it, Typia can validate it.

```typescript
import typia from 'typia';

// chrome.runtime.MessageSender comes from @types/chrome
// You didn't write this type. You don't maintain it. And you don't need to.
const isValid = typia.is<chrome.runtime.MessageSender>(untrustedData);
```

One line. The type you already have is the schema.

## The Type Checker is the Engine

Most validation libraries are schema-first. You define a schema using their DSL, and then infer the TypeScript type from that schema. This works fine for types you own, but it falls apart when you need to validate data against types from a third-party library like Chrome, Prisma, or AWS.

Typia flips this. It's a TypeScript compiler transformer that hooks into `ts.TypeChecker`: the same engine TypeScript uses to verify your code. Because TypeScript resolves all types (including those in `node_modules`) before Typia even sees them, Typia receives a fully-resolved, flattened representation of the type. It then generates optimized validation code at compile time.

## The Cost of Redefinition

Every other major validator requires you to manually redefine external types as schemas. If you want to validate a Chrome `MessageSender` object in Zod, you have to hope you didn't miss a field:

```typescript
// Zod: you must redefine the type manually
const MessageSenderSchema = z.object({
	id: z.string().optional(),
	url: z.string().optional(),
	tab: z
		.object({
			id: z.number().optional(),
			index: z.number(),
			windowId: z.number(),
			// ... manually redefine every single field
		})
		.optional(),
	frameId: z.number().optional(),
});

type MessageSender = z.infer<typeof MessageSenderSchema>;
```

In Typia, you just import the type and go. There is no "syncing" the schema with the library's types because they are the same thing.

## Comparison

| Feature          | Typia                  | Zod / TypeBox / ArkType |
| :--------------- | :--------------------- | :---------------------- |
| Source of Truth  | TypeScript Types       | Schema Definition       |
| External Types   | Direct Import          | Manual Redefinition     |
| Code Duplication | Zero                   | High (Schema + Type)    |
| Performance      | AOT Compiled (Fastest) | Runtime / JIT           |
| Build Step       | Required (ts-patch)    | None                    |

## Real-World: Chrome Extension Types

Chrome's API types are notoriously complex, filled with optional fields and nested objects. Validating a message sender in a background script is a classic security boundary where you can't trust the incoming data.

```typescript
import typia from 'typia';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!typia.is<chrome.runtime.MessageSender>(sender)) {
		return;
	}

	// sender is now validated and fully typed
	console.log(sender.tab?.id);
});
```

This pattern works for any library. You can validate Prisma-generated models, tRPC payloads, or even complex DTOs from a NestJS backend without writing a single line of schema code.

## Honest Caveats

Typia feels like magic, but it has specific constraints you need to know:

1. It requires a build step. You have to use `ts-patch` or a bundler plugin like `unplugin-typia` to run the transformer during compilation.
2. Generics must be concrete at the call site. You can't pass an unresolved `T` to `typia.is<T>()`; the compiler needs to know exactly what `T` is to generate the validation logic.
3. No runtime schema manipulation. Since the validation code is generated at compile time, you can't build or modify schemas dynamically based on runtime data like you can with Zod or TypeBox.

If you can live with the build step, Typia removes an entire class of busywork. You stop maintaining two parallel definitions of the same shape. The types you already have. The ones the library author already wrote and tested. Just work as validators. That's a genuinely different thing from everything else out there.

For a broader look at how Typia's TS→JS approach compares to schema-first libraries, see [Typia Goes From TypeScript to JavaScript, Not the Other Way Around](./typia-typescript-to-javascript-validation.md).

## References

- [Typia GitHub](https://github.com/samchon/typia)
- [Typia documentation](https://typia.io/docs/)
- [unplugin-typia (bundler integration)](https://github.com/ryoppippi/unplugin-typia)
