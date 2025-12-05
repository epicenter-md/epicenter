# The Factory Function Pattern for YJS Documents

I was writing YJS code and every function looked like this:

```typescript
function addTodo(ydoc: Y.Doc, text: string) { ... }
function toggleTodo(ydoc: Y.Doc, id: string) { ... }
function deleteTodo(ydoc: Y.Doc, id: string) { ... }
function getTodos(ydoc: Y.Doc) { ... }
```

Every. Single. Function. Same first parameter.

That's when I realized I was doing it wrong.

## The Problem: YDoc as a Parameter

When you treat YDoc as a function parameter, you end up with this pattern:

```typescript
import * as Y from 'yjs';

// A bunch of functions that all take ydoc
function addTodo(ydoc: Y.Doc, text: string) {
  const todos = ydoc.getArray('todos');
  const todo = { id: generateId(), text, done: false };
  todos.push([todo]);
}

function toggleTodo(ydoc: Y.Doc, id: string) {
  const todos = ydoc.getArray('todos');
  const todoArray = todos.toArray();
  const index = todoArray.findIndex(t => t.id === id);
  if (index !== -1) {
    const todo = todoArray[index];
    todos.delete(index, 1);
    todos.insert(index, [{ ...todo, done: !todo.done }]);
  }
}

function deleteTodo(ydoc: Y.Doc, id: string) {
  const todos = ydoc.getArray('todos');
  const todoArray = todos.toArray();
  const index = todoArray.findIndex(t => t.id === id);
  if (index !== -1) {
    todos.delete(index, 1);
  }
}

function getTodos(ydoc: Y.Doc) {
  const todos = ydoc.getArray('todos');
  return todos.toArray();
}

// Usage: pass ydoc to everything
const ydoc = new Y.Doc();
addTodo(ydoc, 'Buy milk');
addTodo(ydoc, 'Walk dog');
toggleTodo(ydoc, '123');
const todos = getTodos(ydoc);
```

### What's Wrong With This?

1. **Repetitive**: Every function gets the Y.Array the same way
2. **Error-prone**: Easy to pass the wrong ydoc, or forget the parameter
3. **No encapsulation**: ydoc is exposed everywhere, can be misused
4. **No initialization**: Where do you set up observers or initial state?
5. **Testing pain**: Need to create and pass ydoc for every test

This is the procedural approach. It works, but it's not great.

## The Factory Function Pattern

Instead of functions that take ydoc as a parameter, create a factory that returns methods with ydoc in closure:

```typescript
import * as Y from 'yjs';

function createTodoList() {
  // Create and initialize ydoc once
  const ydoc = new Y.Doc();
  const todos = ydoc.getArray('todos');

  // Return methods that use the closure
  return {
    add(text: string) {
      const todo = { id: generateId(), text, done: false };
      todos.push([todo]);
    },

    toggle(id: string) {
      const todoArray = todos.toArray();
      const index = todoArray.findIndex(t => t.id === id);
      if (index !== -1) {
        const todo = todoArray[index];
        todos.delete(index, 1);
        todos.insert(index, [{ ...todo, done: !todo.done }]);
      }
    },

    delete(id: string) {
      const todoArray = todos.toArray();
      const index = todoArray.findIndex(t => t.id === id);
      if (index !== -1) {
        todos.delete(index, 1);
      }
    },

    getAll() {
      return todos.toArray();
    },

    // Expose ydoc only when needed (e.g., for sync providers)
    ydoc,
  };
}

// Usage: clean API, no ydoc parameters
const todoList = createTodoList();
todoList.add('Buy milk');
todoList.add('Walk dog');
todoList.toggle('123');
const todos = todoList.getAll();
```

### What Changed?

1. **No repetitive parameters**: Methods don't need ydoc
2. **Encapsulated state**: `todos` is private to the factory
3. **Clean API**: Methods are self-contained
4. **Single initialization**: Set up everything once in the factory
5. **Easier testing**: `const list = createTodoList()` gives you a fresh instance

The ydoc and todos live in the closure. Every method has access without needing parameters.

