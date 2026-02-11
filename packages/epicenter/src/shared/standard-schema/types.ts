/**
 * Standard Schema type definitions.
 *
 * These interfaces are copied from the Standard Schema specification
 * (https://standardschema.dev) to avoid external dependencies.
 *
 * @see https://github.com/standard-schema/standard-schema
 */

// #########################
// ###   Standard Typed  ###
// #########################

/**
 * The Standard Typed interface. This is a base type extended by other specs.
 */
export type StandardTypedV1<Input = unknown, Output = Input> = {
	/** The Standard properties. */
	readonly '~standard': StandardTypedV1.Props<Input, Output>;
};

export declare namespace StandardTypedV1 {
	/** The Standard Typed properties interface. */
	type Props<Input = unknown, Output = Input> = {
		/** The version number of the standard. */
		readonly version: 1;
		/** The vendor name of the schema library. */
		readonly vendor: string;
		/** Inferred types associated with the schema. */
		readonly types?: Types<Input, Output> | undefined;
	};

	/** The Standard Typed types interface. */
	type Types<Input = unknown, Output = Input> = {
		/** The input type of the schema. */
		readonly input: Input;
		/** The output type of the schema. */
		readonly output: Output;
	};

	/** Infers the input type of a Standard Typed. */
	type InferInput<Schema extends StandardTypedV1> = NonNullable<
		Schema['~standard']['types']
	>['input'];

	/** Infers the output type of a Standard Typed. */
	type InferOutput<Schema extends StandardTypedV1> = NonNullable<
		Schema['~standard']['types']
	>['output'];
}

// ##########################
// ###   Standard Schema  ###
// ##########################

/**
 * The Standard Schema interface.
 *
 * Extends StandardTypedV1 with a validate function for runtime validation.
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
	/** The Standard Schema properties. */
	readonly '~standard': StandardSchemaV1.Props<Input, Output>;
};

export declare namespace StandardSchemaV1 {
	/** The Standard Schema properties interface. */
	type Props<Input = unknown, Output = Input> = StandardTypedV1.Props<
		Input,
		Output
	> & {
		/** Validates unknown input values. */
		readonly validate: (
			value: unknown,
			options?: StandardSchemaV1.Options | undefined,
		) => Result<Output> | Promise<Result<Output>>;
	};

	/** The result interface of the validate function. */
	type Result<Output> = SuccessResult<Output> | FailureResult;

	/** The result interface if validation succeeds. */
	type SuccessResult<Output> = {
		/** The typed output value. */
		readonly value: Output;
		/** A falsy value for `issues` indicates success. */
		readonly issues?: undefined;
	};

	/** Options for the validate function. */
	type Options = {
		/** Explicit support for additional vendor-specific parameters, if needed. */
		readonly libraryOptions?: Record<string, unknown> | undefined;
	};

	/** The result interface if validation fails. */
	type FailureResult = {
		/** The issues of failed validation. */
		readonly issues: ReadonlyArray<Issue>;
	};

	/** The issue interface of the failure output. */
	type Issue = {
		/** The error message of the issue. */
		readonly message: string;
		/** The path of the issue, if any. */
		readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
	};

	/** The path segment interface of the issue. */
	type PathSegment = {
		/** The key representing a path segment. */
		readonly key: PropertyKey;
	};

	/** Infers the input type of a Standard Schema. */
	type InferInput<Schema extends StandardTypedV1> =
		StandardTypedV1.InferInput<Schema>;

	/** Infers the output type of a Standard Schema. */
	type InferOutput<Schema extends StandardTypedV1> =
		StandardTypedV1.InferOutput<Schema>;
}

// ###############################
// ###   Standard JSON Schema  ###
// ###############################

/**
 * The Standard JSON Schema interface.
 *
 * Extends StandardTypedV1 with methods for generating JSON Schema.
 */
export type StandardJSONSchemaV1<Input = unknown, Output = Input> = {
	/** The Standard JSON Schema properties. */
	readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
};

export declare namespace StandardJSONSchemaV1 {
	/** The Standard JSON Schema properties interface. */
	type Props<Input = unknown, Output = Input> = StandardTypedV1.Props<
		Input,
		Output
	> & {
		/** Methods for generating the input/output JSON Schema. */
		readonly jsonSchema: StandardJSONSchemaV1.Converter;
	};

	/** The Standard JSON Schema converter interface. */
	type Converter = {
		/** Converts the input type to JSON Schema. May throw if conversion is not supported. */
		readonly input: (
			options: StandardJSONSchemaV1.Options,
		) => Record<string, unknown>;
		/** Converts the output type to JSON Schema. May throw if conversion is not supported. */
		readonly output: (
			options: StandardJSONSchemaV1.Options,
		) => Record<string, unknown>;
	};

	/**
	 * The target version of the generated JSON Schema.
	 *
	 * It is *strongly recommended* that implementers support `"draft-2020-12"` and `"draft-07"`,
	 * as they are both in wide use. All other targets can be implemented on a best-effort basis.
	 * Libraries should throw if they don't support a specified target.
	 *
	 * The `"openapi-3.0"` target is intended as a standardized specifier for OpenAPI 3.0
	 * which is a superset of JSON Schema `"draft-04"`.
	 */
	type Target =
		| 'draft-2020-12'
		| 'draft-07'
		| 'openapi-3.0'
		// Accepts any string for future targets while preserving autocomplete
		| (string & {});

	/** The options for the input/output methods. */
	type Options = {
		/** Specifies the target version of the generated JSON Schema. */
		readonly target: Target;
		/** Explicit support for additional vendor-specific parameters, if needed. */
		readonly libraryOptions?: Record<string, unknown> | undefined;
	};

	/** Infers the input type of a Standard JSON Schema. */
	type InferInput<Schema extends StandardTypedV1> =
		StandardTypedV1.InferInput<Schema>;

	/** Infers the output type of a Standard JSON Schema. */
	type InferOutput<Schema extends StandardTypedV1> =
		StandardTypedV1.InferOutput<Schema>;
}

// ###############################
// ###   Epicenter Extensions  ###
// ###############################

/**
 * Schema type that implements both StandardSchema (validation) and StandardJSONSchema (conversion).
 *
 * Use this as a constraint when you need:
 * 1. Runtime validation via `~standard.validate()`
 * 2. JSON Schema generation via `~standard.jsonSchema.input()`
 *
 * ArkType, Zod (v4.2+), and Valibot (with adapter) all implement both specs.
 *
 * @example
 * ```typescript
 * // ArkType
 * import { type } from 'arktype';
 * type('string') satisfies StandardSchemaWithJSONSchema; // ✅
 *
 * // Zod (v4.2+)
 * import * as z from 'zod';
 * z.string() satisfies StandardSchemaWithJSONSchema; // ✅
 * ```
 */
export type StandardSchemaWithJSONSchema<TInput = unknown, TOutput = TInput> = {
	'~standard': StandardSchemaV1.Props<TInput, TOutput> &
		StandardJSONSchemaV1.Props<TInput, TOutput>;
};
