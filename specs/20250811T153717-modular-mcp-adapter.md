# Modular MCP Adapter System

## Problem

We need a way to ingest, store, and query exported personal data from various social media and content platforms (e.g., Twitter, Spotify, Reddit) in a safe, structured, and extensible manner.  
The system should allow an LLM to query this data through MCP tools without directly writing SQL, while supporting platform-specific schemas and metadata.

## Goals

- Allow each platform ("adapter") to define its own schema, metadata, and parsing logic
- Store data in a local SQLite database using Drizzle ORM
- Expose safe, structured MCP tools for querying
- Provide human-readable schema context to the LLM at runtime
- Support adapter-defined "views" or "CTEs" for common complex queries
- Keep the system modular and extensible for future platforms

## Plan

### Todo Items

- [ ] Define `Adapter` interface (schema, metadata, views, lifecycle hooks)
- [ ] Implement `mcp-core` package to:
  - Load adapters dynamically
  - Merge schemas and metadata
  - Register MCP tools (`describe_schema`, `query_social_data`)
  - Validate and execute structured queries
- [ ] Implement initial adapters (Twitter, Spotify) in `mcp-adapters` package
- [ ] Support adapter-defined views/CTEs for common queries
- [ ] Provide schema dictionary to LLM for context
- [ ] Integrate MCP server into CLI app for local testing
- [ ] Plan for potential adapter splitting into separate packages in the future

### Implementation Approach

1. **Core**: Create `mcp-core` to handle server startup, adapter loading, schema registry, and query execution.
2. **Adapters**: Implement `mcp-adapters` with one folder per platform, each exporting schema, metadata, and optional views.
3. **MCP Tools**:
   - `describe_schema`: Returns all tables/views and their columns with descriptions
   - `query_social_data`: Accepts structured query parameters (sources, joins, filters, select, limit) and executes safely
4. **Views/CTEs**: Allow adapters to define named queries for common patterns, exposed as virtual tables to the LLM.
5. **Integration**: Wire MCP server into CLI for local dev; later integrate into Tauri app.

### Key Considerations

- **Safety**: LLM never writes raw SQL; all queries validated against known schema
- **Extensibility**: Easy to add new adapters without modifying core
- **Performance**: Views/CTEs can optimize common queries
- **Maintainability**: Keep adapters self-contained; design for possible future package split
- **LLM Context**: Provide clear, human-readable descriptions for all columns and views
