# OpenCode TypeScript Client Scaffold Plan

## Overview
Create a TypeScript client package that auto-generates from OpenCode's OpenAPI specification, with comprehensive tests and examples.

## Todo List
- [ ] Create package directory structure at `apps/sh/`
- [ ] Set up package.json with dependencies and scripts
- [ ] Create TypeScript configuration
- [ ] Implement OpenAPI spec fetching script
- [ ] Configure @hey-api/openapi-ts generation
- [ ] Add .gitignore for generated files
- [ ] Create test suite structure
- [ ] Implement basic client tests
- [ ] Implement session management tests
- [ ] Implement file operations tests
- [ ] Implement event stream tests
- [ ] Create comprehensive usage example
- [ ] Add development helper script
- [ ] Create README documentation
- [ ] Test the complete setup

## Package Structure
```
apps/sh/
├── scripts/
│   ├── fetch-openapi-spec.ts    # Fetches spec from OpenCode server
│   └── dev.ts                   # Development helper script
├── src/
│   ├── tests/
│   │   ├── basic-client-test.ts
│   │   ├── session-test.ts
│   │   ├── file-operations-test.ts
│   │   └── event-stream-test.ts
│   ├── examples/
│   │   └── comprehensive-example.ts
│   └── client/                  # Generated (gitignored)
├── openapi-ts.config.ts         # @hey-api/openapi-ts configuration
├── package.json                 # Package configuration
├── tsconfig.json               # TypeScript configuration
├── README.md                   # Package documentation
├── run-tests.ts               # Test runner CLI
└── .gitignore                 # Ignore generated files
```

## Implementation Details

### Dependencies
- @hey-api/openapi-ts: Code generation
- @hey-api/client-fetch: HTTP client
- typescript: Type checking
- @types/bun: Bun types

### Scripts
- `fetch-spec`: Fetch OpenAPI spec from running server
- `generate`: Fetch spec + generate TypeScript client
- `test`: Run test suite
- `dev`: Check server → fetch → generate → test

### Environment Variables
- `OPENCODE_URL`: OpenCode server URL (default: http://localhost:4096)
- `OPENCODE_PROVIDER`: Default provider for tests
- `OPENCODE_MODEL`: Default model for tests

## Notes
- The OpenCode server must be running locally at http://localhost:4096
- Generated files (doc.json, src/client/) will be gitignored
- Tests will serve as usage examples
- Support for multiple package managers (npm/yarn/pnpm/bun)