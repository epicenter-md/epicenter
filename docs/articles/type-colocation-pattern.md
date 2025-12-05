# Why I Stopped Using types/models.ts

I was looking at my codebase and saw this: `$lib/types/models.ts`. Just sitting there, accumulating random type definitions like a junk drawer. LocalModelConfig, UserModel, SessionModel—all unrelated types living together because... well, where else would you put "models"?

## The Problem with Type Buckets

It doesn't make sense to co-locate stuff that's completely unrelated. My transcription service was importing from `types/models.ts` just to get `LocalModelConfig`. My user service was going to the same place for `UserModel`. Different parts of my codebase were all importing from this one random location.

```typescript
// This was my types/models.ts
export type LocalModelConfig = { ... };  // Used by transcription service
export type UserModel = { ... };         // Used by user service
export type SessionModel = { ... };      // Used by session service
```

Why were these living together? They had nothing to do with each other.

I'd rather co-locate types as close to their services as possible, where it logically makes sense. The transcription service should own its types. The user service should own its types. Not some shared bucket they all reach into.

## The Refactoring That Changed My Perspective

I just moved `LocalModelConfig` from `$lib/types/models.ts` to `$lib/services/transcription/local/types.ts`.

That's it. One type. One move.

But look what happened:
- The transcription service now owns its type
- Components importing it know exactly where it comes from
- When I delete the transcription service, the type goes with it
- No more "wait, what uses this type again?" moments

## The Pattern I Follow Now

**Service types live with services:**
```typescript
// $lib/services/transcription/local/types.ts
export type LocalModelConfig = { ... };

// $lib/services/transcription/local/parakeet.ts
import type { LocalModelConfig } from './types';
```

**Component types live in components:**
```svelte
<!-- Button.svelte -->
<script lang="ts">
  type ButtonProps = {
    variant: 'primary' | 'secondary';
    size: 'sm' | 'md' | 'lg';
  };
</script>
```

**Domain types live in domain folders:**
```typescript
// $lib/services/user/types.ts
export type User = { ... };
export type UserProfile = { ... };
export type UserSettings = { ... };
```

## When This Clicked for Me

I was trying to delete an old feature. Found myself grep-ing through the codebase to figure out what types were actually part of that feature. Half were in `models.ts`, some in `types.ts`, others scattered around.

That's when I realized: co-location isn't just about organization. It's about being able to understand and modify your code without playing detective.

## The Only Exception

Sometimes you genuinely have types that cross domains. A `Timestamp` type used everywhere. An `ID` type that's truly universal. Fine. Put those in `$lib/types/common.ts` or something equally specific.

But "models"? That's not a category. That's just postponing the decision of where things actually belong.

## The Lesson

Stop creating type buckets. Start asking "who owns this?"

Every type has a home. It's usually right next to the code that cares about it most.

Since making this change, I've deleted entire features cleanly, refactored services without breaking unrelated code, and never once wondered "where should this type go?"

The answer is always: with the code that uses it.

---

*Note: This pattern applies to any codebase, not just TypeScript. Constants, types, utilities—they all benefit from living close to the code that depends on them.*