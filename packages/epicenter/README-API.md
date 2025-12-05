# Epicenter Workspace API

## Clean, Direct API

The epicenter workspace system provides a clean API where actions are directly callable functions:

```typescript
import { type } from 'arktype';
import { defineWorkspace, defineQuery, defineMutation, runWorkspace } from '@epicenter/hq';

// Define your workspace
const todosWorkspace = defineWorkspace({
  id: 'todos',
  tables: {
    todos: {
      id: id(),
      title: text(),
      completed: integer(),
    },
  },
  exports: () => ({
    getTodos: defineQuery({
      input: type({}),
      handler: async () => {
        // Your logic here
        return todos;
      },
    }),

    createTodo: defineMutation({
      input: type({
        title: 'string>0'
      }),
      handler: async (input) => {
        // Input is validated and typed!
        const newTodo = { id: '...', title: input.title, completed: false };
        todos.push(newTodo);
        return newTodo;
      },
    }),
  }),
});

// Use your workspace - clean, direct API!
const todos = await runWorkspace(todosWorkspace);

// Actions are directly callable - no .execute() needed!
await todos.createTodo({ title: 'Learn Epicenter' });
const allTodos = await todos.getTodos({});

// Actions still have properties for introspection
console.log(todos.createTodo.type); // 'mutation'
console.log(todos.getTodos.type);   // 'query'
```

## Key Features

1. **Direct action calls**: `todos.createTodo()` not `todos.createTodo.execute()`
2. **Automatic validation**: Input schemas are validated using Standard Schema
3. **Full type safety**: Input types are inferred from schemas
4. **Simple workspace return**: `runWorkspace` returns the workspace instance directly
5. **Action introspection**: Access `type`, `input`, and `handler` properties when needed

## Input Validation with Standard Schema

Actions use the [Standard Schema](https://github.com/standard-schema/standard-schema) specification, making them compatible with popular validation libraries:

- **ArkType** (recommended): `type({ name: 'string' })`
- **Valibot**: `v.object({ name: v.string() })`
- **Zod**: `z.object({ name: z.string() })`
- **Effect Schema**: `S.struct({ name: S.string })`
- Any other Standard Schema compliant library

## Action Types

### Queries
For read operations that don't modify state:

```typescript
defineQuery({
  input: type({ id: 'string' }),
  handler: async (input) => {
    // input.id is typed as string
    return findById(input.id);
  },
})
```

### Mutations
For operations that modify state:

```typescript
defineMutation({
  input: type({
    title: 'string',
    completed: 'boolean'
  }),
  handler: async (input) => {
    // input is fully typed
    return createItem(input);
  },
})
```