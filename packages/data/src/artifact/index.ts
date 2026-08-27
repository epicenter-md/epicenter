/**
 * The workspace artifact: the legible folder a person keeps, in both
 * directions (ADR-0267, ADR-0268).
 *
 * ```txt
 * kv.json              the kv root's stored values
 * <table>/<rowId>.md   one file per row: raw fields as frontmatter, and the
 *                      document through the table's codec as the body
 * ```
 *
 * Both directions are composed on the public surface and neither is a store
 * verb: `exportWorkspace` turns an opened workspace into files, and
 * `readArtifact` turns files back into the one envelope that replaces a
 * workspace's contents. Where the bytes land in between, a ZIP, a directory,
 * a network round trip, is the caller's, because that differs by host and
 * nothing here does.
 */
export type { DocumentFile, ExportError } from './documents.js';
export { exportWorkspace, type WorkspaceData } from './export.js';
export { frontmatter, parseRowFile, type ParsedRowFile, rowFile } from './frontmatter.js';
export { type ImportError, readArtifact } from './import.js';
