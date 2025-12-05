# How Epicenter uses Workspace IDs and Names

I borrowed a page from Visual Studio Code's extension architecture. VS Code has Extension IDs and Command IDs. Epicenter workspaces have IDs and names. Same idea, different scale.

## The Problem

When you're building a system where multiple workspaces can depend on each other, you face a tension:

1. You need **globally unique identifiers** that will never conflict, even across different projects or installations
2. You need **human-readable names** for practical API access in your code

You can't have both with a single field. UUIDs are unique but terrible to type. Short names are readable but can collide.

## How VS Code Handles This

VS Code splits the concept:

- **Extension IDs** are globally unique (`publisher.extension-name`). They're enforced by the marketplace. No collisions possible.
- **Command IDs** are namespaced strings (`extension.commandName`). They can technically collide if two extensions pick the same string. Authors use prefixing to avoid conflicts.

Extension IDs guarantee uniqueness at the system level. Command IDs provide usable identifiers at the code level, with collision prevention through convention rather than enforcement.

## Epicenter's Approach

Epicenter workspaces have both an `id` and a `name`:

```typescript
const blogWorkspace = defineWorkspace({
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  name: 'blog',
  // ...
});
```

- **`id`**: A UUID or nanoid. Globally unique. Used internally as the YJS document GUID. You never type this in your code.
- **`name`**: A human-readable string. Used as the property key when accessing workspace actions from dependencies.

The `name` is what you use in practice:

```typescript
// In your actions
workspaces.blog.createPost({ title: 'Hello' });
workspaces.auth.login({ email, password });
```

Not this:

```typescript
// This would be terrible
workspaces['a1b2c3d4-e5f6-7890-abcd-ef1234567890'].createPost(...);
```

## Why Both?

The `id` ensures that your workspace's YJS document is unique across all contexts. Two developers in different projects can both create a workspace named "blog" without conflicts at the YJS level.

The `name` gives you practical namespacing for your dependency APIs. When you declare dependencies, those workspace names become your API surface:

```typescript
const appWorkspace = defineWorkspace({
  id: generateId(),
  name: 'app',
  dependencies: [blogWorkspace, authWorkspace],
  exports: ({ workspaces }) => ({
    publishPost: defineMutation({
      handler: async ({ postId }) => {
        // Check auth first
        const user = await workspaces.auth.getCurrentUser();
        if (!user) throw new Error('Not authenticated');

        // Publish the post
        return workspaces.blog.publishPost({ postId });
      }
    })
  })
});
```

The dependency graph uses names for clarity. The YJS layer uses IDs for uniqueness.

## Validation

Epicenter validates that workspace names don't collide within a single dependency tree. If you add two dependencies with the same name, you'll get an error:

```
Duplicate dependency workspace name detected: "blog"
```

This is intentional. Names are your API. If two dependencies have the same name, the API becomes ambiguous. Which `workspaces.blog` did you mean?

IDs can be the same across different projects (though they shouldn't be, since they're UUIDs). Names must be unique within your dependency graph.

## The Pattern

This pattern appears in lots of systems:

- **GitHub**: Repository IDs (numeric) vs. repository names (`username/repo`)
- **Docker**: Container IDs (long hash) vs. container names (human-readable)
- **Kubernetes**: UIDs (UUID) vs. names (DNS-compatible strings)
- **AWS**: Resource IDs (`i-1234567890abcdef0`) vs. Name tags

The pattern is always the same: unique identifier for the system, readable name for humans.

Epicenter uses this pattern because your workspace might get forked, copied, or used as a template. The ID stays globally unique. The name gets changed to fit the new context.

## When to Use Which

Use the **ID** when:
- Creating the YJS document
- Persisting workspace data
- Ensuring uniqueness across contexts

Use the **name** when:
- Accessing workspace actions from dependencies
- Writing code that references other workspaces
- Thinking about your API surface

In practice, you'll rarely touch the ID after initial creation. The name is what matters for day-to-day development.

## The Lesson

When you need both uniqueness and usability, use two fields. Don't compromise on either. Make the unique identifier truly unique (UUID/nanoid). Make the usable identifier truly usable (short, readable string).

The system uses one. Developers use the other. Everyone's happy.
