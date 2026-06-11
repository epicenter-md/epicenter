# Simplify Sleeper Class to Function

## Status: Complete

## Problem

`packages/y-sweet/src/sleeper.ts` exports a `Sleeper` class that wraps a cancellable timeout. It has three issues:

1. **Dead code**: `reject` is stored but never called anywhere in the codebase.
2. **Unnecessary wrapper**: `sleep()` method just does `await this.promise`: adds no value.
3. **Over-abstraction**: A class with constructor + two methods for what is fundamentally `Promise.withResolvers()` + `setTimeout`.

## Current Usage

`provider.ts` uses `Sleeper` in two places for reconnection backoff:

```ts
// Line 115: stored as nullable property
private reconnectSleeper: Sleeper | null = null;

// Lines 345-346, 363-364: created and awaited
this.reconnectSleeper = new Sleeper(timeout);
await this.reconnectSleeper.sleep();

// Lines 168-170: woken early when online event fires
this.reconnectSleeper.wake();
```

## Changes

### 1. Replace `Sleeper` class with `createSleeper` function

Replace the class in `sleeper.ts` with:

```ts
export function createSleeper(timeout: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, timeout);
  return { promise, wake: resolve };
}
```

Export the return type as `Sleeper` for use in the provider's type annotation.

### 2. Update `provider.ts`

- Change import from `Sleeper` class to `createSleeper` function and `Sleeper` type.
- Change type annotation from `Sleeper | null` to `Sleeper | null` (no change needed: type alias keeps this stable).
- Replace `new Sleeper(timeout)` with `createSleeper(timeout)`.
- Replace `await this.reconnectSleeper.sleep()` with `await this.reconnectSleeper.promise`.
- `this.reconnectSleeper.wake()` stays unchanged.

## Tasks

- [x] Rewrite `sleeper.ts`: replace class with `createSleeper` function
- [x] Update `provider.ts`: swap to new API
- [x] Verify build passes
