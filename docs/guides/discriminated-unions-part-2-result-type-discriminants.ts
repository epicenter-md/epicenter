/**
 * Understanding Result Type Discriminants: Building to Symmetry
 * Part 2 of 2 - See ./discriminated-union-demo.ts for Part 1
 *
 * The Result type can be written multiple ways. This guide shows why
 * having BOTH properties present in ALL variants is the key insight.
 *
 * PREREQUISITE: Start with "./discriminated-union-demo.ts" first.
 * This guide assumes you understand Pattern 2 (data property as discriminant).
 */

// ============================================================================
// The Core Requirement: A Discriminant Must Be Present in ALL Variants
// ============================================================================

/*
 * Before we look at Result types, let's revisit the fundamental rule:
 *
 * A property can only be a discriminant if it's PRESENT in ALL variants.
 *
 * This is easy to forget because Pattern 1 (dedicated 'type' field) makes
 * it obvious. But with Pattern 2 (data property as discriminant), you might
 * accidentally omit the property from a variant.
 *
 * If a property is missing from a variant, you can't check its value.
 * And if you can't check its value, it can't narrow the type.
 */

// ============================================================================
// Problem 1: No Shared Property (Complete Omission)
// ============================================================================

/*
 * The most intuitive way to write a Result type seems like this:
 * - Success has data
 * - Failure has error
 * - Each variant only has what it needs
 *
 * This doesn't work:
 */

// ❌ No shared property between variants
type ResultOmitted<T, E> =
	| { data: T } // Success: only data
	| { error: E }; // Failure: only error

function handleOmitted<T, E>(result: ResultOmitted<T, E>) {
	// ❌ Can't check result.data !== undefined
	// TypeScript error: Property 'data' does not exist on type 'ResultOmitted<T, E>'
	// (because 'data' doesn't exist in the { error: E } variant)

	// ❌ Can't check result.error !== undefined either
	// Same problem: 'error' doesn't exist in the { data: T } variant

	// The only option is the 'in' operator:
	if ('data' in result) {
		const value: T = result.data; // ✅ This works
		console.log('Success:', value);
	} else {
		const err: E = result.error; // ✅ This works
		console.error('Error:', err);
	}
}

/*
 * Why is this a problem?
 *
 * 1. You can't use !== null or !== undefined checks
 *    The property doesn't exist, so you can't check its value.
 *
 * 2. The 'in' operator works but has a subtle issue:
 *    Nothing prevents { data: "hello", error: new Error() } at runtime.
 *    Both properties can coexist! There's no mutual exclusivity.
 *
 * 3. No discriminant exists:
 *    - 'data' isn't present in all variants (missing from error variant)
 *    - 'error' isn't present in all variants (missing from data variant)
 *    - Neither property qualifies as a discriminant!
 *
 * The core issue: A discriminant must be present in ALL variants.
 * When you omit properties, you have no discriminant.
 */

// ============================================================================
// Problem 2: Partial Omission (One Property Missing)
// ============================================================================

/*
 * OK, so we need a shared property. What if we make ONE property
 * present in both variants, but omit the other?
 *
 * This is closer, but still doesn't work:
 */

// ❌ Attempt 1: 'data' is shared, but 'error' is missing from success variant
type ResultDataOnly<T, E> =
	| { data: T } // Success: I have data (no error property)
	| { data: null; error: E }; // Failure: no data, but I have error

function handleDataOnly<T, E>(result: ResultDataOnly<T, E>) {
	if (result.data !== null) {
		const value: T = result.data;
		console.log('Success:', value);
	} else {
		// You'd expect result.data to be `null` here. It's actually `T | null`.
		// (See "A subtle gotcha" below for why.)
		const t = result.data; // t: T | null

		// ❌ Type error! 'error' doesn't exist on the union
		// TypeScript narrowed 'data' to null, but can't guarantee 'error' exists
		// const err: E = result.error;
	}
}

