# MCP Dots in Tool Names: Confirmation

## Research Summary (2025-10-16)

### Official MCP Specification

**SEP-986 Proposal**: Specifies allowed characters for MCP tool names:
- Alphanumeric: `a-z`, `A-Z`, `0-9`
- Special characters: underscore `_`, dash `-`, **dot `.`**, forward slash `/`
- Length: 1-128 characters
- Case-sensitive

**Source**: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986

### Industry Practice

While many MCP servers use underscore notation (`get_weather`, `send_email`), dots are:
- ✅ **Officially allowed** per MCP specification
- ✅ **Used in hierarchical APIs** (similar to gRPC, GraphQL, Kubernetes)
- ✅ **Better for nested namespacing** (visual hierarchy)

### Examples from MCP Ecosystem

**Common underscore patterns**:
- `get_weather` (single operation)
- `send_email` (single operation)
- `create_pr` (single operation)

**Hierarchical patterns** (where dots shine):
- Kubernetes: `apps.v1.deployments`
- gRPC: `package.service.method`
- Our pattern: `workspace.category.entity.operation`

## Decision: Use Dots

**Pattern**: `workspace.category.entity.operation`

**Examples**:
```
blog.actions.createPost
blog.tables.posts.create
blog.indexes.sqlite.search
auth.actions.login
```

**Rationale**:
1. **Allowed by spec**: Dots are explicitly permitted
2. **Visual hierarchy**: Dots separate levels better than underscores
3. **RPC mapping**: Natural conversion to nested objects
4. **Industry alignment**: Matches patterns from gRPC, GraphQL, Kubernetes
5. **Collision prevention**: Explicit categories prevent naming conflicts

## Comparison

### Dot Notation (Chosen)
```typescript
// MCP Tool Name
blog.actions.createPost

// Maps naturally to RPC
rpc.blog.actions.createPost()

// Clear hierarchy
workspace → category → operation
```

### Underscore Notation (Not Chosen)
```typescript
// MCP Tool Name
blog_actions_createPost

// Requires parsing for RPC
rpc['blog_actions_createPost']() // or complex transformation

// Flatter, less hierarchical
workspace_category_operation
```

## Implementation Note

Action definitions use **simple names** without category prefix:

```typescript
// ✅ Define actions simply
actions: () => ({
  createPost: defineMutation(...),
})

// MCP registration adds prefix automatically
// → blog.actions.createPost
```

The `actions.` prefix is added by the registration layer, keeping workspace definitions clean.

## References

- SEP-986: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986
- MCP Specification: https://modelcontextprotocol.io/specification/
- Anthropic MCP Docs: https://docs.anthropic.com/en/docs/mcp
