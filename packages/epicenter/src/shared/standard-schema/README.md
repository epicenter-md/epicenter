# Standard

Utilities for working with [Standard Schema](https://standardschema.dev) types.

Action inputs accept any StandardSchema-compliant schema (ArkType, Zod, Valibot). This folder contains utilities for converting and handling those schemas—distinct from `converters/` which handles our field schema format specifically.

The main use case is converting StandardSchema to JSON Schema for CLI flags, OpenAPI docs, and MCP tool definitions. The arktype-fallback handles ArkType-specific quirks during conversion (like `undefined` in unions having no JSON Schema equivalent).
