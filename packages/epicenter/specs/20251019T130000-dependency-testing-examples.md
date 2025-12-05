# Dependency Testing Examples

## Goal

Create comprehensive examples that test workspace dependency type safety, including:
- Single dependencies
- Multiple dependencies
- Chained/transitive dependencies
- Cross-workspace queries with full type inference
- Access to dependency schemas and actions

## Current State

Existing examples:
- **content-hub**: Has `pages` workspace as dependency, good pattern but limited
- **e2e-tests**: Single workspace, no dependencies
- **basic-workspace**: Single workspace, no dependencies

## Proposed Structure

Create a new `examples/dependency-testing` folder with multiple interconnected workspaces:

### 1. Users Workspace (Foundation)
- No dependencies
- Schema: users table with id, name, email, role
- Actions: getUser, createUser, getUsersByRole
- Exported separately for other workspaces to depend on

### 2. Posts Workspace (Single Dependency)
- Depends on: users
- Schema: posts table with id, title, content, authorId (references users)
- Actions:
  - getPost, createPost
  - Demonstrates accessing `workspaces.users.getUser()` for author data
  - Shows type safety when joining user data with posts

### 3. Comments Workspace (Single Dependency)
- Depends on: posts
- Schema: comments table with id, postId, authorId, content
- Actions:
  - getComment, createComment
  - Demonstrates accessing `workspaces.posts.getPost()`
  - Tests chained dependency (comments -> posts -> users, but comments can't directly access users)

### 4. Analytics Workspace (Multiple Dependencies)
- Depends on: users, posts, comments
- Schema: analytics table with metrics data
- Actions:
  - getUserStats (uses `workspaces.users` and `workspaces.posts`)
  - getPostStats (uses `workspaces.posts` and `workspaces.comments`)
  - Demonstrates multiple dependency access with full type safety

### 5. Main Workspace (Complex Dependencies)
- Depends on: analytics (which transitively brings in everything)
- Shows how flat dependency resolution works
- Tests that all workspaces are available even if not directly listed

## Type Safety Testing

Each workspace will demonstrate:
1. ✅ Accessing dependency actions with autocomplete
2. ✅ Type errors when accessing non-existent workspaces
3. ✅ Type errors when calling actions with wrong parameters
4. ✅ Proper inference of return types from dependency actions
5. ✅ Schema access from dependencies via db types

## Todo

- [x] Create examples/dependency-testing folder structure
- [x] Implement users workspace
- [x] Implement posts workspace with user dependency
- [x] Implement comments workspace with post dependency
- [x] Implement analytics workspace with multiple dependencies
- [x] Create main epicenter.config.ts tying everything together
- [x] Add inline comments demonstrating type safety
- [x] Test that TypeScript properly infers all types
- [x] Document patterns in README

## Review

### Implementation Summary

Successfully created comprehensive dependency testing examples in `packages/epicenter/examples/dependency-testing/`:

**Files Created**:
- `users.ts`: Foundation workspace with no dependencies
- `posts.ts`: Single dependency on users workspace
- `comments.ts`: Chained dependency on posts (which depends on users)
- `analytics.ts`: Multiple dependencies on users, posts, and comments
- `epicenter.config.ts`: Main configuration tying all workspaces together
- `type-safety-test.ts`: Executable test demonstrating type safety
- `README.md`: Comprehensive documentation of patterns

### Key Achievements

1. **Dependency Patterns**:
   - ✅ No dependencies (users)
   - ✅ Single dependency (posts → users)
   - ✅ Chained dependency (comments → posts → users)
   - ✅ Multiple dependencies (analytics → users, posts, comments)

2. **Type Safety Demonstrated**:
   - ✅ Full autocomplete for `workspaces.name.action()`
   - ✅ TypeScript errors for invalid workspace access
   - ✅ Parameter type checking with union types and literals
   - ✅ Return type inference from dependency actions
   - ✅ Non-transitive dependency access (comments cannot access users directly)

3. **Documentation**:
   - Extensive inline comments with ✅/❌ markers showing what works and what doesn't
   - README with examples, best practices, and key takeaways
   - Type safety test file with executable examples

### Type Safety Testing

Ran verification tests successfully:
```bash
bun type-safety-test.ts
# ✅ All type safety checks passed!
```

Config loads correctly:
```bash
bun --print "import config from './epicenter.config.ts'"
# Workspaces: users, posts, comments, analytics
```

### Notable Patterns Demonstrated

**Cross-workspace queries** (posts.ts):
```typescript
const authorResult = await workspaces.users.getUser({ id: post.authorId });
```

**Non-transitive access** (comments.ts):
```typescript
// ✅ Can access posts (direct dependency)
await workspaces.posts.getPost({ id: postId });

// ❌ CANNOT access users (not a direct dependency)
// await workspaces.users.getUser({ id: userId });
```

**Multiple dependencies** (analytics.ts):
```typescript
// ✅ Access ALL three workspaces
const user = await workspaces.users.getUser({ id: userId });
const posts = await workspaces.posts.getPostsByAuthor({ authorId: userId });
const comments = await workspaces.comments.getCommentsByAuthor({ authorId: userId });
```

### Impact

Provides clear, executable examples for testing:
- Workspace dependency patterns
- Type safety across workspace boundaries
- Cross-workspace data access
- Dependency validation patterns
- Multiple dependency management

The examples serve as both documentation and type safety test cases for the Epicenter dependency system.
