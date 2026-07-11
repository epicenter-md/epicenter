/**
 * `@epicenter/matter-core`: Matter's engine, with no UI, Tauri, or browser coupling.
 *
 * It parses a folder of typed markdown (one `.md` file per row, YAML frontmatter typed by a per-folder
 * `matter.json`, the body as the rich field), classifies each row's conformance, resolves cross-table
 * references, and projects the whole vault into a read-only SQLite schema. Disk is the source of truth;
 * the SQLite projection is disposable and never written back to (ADR-0026, ADR-0065).
 *
 * Two consumers share it: `apps/matter` renders from it, and `epicenter matter check` lints from it.
 * This entry is browser-pure. The filesystem boundary (`loadPath`, `loadTable`) uses `node:fs`, so it
 * lives behind the `@epicenter/matter-core/fs` subpath, kept out of this barrel so the Tauri client's
 * import graph never reaches `node:fs`.
 */

// Conformance: classify a row's cells against the contract (ok / missing / invalid / extra).
export {
	type Cell,
	classifyRow,
	classifyRows,
	type Extra,
	type InvalidCell,
	isMissing,
	type MissingCell,
	type OkCell,
	type RowConformance,
} from './core/conformance';
// Contract: the per-folder `matter.json` model.
export {
	type Contract,
	ContractError,
	type ContractField,
	type ParsedContract,
	parseContract,
	validateContract,
} from './core/contract';
// Expected: the expected-value description for an invalid cell (used at the JSON/report edge).
export {
	describeExpected,
	type ExpectedValue,
	formatExpected,
} from './core/expected';
// Integrity: assess a whole vault, resolving references across tables.
export {
	type AssessedCell,
	assess,
	type LocatedUnreadableFile,
	type ReferenceVerdict,
	type RowAssessment,
	type TableAssessment,
	type TableInput,
	type VaultIntegrity,
} from './core/integrity';
// Parse: a `.md` file into frontmatter + body, and its stem (the reference identity).
export {
	MatterParseError,
	type ParsedFile,
	parseEntry,
	parseMarkdown,
	type Row,
	stemOf,
} from './core/parse';
// Path: the folder label.
export { basename } from './core/path';
// Query: build the read-only SELECT the grid (and headless query verbs) run over a folder's mirror.
export { buildStemQuery, type Sort, type StemQuery } from './core/query';
// Serialize: write an edited frontmatter field or body back to a `.md` file's text.
export { editBody, editField, serializeEntry } from './core/serialize';
// SQLite: project a typed folder's classified rows into a read-only schema + insert.
export {
	buildCreateTable,
	projectToSqlite,
	type SqliteProjection,
	type SqlValue,
} from './core/sqlite';
// Table: read one folder into a typed/untyped view, and load its contract.
export {
	buildView,
	loadContract,
	MatterReadError,
	readTable,
	type TableEntry,
	type TableRead,
	type TypedView,
	type UnreadableFile,
	type UntypedView,
} from './core/table';
// View: declared editable views (board only today; the family grows one renderer at a
// time, ADR-0101), parsed onto the contract (`Contract.views` / `Contract.viewErrors`
// is the one way in), plus the pure grouping logic behind them. A view's default query
// is the grid's own `StemQuery`.
export {
	type BoardBucket,
	groupRowsByField,
	type ViewError,
	type ViewSpec,
} from './core/view';
// Violations: project an assessment into a flat findings list and a roll-up summary.
export {
	type ExtraNote,
	type FieldSummary,
	type Summary,
	summarize,
	type TableSummary,
	toViolations,
	type Violation,
} from './core/violations';
// Report: render an assessment into human text and a process exit code.
export { exitCodeFor } from './report/exit-code';
export { formatReport } from './report/format';