/*
 * A subtle gotcha: why is `t` typed as `T | null`, not `null`?
 *
 * `T` is unbounded: it could itself include null. If someone instantiates
 * ResultDataOnly<string | null, Error>:
 *   - Variant 1: { data: string | null }   ← can satisfy data === null!
 *   - Variant 2: { data: null; error: E }
 *
 * After `result.data === null`, BOTH variants are still possible, so
 * `result.data` is the union of the two: T (from V1) | null (from V2) = T | null.
 *
 * Checking `=== null` doesn't narrow a generic `T` inside a variant. It only
 * includes or excludes whole variants from the union.
 *
 * The symmetric pattern below sidesteps this: by giving every variant BOTH
 * `data` and `error`, you get two independent discriminants. Even when one
 * is ambiguous due to generics, the other narrows cleanly.
 */

// ❌ Attempt 2: 'error' is shared, but 'data' is missing from failure variant
type ResultErrorOnly<T, E> =
	| { data: T; error: null } // Success: no error, I have data
	| { error: E }; // Failure: I have error (no data property)

function handleErrorOnly<T, E>(result: ResultErrorOnly<T, E>) {
	if (result.error !== null) {
		const err: E = result.error;
		console.error('Error:', err);
	} else {
		// ❌ Type error! 'data' doesn't exist on the union
		// TypeScript narrowed 'error' to null, but can't guarantee 'data' exists
		// const value: T = result.data;
	}
}

/*
 * Why these fail:
 * - The discriminant ('data' or 'error') IS present in both variants ✅
 * - But the OTHER property is omitted from one variant ❌
 * - TypeScript can narrow the discriminant, but can't guarantee
 *   the other property exists
 *
 * The fix: Make BOTH properties present in ALL variants.
 */

// ============================================================================
// The Solution: Both Properties in All Variants
// ============================================================================

/*
 * When BOTH properties are present in ALL variants, TypeScript can
 * narrow on EITHER property. This is the symmetric pattern from Part 1.
 */

type Result<T, E> =
	| { data: T; error: null } // 'data' is complete: T vs null
	| { data: null; error: E }; // 'error' is complete: null vs E
// ↑ BOTH properties in BOTH variants!

/*
 * Now BOTH properties are discriminants:
 * - 'data' can discriminate (T vs null)
 * - 'error' can discriminate (null vs E)
 *
 * This means we can check EITHER property to narrow the type!
 */

function handleResult<T, E>(result: Result<T, E>) {
	// Option 1: Check error first
	if (result.error !== null) {
		const err: E = result.error; // ✅ error is E
		console.error('Error:', err);
		// result.data is null here
		return;
	}

	const value: T = result.data; // ✅ data is T
	console.log('Success:', value);
	// result.error is null here
}

function handleResult2<T, E>(result: Result<T, E>) {
	// Option 2: Check data first (equally valid!)
	if (result.data !== null) {
		const value: T = result.data; // ✅ data is T
		console.log('Success:', value);
		// result.error is null here
	} else {
		const err: E = result.error; // ✅ error is E
		console.error('Error:', err);
		// result.data is null here
	}
}

/*
 * This is the symmetrical pattern (Pattern 3 from discriminated-union-demo.ts):
 *
 * When you make BOTH properties complete, you get symmetry.
 * Check whichever property makes sense in your context!
 *
 * The key insight: This Result type IS a discriminated union.
 * It's Pattern 2 (data property as discriminant) applied to BOTH properties.
 * That's why either property can narrow the type.
 */

// ============================================================================
// Summary: The Discriminant Checklist
// ============================================================================

/*
 * For a property to be a discriminant, it must:
 * 1. Be PRESENT in ALL variants (not omitted from any)
 * 2. Have DISTINGUISHABLE VALUES across variants (T vs null, 'a' vs 'b', etc.)
 *
 * { data: T } | { error: E }
 * ❌ No discriminant: neither property is present in all variants
 *
 * { data: T } | { data: null; error: E }
 * ⚠️ Partial: 'data' discriminates, but 'error' is missing from success
 *
 * { data: T; error: null } | { data: null; error: E }
 * ✅ Symmetric: BOTH properties are discriminants, check either one!
 *
 * The symmetric pattern gives you maximum flexibility and type safety.
 */