## Example: Simple Counter

Here's the pattern at its most minimal:

```typescript
function createCounter() {
  const ydoc = new Y.Doc();
  const state = ydoc.getMap('state');
  state.set('count', 0);

  return {
    increment() {
      const current = state.get('count') || 0;
      state.set('count', current + 1);
    },

    decrement() {
      const current = state.get('count') || 0;
      state.set('count', current - 1);
    },

    get value() {
      return state.get('count') || 0;
    },

    ydoc,
  };
}

// Usage
const counter = createCounter();
counter.increment(); // 1
counter.increment(); // 2
counter.decrement(); // 1
console.log(counter.value); // 1
```

No parameters. No repetition. Just methods that work.

## Example: Collaborative Canvas

Here's a more complex example with multiple Y types and observers:

```typescript
type Shape = {
  id: string;
  type: 'rect' | 'circle';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
};

function createCanvas(onShapeAdded?: (shape: Shape) => void) {
  const ydoc = new Y.Doc();
  const shapes = ydoc.getMap('shapes');
  const selectedId = ydoc.getMap('selection');

  // Set up observer during initialization
  if (onShapeAdded) {
    shapes.observe((event) => {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'add') {
          const shape = shapes.get(key);
          if (shape) onShapeAdded(shape);
        }
      });
    });
  }

  return {
    addShape(shape: Omit<Shape, 'id'>) {
      const id = generateId();
      shapes.set(id, { ...shape, id });
      return id;
    },

    moveShape(id: string, x: number, y: number) {
      const shape = shapes.get(id);
      if (shape) {
        shapes.set(id, { ...shape, x, y });
      }
    },

    deleteShape(id: string) {
      shapes.delete(id);
      // Also clear selection if this shape was selected
      if (selectedId.get('current') === id) {
        selectedId.delete('current');
      }
    },

    selectShape(id: string) {
      selectedId.set('current', id);
    },

    getSelected() {
      const id = selectedId.get('current');
      return id ? shapes.get(id) : null;
    },

    getAllShapes() {
      return Array.from(shapes.values());
    },

    ydoc,
  };
}

// Usage
const canvas = createCanvas((shape) => {
  console.log('Shape added:', shape);
});

const rectId = canvas.addShape({
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  color: 'blue',
});

canvas.selectShape(rectId);
canvas.moveShape(rectId, 50, 50);
```

Notice how:
- Multiple Y types (`shapes`, `selectedId`) are all encapsulated
- Observer is set up during initialization
- Methods are cohesive and self-contained
- No Y.Map references leak to consumers

## Benefits of This Pattern

### 1. Encapsulation

The ydoc and internal Y types are private. Consumers can't accidentally misuse them:

```typescript
// With factory: can't do this
const canvas = createCanvas();
// canvas.shapes is not accessible ✅

// With parameter pattern: can do this
function addShape(ydoc: Y.Doc, shape: Shape) { ... }
// Someone can pass wrong ydoc or manipulate it directly ❌
```

### 2. Initialization in One Place

Set up everything when you create the instance:

```typescript
function createChat() {
  const ydoc = new Y.Doc();
  const messages = ydoc.getArray('messages');
  const users = ydoc.getMap('users');

  // Initialize state
  users.set('online', new Y.Array());

  // Set up observers
  messages.observe(() => {
    scrollToBottom();
  });

  // Return methods
  return { ... };
}
```

With the parameter pattern, you'd need separate initialization functions that everyone has to remember to call.

### 3. Composability

Factories can use other factories:

```typescript
function createWorkspace() {
  const ydoc = new Y.Doc();

  // Each factory gets access to the shared ydoc
  const todos = createTodoList(ydoc);
  const notes = createNotepad(ydoc);
  const canvas = createCanvas(ydoc);

  return {
    todos,
    notes,
    canvas,
    ydoc,
  };
}

// Usage: everything shares one ydoc
const workspace = createWorkspace();
workspace.todos.add('Task');
workspace.notes.write('Note');
workspace.canvas.addShape({ ... });
```

### 4. Testing

