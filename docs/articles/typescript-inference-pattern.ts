// ============================================================================
// TypeScript Inference Pattern: Parameterize Values, Not Function Types
// ============================================================================
//
// THE CORE LESSON:
// When you have dependencies between object properties (where property B needs
// the inferred type of property A), don't use computed types like ReturnType<>.
// Instead, parameterize the VALUES and inline the function signatures.
//
// Why? TypeScript infers all properties simultaneously. Using ReturnType<T>
// creates a circular dependency: to infer T, it needs ReturnType<T>, but
// ReturnType<T> depends on T being inferred first. TypeScript breaks this
// cycle by widening to the constraint (usually `any`).

// ============================================================================
// THE PROBLEM: Circular Inference After Parameterizing Function Types
// ============================================================================

// ❌ This pattern fails because of circular type inference
type ConfigBroken<
	TStatic,
	TTransformFn extends (input: TStatic) => any,
	TCombinedFn extends (input: {
		static: TStatic;
		transformed: ReturnType<TTransformFn>; // ❌ Needs TTransformFn, but TTransformFn is being inferred!
	}) => any,
> = {
	static: TStatic;
	transform: TTransformFn;
	combined: TCombinedFn;
};

function defineConfigBroken<
	TStatic,
	TTransformFn extends (input: TStatic) => any,
	TCombinedFn extends (input: {
		static: TStatic;
		transformed: ReturnType<TTransformFn>;
	}) => any,
>(config: ConfigBroken<TStatic, TTransformFn, TCombinedFn>) {
	return config;
}

const resultBroken = defineConfigBroken({
	static: { count: 5 },
	transform: (input) => input.count * 2,
	combined: ({ static, transformed }) => {
		// static is correctly typed as { count: number } ✅
		// transformed is 'any' instead of 'number' ❌
		return transformed + 1;
	},
});

// ============================================================================
// THE SOLUTION: Parameterize Values, Inline Function Signatures
// ============================================================================

// ✅ This pattern works: parameterize the RETURN TYPE, not the function type. It's almost like pattern matching
type Config<TStatic, TTransformResult, TCombinedResult> = {
	static: TStatic;
	// Inline the function signature, parameterize what it returns
	transform: (input: TStatic) => TTransformResult;
	// Use TTransformResult directly (no ReturnType needed)
	combined: (input: {
		static: TStatic;
		transformed: TTransformResult;
	}) => TCombinedResult;
};

function defineConfig<TStatic, TTransformResult, TCombinedResult>(
	config: Config<TStatic, TTransformResult, TCombinedResult>,
) {
	return config;
}

const result = defineConfig({
	static: { count: 5 },
	transform: (input) => input.count * 2,
	combined: ({ static, transformed }) => {
		// static is correctly typed as { count: number } ✅
		// transformed is 'number' ✅
		return transformed + 1;
	},
});

// Why does this work?
// TypeScript infers TTransformResult directly from the return value of transform.
// No circular dependency: it doesn't need to compute anything from types that
// are still being inferred. The simultaneity is fine because you're inferring
// from concrete values, not from types-of-types.

// ============================================================================
// EXAMPLE: Scaling to Collections of Functions
// ============================================================================

// The same principle scales when you have multiple functions with different return types.
// Parameterize the RESULT OBJECT SHAPE, then use a mapped type to preserve the
// relationship between keys and their function return types.

// ✅ The mapped type is what makes this work
type TransformMap<TStatic, TTransformResults, TCombinedResult> = {
	static: TStatic;
	transform: {
		[K in keyof TTransformResults]: (input: TStatic) => TTransformResults[K];
	};
	combined: (input: { transformed: TTransformResults }) => TCombinedResult;
};

function defineTransformMap<TStatic, TTransformResults, TCombinedResult>(
	config: TransformMap<TStatic, TTransformResults, TCombinedResult>,
) {
	return config;
}

const multiResult = defineTransformMap({
	static: { count: 5 },
	transform: {
		doubled: (input) => input.count * 2, // Returns number
		squared: (input) => input.count ** 2, // Returns number
		message: (input) => `Count: ${input.count}`, // Returns string
	},
	combined: ({ transformed }) => {
		// transformed is { doubled: number, squared: number, message: string } ✅
		return `${transformed.message} (${transformed.doubled})`;
	},
});

// Why the mapped type { [K in keyof TTransformResults]: (input: TStatic) => TTransformResults[K] } is essential:
//
// TypeScript infers TTransformResults from the actual implementations:
//   - doubled: (input) => input.count * 2          → TTransformResults['doubled'] = number
//   - squared: (input) => input.count ** 2         → TTransformResults['squared'] = number
//   - message: (input) => `Count: ${input.count}`  → TTransformResults['message'] = string
//
// Result: TTransformResults = { doubled: number, squared: number, message: string }
//
// The mapped type preserves the connection between each key and its specific return type.
// Without it (e.g., Record<string, (input: TStatic) => any>), you lose all type information.

// ============================================================================
// EXAMPLE 2: Three-Stage Dependencies (Real-World Pattern)
// ============================================================================

// This pattern is crucial for multi-stage configurations where:
// Stage 1 (schema) → Stage 2 (indexes) → Stage 3 (actions)

type WorkspaceSchema = Record<string, Record<string, unknown>>;
type WorkspaceIndexMap = Record<string, { type: string }>;
type WorkspaceActionMap = Record<string, () => unknown>;

type Db<TSchema extends WorkspaceSchema> = {
	tables: TSchema;
};

// ✅ Parameterize the index map and action map values
type Workspace<
	TSchema extends WorkspaceSchema,
	TIndexMap extends WorkspaceIndexMap,
	TActionMap extends WorkspaceActionMap,
> = {
	schema: TSchema;
	// Inline function signature, parameterize return value
	indexes: (ctx: { db: Db<TSchema> }) => TIndexMap;
	// Use TIndexMap directly, no ReturnType needed
	actions: (ctx: { db: Db<TSchema>; indexes: TIndexMap }) => TActionMap;
};

function defineWorkspace<
	TSchema extends WorkspaceSchema,
	TIndexMap extends WorkspaceIndexMap,
	TActionMap extends WorkspaceActionMap,
>(config: Workspace<TSchema, TIndexMap, TActionMap>) {
	return config;
}

const workspace = defineWorkspace({
	schema: {
		posts: { id: '', title: '', content: '' },
	},

	indexes: ({ db }) => ({
		sqlite: { type: 'sqlite' as const, db },
		markdown: { type: 'markdown' as const, path: './data' },
	}),

	actions: ({ indexes }) => ({
		getPost: () => {
			// indexes.sqlite is properly typed as { type: 'sqlite', db: ... } ✅
			return indexes.sqlite.type;
		},
		searchPosts: () => {
			// indexes.markdown is properly typed as { type: 'markdown', path: string } ✅
			return indexes.markdown.path;
		},
	}),
});

// ============================================================================
// KEY TAKEAWAYS
// ============================================================================

// 1. ALWAYS parameterize the VALUES (return types), not the FUNCTION TYPES
//    Let TypeScript infer the return type from actual implementation

// 2. INLINE function signatures in your type definitions

// 3. USE mapped types for objects of functions
//    { [K in keyof TResults]: (input: T) => TResults[K] }

// 4. TRUST inference from concrete values
//    TypeScript is excellent at inferring from what you actually return

// This pattern works because:
// - TypeScript infers result types directly from return values
// - No circular dependencies between type parameters
// - Simultaneous inference is fine when you're not computing types from types
//   that are themselves being inferred
