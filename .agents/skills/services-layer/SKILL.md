---
name: services-layer
description: 'Service layer patterns: UI-free business logic, namespace exports, Result return types, platform-specific service variants. Use when: "create a service", "service layer", creating or organizing services. For defining error types with defineErrors, use the define-errors skill instead.'
metadata:
  author: epicenter
  version: '2.0'
---

# Services Layer Patterns

This skill documents how to implement services in the Whispering architecture. Services are UI-free business logic with explicit app inputs and `Result<T, E>` return types.

> **Related Skills**: See `error-handling` for trySync/tryAsync patterns. See `define-errors` for error variant factories. See `query-layer` for consuming services from `$lib/rpc` with TanStack Query.

## When to Apply This Skill

Use this pattern when you need to:

- Create a new service with domain-specific error handling
- Understand how services are organized and exported
- Implement platform-specific service variants (desktop vs web)

## Core Architecture

Services follow a three-layer architecture: **Service** -> **RPC/Query** -> **UI**

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │  RPC/Query  │ --> │   Services   │
│ Components  │     │    Layer    │     │    (Pure)    │
└─────────────┘     └─────────────┘     └──────────────┘
```

**Services are:**

- **Pure**: Accept explicit parameters, no hidden dependencies
- **Isolated**: No knowledge of UI state, settings, or reactive stores
- **Testable**: Easy to unit test with mock parameters
- **Consistent**: All return `Result<T, E>` types for uniform error handling

## Creating Errors with defineErrors

Every service defines its domain-specific errors in a `defineErrors` namespace, colocated with the service and exported alongside it (const and type share the name). The `defineErrors` API itself (variant factories, `InferErrors`/`InferError`, call-site patterns) is owned by [define-errors](../define-errors/SKILL.md); read it there.

## Key Rules

1. **Services never import settings** - Pass configuration as parameters
2. **Services never import UI code** - No toasts, no notifications, no report calls
3. **Always return Result types** - Never throw errors
4. **Use trySync/tryAsync** - See the error-handling skill for details
5. **Export factory + Live instance** - Factory for testing, Live for production
6. **Split discriminated union inputs** - Each variant gets its own name and shape. If the constructor branches on its inputs (if/switch/ternary) to decide the message, each branch should be its own variant

## References

Load these on demand based on what you're working on:

- If working with **error variant anti-patterns** (discriminated union inputs, branching constructors), read [references/error-anti-patterns.md](references/error-anti-patterns.md)
- If working with **service implementation details** (factory patterns, recorder service examples), read [references/service-implementation-pattern.md](references/service-implementation-pattern.md)
- If working with **service organization and platform variants** (namespace exports, desktop vs web services), read [references/service-organization-platforms.md](references/service-organization-platforms.md)
- If working with **error message authoring** (user-friendly/actionable message design), read [references/error-message-best-practices.md](references/error-message-best-practices.md)

- See `apps/whispering/src/lib/services/README.md` for architecture details
- See the `query-layer` skill for how services are consumed
- See the `error-handling` skill for trySync/tryAsync patterns