Create fresh instances trivially:

```typescript
describe('TodoList', () => {
  it('should add todos', () => {
    const list = createTodoList();
    list.add('Test todo');
    expect(list.getAll()).toHaveLength(1);
  });

  it('should toggle todos', () => {
    const list = createTodoList();
    const id = list.add('Test todo');
    list.toggle(id);
    expect(list.getAll()[0].done).toBe(true);
  });
});
```

No setup, no teardown, no shared state between tests.

## Advanced: Lazy Initialization

Sometimes you don't need the ydoc immediately:

```typescript
function createEditor() {
  let ydoc: Y.Doc | null = null;
  let text: Y.Text | null = null;

  function ensureInitialized() {
    if (!ydoc) {
      ydoc = new Y.Doc();
      text = ydoc.getText('content');
    }
  }

  return {
    insert(index: number, content: string) {
      ensureInitialized();
      text!.insert(index, content);
    },

    delete(index: number, length: number) {
      ensureInitialized();
      text!.delete(index, length);
    },

    get content() {
      ensureInitialized();
      return text!.toString();
    },

    get ydoc() {
      ensureInitialized();
      return ydoc!;
    },
  };
}
```

The ydoc is created only when first needed. Useful for heavy initialization.

## Advanced: Configuration

Pass configuration to the factory:

```typescript
type TodoListConfig = {
  maxTodos?: number;
  onTodoAdded?: (todo: Todo) => void;
  persistence?: {
    save: (state: any) => void;
    load: () => any;
  };
};

function createTodoList(config: TodoListConfig = {}) {
  const ydoc = new Y.Doc();
  const todos = ydoc.getArray('todos');

  // Load persisted state
  if (config.persistence) {
    const saved = config.persistence.load();
    if (saved) {
      todos.push(saved);
    }
  }

  // Set up observer
  if (config.onTodoAdded) {
    todos.observe((event) => {
      event.changes.added.forEach((item) => {
        config.onTodoAdded!(item.content.getContent()[0]);
      });
    });
  }

  return {
    add(text: string) {
      if (config.maxTodos && todos.length >= config.maxTodos) {
        throw new Error('Max todos reached');
      }
      const todo = { id: generateId(), text, done: false };
      todos.push([todo]);

      // Auto-save
      if (config.persistence) {
        config.persistence.save(todos.toArray());
      }
    },

    // ... other methods
  };
}

// Usage
const list = createTodoList({
  maxTodos: 100,
  onTodoAdded: (todo) => console.log('Added:', todo),
  persistence: {
    save: (state) => localStorage.setItem('todos', JSON.stringify(state)),
    load: () => JSON.parse(localStorage.getItem('todos') || '[]'),
  },
});
```

Configuration lives in one place, making the API flexible without adding parameters to every method.

## When to Use This Pattern

**Use factory functions when:**
- You have multiple operations on the same ydoc
- You want to encapsulate YJS implementation details
- You need initialization logic (observers, initial state)
- You're building a reusable module or library
- You want clean, testable APIs

**Stick with parameters when:**
- You have a single utility function
- You need to operate on multiple different ydocs
- The function is genuinely stateless

## The Transformation

From this:
```typescript
function addTodo(ydoc: Y.Doc, text: string) { ... }
function toggleTodo(ydoc: Y.Doc, id: string) { ... }

const ydoc = new Y.Doc();
addTodo(ydoc, 'Task');
toggleTodo(ydoc, '123');
```

To this:
```typescript
function createTodoList() {
  const ydoc = new Y.Doc();
  return {
    add(text: string) { ... },
    toggle(id: string) { ... },
  };
}

const todos = createTodoList();
todos.add('Task');
todos.toggle('123');
```

Same functionality, cleaner API, better encapsulation.

## The Lesson

YJS documents aren't just data structures you pass around. They're stateful, collaborative objects that benefit from encapsulation.

Factory functions give you:
- Private state captured in closures
- Single place for initialization
- Clean APIs without repetitive parameters
- Better testability and composability

When you find yourself passing ydoc to every function, step back. You probably want a factory.
