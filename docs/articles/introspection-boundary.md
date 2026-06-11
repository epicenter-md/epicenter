# The Introspection Boundary: Where Functions Kill Discoverability

**TL;DR**: If you need to know what an API can do without actually running it (for CLI help, MCP registration, or OpenAPI generation), don't wrap your definitions in functions. Use static objects for metadata/structure and reserve functions for the execution logic.

---

You're building a new CLI for your application. You want to show a helpful list of available commands when the user runs `--help`.

You reach for your workspace configuration:

```typescript
const workspace = {
  id: 'posts',
  actions: (context) => ({
    create: { handler: () => context.db.insert(...) },
    list: { handler: () => context.db.select(...) },
  })
};
```

To list those actions, you realize you have a problem. You can't just look at `workspace.actions`. You have to _call_ it. But calling it requires a `context`. And that `context` needs a database connection, a file system handle, and maybe an API key.

Suddenly, just to show a help message, your CLI needs to connect to the database. If the database is down, your help message fails. If the user hasn't configured their API key yet, your help message fails.

You've just hit the **Introspection Boundary**.

## What is Introspection?

In API design, **introspection** is the ability to examine and enumerate capabilities at runtime (or build-time) without executing the underlying logic.

It’s the difference between a restaurant menu and ordering a "chef's surprise." With a menu, you can see what's available, how much it costs, and if it's vegetarian before you commit to eating. With a "chef's surprise," you don't know what you're getting until it's already on your plate (and you've already paid).

In the world of software, we rely on introspection for:

- **CLI Help**: Enumerating commands and their arguments.
- **IDE Autocomplete**: Showing available methods as you type.
- **MCP Tool Registration**: Telling an AI assistant what tools are available.
- **OpenAPI/Swagger**: Generating documentation from your code.
- **GUI Generation**: Building a dashboard that shows buttons for every available action.

## The Fundamental Tension

When we design APIs in TypeScript, we often reach for functions first. Functions are the ultimate tool for abstraction! They give us:

1. **Dependency Injection**: Pass in what you need (like `context.db`) and keep your logic decoupled from specific implementations.
2. **Generics**: Create type-safe wrappers that adapt to their input, providing incredible flexibility across different data models.
3. **Lazy Evaluation**: Postpone expensive computations or side effects until they are absolutely necessary.
4. **Composability**: Wrap functions in other functions to build complex pipelines of logic.

But functions are **opaque**. From the perspective of your tools. Your CLI, your IDE, your documentation generator. A function is a "black box." In the JavaScript runtime, you can't "peek" inside a function to see what keys it _would_ return if you called it with a certain argument. You can't serialize a function to JSON to send it over the wire to a remote AI assistant.

This opacity creates a wall. On one side of the wall is your code, where everything is flexible and dynamic. On the other side is your tooling, which is desperately trying to figure out what your code actually _is_.

