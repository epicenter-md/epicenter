/**
 * The one runtime global this package touches, declared rather than imported.
 *
 * Address admission measures names in UTF-8 bytes, which needs `TextEncoder`.
 * It exists in every runtime this package targets (browsers, Bun, Node, and
 * Workers all have it on the global), but it is not in `lib: ESNext`: it lives
 * in `lib.dom` and in `@types/node`. Taking either would be wrong for a package
 * whose whole claim is that it is inert vocabulary. `lib.dom` would put `window`
 * and `document` in scope for a package that must never reach them, and
 * `@types/node` would put a runtime's type surface into declarations we publish
 * to strangers.
 *
 * Nothing here reaches the emitted declarations: the encoder is internal to one
 * byte-length helper, so a consumer type-checking `dist` never sees this name.
 */
declare class TextEncoder {
	encode(input?: string): Uint8Array;
}
