/**
 * The store artifact: the legible folder a person keeps, in both
 * directions (ADR-0267, ADR-0268, ADR-0271).
 *
 * ```txt
 * kv.json              the kv root's stored values
 * <table>/<rowId>.md   one file per row: raw fields as frontmatter, and the
 *                      document through the table's codec as the body
 * ```
 *
 * The unit is one row and one file. `renderRow` is what the mirror calls for
 * every row a commit touched; `renderArtifact` is that call in a loop, yielded
 * one file at a time, which the mirror runs at boot. `readArtifact` is the
 * other direction, and it is whole-folder by nature because restore replaces a
 * store rather than patching one.
 *
 * Two pure inverse pairs sit underneath both: `rowPath`/`parseRowPath` for
 * where a row's file lives, and `rowFile`/`parseRowFile` for what is in it.
 *
 * Both directions are composed on the public surface and neither is a store
 * verb. Writing the files out and reading them back in belongs to whoever
 * owns a filesystem, which is the host (ADR-0271): the files land in
 * `~/Epicenter`, written continuously, and reading them back is restore,
 * which points at any folder and takes its destination as an argument
 * (ADR-0272).
 */
export {
	frontmatter,
	type ParsedRowFile,
	parseRowFile,
	rowFile,
} from './frontmatter.js';
export {
	type ArtifactDocument,
	type ImportError,
	readArtifact,
} from './import.js';
export { parseRowPath, rowPath } from './layout.js';
export {
	type RenderableData,
	RenderError,
	type RenderedRow,
	renderArtifact,
	renderRow,
} from './render.js';
