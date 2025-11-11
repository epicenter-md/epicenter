# True Encapsulation: Factory Pattern with Closures

I was refactoring some test utilities in Whispering yesterday. The file had a handful of exported functions and some "internal" helpers that weren't exported. Standard stuff. But something felt off about it.

The internal helpers weren't really internal. They were just functions in the module scope that I chose not to export. Nothing actually prevented someone from exporting them later. The encapsulation was by convention, not by design.

So I tried something different.

## The Old Pattern

Here's what the code looked like before:

```typescript
// seed-mock-data.ts
export function seedIndexedDB() {
  const recordings = generateMockRecordings(10);
  const sessions = createTestSessions(3);

  // ... insert into IndexedDB
}

export function clearTestData() {
  // ... clear everything
}

export function createMockRecording(overrides = {}) {
  // ... create a recording with custom properties
}

// "Internal" helpers (not exported)
function generateMockRecordings(count: number) {
  return Array.from({ length: count }, () => createMockRecording());
}

function createTestSessions(count: number) {
  // ... generate test sessions
}
```

Multiple top-level exports. Some functions not exported. The idea was that `seedIndexedDB()`, `clearTestData()`, and `createMockRecording()` were the public API. The other two functions were implementation details.

But here's the thing: they're not implementation details. They're just unpublished exports. Anyone can add the `export` keyword and suddenly they're part of the API. There's nothing enforcing the boundary.

## The Problem in Practice

This pattern creates a few issues:

When you import from this module, you get a flat list of function names. There's no namespacing. You write:

```typescript
import { seedIndexedDB, clearTestData, createMockRecording } from './seed-mock-data';
```

Which function is which? They're all peers. Is `createMockRecording` a high-level operation like `seedIndexedDB`, or is it a helper? You have to read the implementation to know.

The module scope gets polluted. You have five functions at the top level, and two of them are "internal" but nothing enforces that. Another developer might come along and export one of them without realizing it was meant to be private.

And the "internal by convention" approach is fragile. Someone refactors the code, needs to use `generateMockRecordings` from another file, adds `export`, and now it's accidentally part of the public API.

## The Factory Pattern Solution

Here's what I changed it to:

```typescript
// seed-mock-data.ts
export function createTestData() {
  // Truly private helpers
  function generateMockRecordings(count: number) {
    return Array.from({ length: count }, () => createMockRecording());
  }

  function createTestSessions(count: number) {
    // ... generate test sessions
  }

  return {
    seedIndexedDB() {
      const recordings = generateMockRecordings(10);
      const sessions = createTestSessions(3);

      // ... insert into IndexedDB
    },

    clearTestData() {
      // ... clear everything
    },

    createMockRecording(overrides = {}) {
      // ... create a recording with custom properties
    }
  };
}
```

One export. One function. That function returns an object with methods.

The helpers are in the closure. They're not "unpublished exports" anymore. They're fundamentally inaccessible from outside the factory. You literally cannot export them. They don't exist outside the factory's scope.

## How It Works

When you call `createTestData()`, JavaScript creates a new execution context. The helper functions exist in that context. The returned object's methods close over that context, so they can access the helpers. But nothing else can.

The encapsulation is real. Not by convention. By design.

Usage looks like this:

```typescript
import { createTestData } from './seed-mock-data';

const testData = createTestData();

testData.seedIndexedDB();
testData.clearTestData();
const recording = testData.createMockRecording({ title: 'Test' });
```

Clean namespacing. You call `testData.seedIndexedDB()`, not just `seedIndexedDB()`. The relationship is clear: this is a method on the test data utilities object.

## Why This Matters

The factory pattern matches other patterns in the codebase. We use `createMigrationDialog()` in the UI layer. The pattern is consistent: a factory function returns an object with methods. Those methods have access to private state and helpers.

The object method shorthand syntax keeps it clean. No arrow functions, no `function` keyword. Just method names and implementations.

And the single export creates a clear entry point. Someone reading the code sees one exported function. That's the API. Everything inside is implementation.

## When to Use This Pattern

I don't use this pattern everywhere. For simple utilities that don't have internal helpers, top-level exports are fine. If it's just one function, export the function.

But when you have:
- Multiple related functions that form a coherent API
- Helper functions that are implementation details
- A desire for true encapsulation, not just convention

Then the factory pattern with closure-based encapsulation makes sense.

## The Lesson

Encapsulation isn't about what you don't export. It's about what can't be accessed.

Closures give you true privacy. Factory patterns give you clean APIs. Together, they let you design modules with clear boundaries and real enforcement.

I was treating "don't export" as encapsulation. But it's not. It's just a convention. JavaScript gives you real encapsulation with closures. It took me too long to realize I should use it.
