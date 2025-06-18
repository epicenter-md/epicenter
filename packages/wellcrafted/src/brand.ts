/**
 * Internal symbol used to create nominal typing for branded types.
 * @internal
 */
const brand = Symbol("wellcrafted/brand");

/**
 * Creates a brand type for nominal typing in TypeScript.
 * 
 * Branded types help create distinct types from primitive types, preventing
 * accidental mixing of values that should be semantically different.
 * 
 * @template T - A string literal type that serves as the brand identifier
 * 
 * @example
 * ```typescript
 * // Create a branded ID type
 * type ID = string & Brand<"ID">;
 * 
 * // Create functions that work with branded types
 * function createID(value: string): ID {
 *   return value as ID;
 * }
 * 
 * function processID(id: ID): void {
 *   console.log(`Processing ID: ${id}`);
 * }
 * 
 * // Usage
 * const userID = createID("user-123");
 * const productID = createID("product-456");
 * 
 * processID(userID); // ✅ Works
 * processID("raw-string"); // ❌ TypeScript error - string is not assignable to ID
 * ```
 */
export type Brand<T extends string> = { [brand]: T };