**Static objects**, conversely, are **transparent**. You can iterate over their keys using `Object.keys()`, you can inspect their properties at runtime, and you can easily serialize them to JSON (provided they don't contain circular references or functions themselves). They are immediately discoverable by both humans and machines.

The goal of good API design isn't to choose one over the other, but to find the correct boundary: **Structure and metadata should be static; behavior and execution should be dynamic.**

## Type Inference is NOT Introspection

Intermediate TypeScript developers often confuse **type inference** with **introspection**. This is an easy mistake to make because TypeScript is so good at following types through functions.

You might think: _"If I hover over my workspace client in VS Code, I can see all the actions! Doesn't that mean it's introspectable?"_

Not exactly. That is **static analysis** performed by your IDE using your source code. It works while you are writing code in your editor. But **introspection** needs to work when your program is actually running (or when a tool is analyzing your compiled JavaScript).

Imagine you're building a dashboard that needs to show a button for every available action in your workspace.

- **Static Analysis**: Helps you write `client.createPost()` correctly.
- **Introspection**: Allows your dashboard code to do `workspaces.map(w => w.actions.map(renderButton))`.

If your actions are hidden behind a factory function, your dashboard logic is stuck. It has to boot up the entire system just to find out which buttons to draw. This is where the developer experience starts to degrade.

## Example 1: The "Lazy" Action Pattern

Let's look at a common pattern (inspired by early versions of Epicenter) that kills introspection.

### ❌ The "Function-Wrapped" API

```typescript
// To list these actions, we MUST call the function
const blogWorkspace = {
	actions: (context: Context) => ({
		createPost: {
			description: 'Create a new blog post',
			handler: (input) => context.db.posts.insert(input),
		},
	}),
};

// ❌ Discovery requires full initialization
const ctx = await initializeDatabaseAndFilesystem();
const availableActions = Object.keys(blogWorkspace.actions(ctx));
```

This pattern is a nightmare for tooling. If you want to register these actions as "Tools" for an AI assistant (via the Model Context Protocol), the server has to fully boot up and connect to every dependency just to tell the AI what it _could_ do.

### ✅ The "Static Structure" API

Instead, define the _shape_ of the API as a static object, and keep the _behavior_ inside the handler.

```typescript
const blogWorkspace = {
	actions: {
		createPost: {
			description: 'Create a new blog post',
			// The handler receives the context at call-time
			handler: (context: Context, input: PostInput) => {
				return context.db.posts.insert(input);
			},
		},
	},
};

// ✅ Discovery is instant and "free"
const availableActions = Object.keys(blogWorkspace.actions);
```

Now, `Object.keys(blogWorkspace.actions)` works immediately. No database connection required.

## Example 2: Standard Schema's `~standard`

The TypeScript ecosystem recently introduced [Standard Schema](https://github.com/standard-schema/standard-schema), a common interface for validation libraries. It was born from a collaboration between the authors of Zod, ArkType, and Valibot, who realized that every library was reinventing the same "validation" wheel.

The challenge they faced was exactly the introspection boundary. How do you allow a library like TanStack Form or Hono to accept _any_ schema (Zod, ArkType, etc.) without making them understand the internals of every single library?

The solution was a perfect implementation of the static-metadata/dynamic-behavior split. Every compatible schema must have a `~standard` property:

```typescript
const mySchema = {
	// Static property that tools can check for
	'~standard': {
		version: 1, // Static: Metadata
		vendor: 'zod', // Static: Metadata
		// Function: The actual work
		validate: (value) => {
			// ... complex validation logic ...
		},
	},
};
```

By making `~standard` a static property on the object, any library can do a simple check: `if ('~standard' in schema)`. They don't have to call a function or initialize a provider. They can instantly discover if the object they've been given is a valid schema and which version of the protocol it follows.

If the authors had chosen a function-based approach like `schema.getStandardInfo()`, they would have introduced unnecessary friction. Every consumer would have to call that function, handle potential errors, and manage the execution context. By sticking to a static boundary, they made the entire ecosystem more interoperable.

## Example 3: The CLI Help Problem (and the "Boot-Loop" Trap)

Imagine you're building a CLI where the available commands are fetched from a database or a remote API. This sounds like a great way to build a "dynamic" and "pluggable" system.

```typescript
// ❌ The "Boot-Loop" Trap
export async function getCommands(db: Database) {
	const plugins = await db.query('SELECT * FROM registered_plugins');
	return plugins.map((p) => ({
		name: p.command_name,
		description: p.description,
		run: (args) => executePlugin(p.id, args),
	}));
}
```

The problem with this pattern is what I call the **"Boot-Loop" Trap**. When a user runs `my-cli --help`, they expect an instant response. But because your commands are wrapped in an async function that depends on a database, the CLI must now:

1. Locate the configuration file.
2. Parse the configuration.
3. Establish a connection to the database (which might involve network latency or local socket issues).
4. Execute a SQL query.
5. _Then finally_ render the help text.

This is a brittle architecture. If the database is offline, or if the user's configuration is slightly wrong, they can't even see the help message that might tell them how to fix it!

### The Better Way: Static Manifests

If you need dynamic commands, don't discover them at the moment of introspection. Discover them during a **sync** or **build** step, and save the result as a static manifest.

```typescript
// ✅ The Manifest Pattern
// commands-manifest.json (generated during 'my-cli sync')
[
	{ name: 'deploy', description: 'Deploy to production' },
	{ name: 'test', description: 'Run local tests' },
];

// Now your --help logic just reads a JSON file.
// It's fast, offline-compatible, and never crashes.
```

By separating the **discovery of commands** (dynamic) from the **display of commands** (static), you respect the introspection boundary and create a much more robust user experience.

## The Trade-offs Table

| Approach                               | Introspectable | Flexible | Dependency Injection |  Generics  |
| :------------------------------------- | :------------: | :------: | :------------------: | :--------: |
| **Static Object**                      |     ✅ Yes     |  ❌ No   |        ❌ No         |   ❌ No    |
| **Callback Factory**                   |     ❌ No      |  ✅ Yes  |        ✅ Yes        |   ✅ Yes   |
| **Static Structure + Dynamic Handler** |     ✅ Yes     |  ✅ Yes  |    ✅ In handler     | ⚠️ Limited |

## The Golden Rule: Metadata Static, Execution Dynamic

If you're designing a library or a system that others will build on, ask yourself: **"Do I need to enumerate this without running it?"**

If the answer is yes, follow this pattern:

1. **Define the keys and metadata statically.** (Names, descriptions, input schemas).
2. **Pass the "World" (Context/Dependencies) into the handlers.**
3. **Avoid "Middleman Functions"** that sit between the definition and the data.

### Analogy: The Restaurant Menu

- **The Menu (Static Object)**: You can read it standing on the sidewalk. You know they serve Pasta, Pizza, and Salad. You know the prices. You don't need a table to read it.
- **The Kitchen (Context)**: The stove, the ingredients, the chef.
- **The Meal (Execution)**: You only "invoke" the kitchen once you've looked at the menu and decided what you want.

In software, we too often force our users to walk into the kitchen, sit down, and fire up the stove just to see if the restaurant serves Pasta.

## Practical Guidance

When you find yourself wanting to wrap an object in a function "just in case I need to pass something in later," stop.

**Try this instead**:

- Define the object as a plain constant.
- If you need dependency injection, make the _methods_ on that object take the dependencies as arguments.
- If you need to generate parts of the object dynamically, do it at a specific "build step" and output a static manifest (like a `metadata.json` or a generated `.ts` file).

Introspection is the foundation of a great developer experience. Don't let your functions hide your API's potential.

---

**Next Steps**: Check out our article on the [Accessor Pattern](/docs/articles/accessor-pattern-explained.md) to see where functions _are_ the right tool for preserving reactivity.
