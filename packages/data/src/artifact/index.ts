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
 * workspace's contents. Writing the files out and reading them back in is the
 * caller's, because that is a filesystem the host owns and nothing here does.
 *
 * The files land in `~/Epicenter`, written continuously by the mirror
 * (ADR-0271). Reading them back is restore, which points at any folder and
 * takes its destination as an argument (ADR-0272).
 */
export type { DocumentFile, ExportError } from './documents.js';
export { exportWorkspace, type WorkspaceData } from './export.js';
export { frontmatter, parseRowFile, type ParsedRowFile, rowFile } from './frontmatter.js';
export { type ImportError, readArtifact } from './import.js';
