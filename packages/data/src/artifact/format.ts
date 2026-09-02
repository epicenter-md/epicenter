/**
 * The row-file format, as pure functions (ADR-0268).
 *
 * Two inverse pairs and nothing else: `rowPath`/`parseRowPath` for where a
 * row's file lives, and `rowFile`/`parseRowFile` for what is in it. No store,
 * no CRDT, no definition, no I/O.
 *
 * Its own entry point because of who needs it. Reading a folder is not the same
 * job as holding a store: the desktop host writes these files and indexes
 * them, and it has no business loading a CRDT to parse a string. Reaching
 * through `@epicenter/data/artifact` would drag `@y/y` in behind
 * `readArtifact`, which is how a boundary becomes incidental rather than
 * structural.
 */
export {
	frontmatter,
	type ParsedRowFile,
	parseRowFile,
	rowFile,
} from './frontmatter.js';
export { parseRowPath, ROW_FILE_EXTENSION, rowPath } from './layout.js';
