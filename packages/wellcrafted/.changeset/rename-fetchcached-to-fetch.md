---
"wellcrafted": minor
---

Rename fetchCached method to fetch in query definitions

BREAKING CHANGE: The `fetchCached()` method on query definitions has been renamed to `fetch()` to better reflect its actual behavior. This method intelligently fetches data from cache OR network based on staleness.

**Migration:**
- Replace all `.fetchCached()` calls with `.fetch()`
- No functional changes - behavior remains identical
- See MIGRATION_FETCHCACHED_TO_FETCH.md for detailed migration guide

**Before:**
```typescript
const { data, error } = await userQuery.fetchCached();
```

**After:**
```typescript
const { data, error } = await userQuery.fetch();
```