# Converters

Transform field schemas into format-specific representations.

Field schemas are minimal objects with `type` as the discriminant (e.g., `{ type: 'text', nullable: true }`). Different systems need them in different formats: ArkType for runtime validation, Drizzle for SQLite column definitions, ArkType-YJS for validating rows with Y.Text/Y.Array types.

Each converter takes the same input (a field schema or table schema) and produces output tailored to a specific consumer. If you need field schemas in a new format, add a converter here.

Note: For converting arbitrary StandardSchema types (like action inputs), see `../../shared/standard-schema/` instead.
