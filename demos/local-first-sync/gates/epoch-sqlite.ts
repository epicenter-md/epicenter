import { Database } from 'bun:sqlite';
import type {
	BeginTransition,
	BuildTransitionResult,
	EpochAuthority,
	EpochAuthorityDump,
	EpochPushResult,
	EpochTransform,
	IncarnationStatus,
	TransitionResult,
} from './epoch-protocol';
import type { Cells, Operation, PushRequest, SnapshotRow } from './protocol';

const CREATE_CONFLICT = 'create-conflict push refusal';

export class SqliteEpochAuthority implements EpochAuthority {
	readonly db: Database;

	constructor(
		path: string,
		initial: { id: string; epochId: string; rows: SnapshotRow[] },
	) {
		this.db = new Database(path, { create: true });
		this.db.run('PRAGMA journal_mode = WAL');
		this.db.run(`
			CREATE TABLE IF NOT EXISTS family (id INTEGER PRIMARY KEY CHECK(id=1), active_incarnation_id TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS incarnations (id TEXT PRIMARY KEY, epoch_id TEXT NOT NULL, status TEXT NOT NULL, head INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS epoch_rows (incarnation_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, cells_json TEXT NOT NULL, PRIMARY KEY(incarnation_id, table_name, row_id));
			CREATE TABLE IF NOT EXISTS epoch_actors (incarnation_id TEXT NOT NULL, actor_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(incarnation_id, actor_id));
			CREATE TABLE IF NOT EXISTS epoch_transition (id INTEGER PRIMARY KEY CHECK(id=1), lease_id TEXT NOT NULL, source_incarnation_id TEXT NOT NULL, target_incarnation_id TEXT NOT NULL, expires_at INTEGER NOT NULL, next_row_index INTEGER NOT NULL, total_rows INTEGER NOT NULL, transform_json TEXT NOT NULL);
		`);
		if (!this.db.query<{ one: number }, []>('SELECT 1 one FROM family').get()) {
			this.db
				.transaction(() => {
					this.db.run('INSERT INTO family VALUES (1, ?)', [initial.id]);
					this.db.run('INSERT INTO incarnations VALUES (?, ?, ?, 0)', [
						initial.id,
						initial.epochId,
						'active',
					]);
					this.writeRows(initial.id, initial.rows);
				})
				.immediate();
		}
	}

	close(): void {
		this.db.close();
	}

	push(request: PushRequest): EpochPushResult {
		let result: EpochPushResult = { ok: true };
		const transaction = this.db.transaction(() => {
			const active = this.active();
			if (request.protocolMajor !== 1) {
				result = { ok: false, reason: 'protocol-mismatch' };
				return;
			}
			if (request.schemaEpochId !== active.epoch_id) {
				result = { ok: false, reason: 'schema-epoch-mismatch' };
				return;
			}
			if (request.databaseIncarnationId !== active.id) {
				result = { ok: false, reason: 'database-incarnation-mismatch' };
				return;
			}
			if (active.status === 'frozen') {
				result = { ok: false, reason: 'transition-frozen' };
				return;
			}
			for (const mutation of request.mutations) {
				const highWater =
					this.db
						.query<{ sequence: number }, [string, string]>(
							'SELECT sequence FROM epoch_actors WHERE incarnation_id = ? AND actor_id = ?',
						)
						.get(active.id, mutation.actorId)?.sequence ?? 0;
				if (mutation.actorSequence <= highWater) continue;
				if (mutation.actorSequence !== highWater + 1) {
					result = { ok: false, reason: 'actor-sequence-gap' };
					return;
				}
				for (const operation of mutation.operations)
					this.apply(active.id, operation);
				this.db.run(
					'INSERT INTO epoch_actors VALUES (?, ?, ?) ON CONFLICT(incarnation_id, actor_id) DO UPDATE SET sequence = excluded.sequence',
					[active.id, mutation.actorId, mutation.actorSequence],
				);
				this.db.run('UPDATE incarnations SET head = head + 1 WHERE id = ?', [
					active.id,
				]);
			}
		});
		try {
			transaction.immediate();
		} catch (error) {
			// A live-identity createRow aborts the whole push transaction.
			if (error instanceof Error && error.message === CREATE_CONFLICT)
				return { ok: false, reason: 'create-conflict' };
			throw error;
		}
		return result;
	}

	beginTransition(request: BeginTransition): TransitionResult {
		let result: TransitionResult = { ok: true };
		this.db
			.transaction(() => {
				if (this.transition()) {
					result = { ok: false, reason: 'transition-in-progress' };
					return;
				}
				if (
					this.db
						.query<{ one: number }, [string]>(
							'SELECT 1 one FROM incarnations WHERE id = ?',
						)
						.get(request.targetIncarnationId)
				) {
					result = { ok: false, reason: 'target-incarnation-exists' };
					return;
				}
				const source = this.active();
				if (
					request.transform.fromEpochId !== source.epoch_id ||
					request.transform.toEpochId.length === 0 ||
					request.transform.toEpochId === source.epoch_id
				) {
					result = { ok: false, reason: 'epoch-mismatch' };
					return;
				}
				const sourceRows = this.readRows(source.id);
				const preflight = transformRows(sourceRows, request.transform);
				if (!preflight.result.ok) {
					result = preflight.result;
					return;
				}
				this.db.run("UPDATE incarnations SET status = 'frozen' WHERE id = ?", [
					source.id,
				]);
				this.db.run('INSERT INTO incarnations VALUES (?, ?, ?, 0)', [
					request.targetIncarnationId,
					request.transform.toEpochId,
					'preparing',
				]);
				this.db.run(
					'INSERT INTO epoch_transition VALUES (1, ?, ?, ?, ?, 0, ?, ?)',
					[
						request.leaseId,
						source.id,
						request.targetIncarnationId,
						request.expiresAt,
						sourceRows.length,
						JSON.stringify(request.transform),
					],
				);
			})
			.immediate();
		return result;
	}

	buildTransition(
		leaseId: string,
		batchSize: number,
		now: number,
	): BuildTransitionResult {
		if (!Number.isSafeInteger(batchSize) || batchSize < 1)
			throw new Error('batchSize must be a positive integer');
		let result: BuildTransitionResult = { ok: true, complete: false };
		this.db
			.transaction(() => {
				const transition = this.transition();
				if (!transition) {
					result = { ok: false, reason: 'no-transition' };
					return;
				}
				if (transition.lease_id !== leaseId) {
					result = { ok: false, reason: 'wrong-lease' };
					return;
				}
				if (now >= transition.expires_at) {
					result = { ok: false, reason: 'lease-expired' };
					return;
				}
				const rows = this.readRows(transition.source_incarnation_id).slice(
					transition.next_row_index,
					transition.next_row_index + batchSize,
				);
				const transform = JSON.parse(
					transition.transform_json,
				) as EpochTransform;
				const transformed = transformRows(rows, transform);
				if (!transformed.result.ok)
					throw new Error(
						`preflight/build disagreement: ${transformed.result.reason}`,
					);
				this.writeRows(transition.target_incarnation_id, transformed.rows);
				const next = transition.next_row_index + rows.length;
				this.db.run(
					'UPDATE epoch_transition SET next_row_index = ? WHERE id = 1',
					[next],
				);
				result = { ok: true, complete: next === transition.total_rows };
			})
			.immediate();
		return result;
	}

	activate(leaseId: string, now: number): TransitionResult {
		let result: TransitionResult = { ok: true };
		this.db
			.transaction(() => {
				const transition = this.transition();
				if (!transition) {
					result = { ok: false, reason: 'no-transition' };
					return;
				}
				if (transition.lease_id !== leaseId) {
					result = { ok: false, reason: 'wrong-lease' };
					return;
				}
				if (now >= transition.expires_at) {
					result = { ok: false, reason: 'lease-expired' };
					return;
				}
				if (transition.next_row_index !== transition.total_rows) {
					result = { ok: false, reason: 'baseline-incomplete' };
					return;
				}
				this.db.run(
					"UPDATE incarnations SET status = 'superseded' WHERE id = ?",
					[transition.source_incarnation_id],
				);
				this.db.run("UPDATE incarnations SET status = 'active' WHERE id = ?", [
					transition.target_incarnation_id,
				]);
				this.db.run(
					'UPDATE family SET active_incarnation_id = ? WHERE id = 1',
					[transition.target_incarnation_id],
				);
				this.db.run('DELETE FROM epoch_transition');
			})
			.immediate();
		return result;
	}

	expire(now: number): TransitionResult {
		let result: TransitionResult = { ok: true };
		this.db
			.transaction(() => {
				const transition = this.transition();
				if (!transition) {
					result = { ok: false, reason: 'no-transition' };
					return;
				}
				if (now < transition.expires_at) {
					result = { ok: false, reason: 'lease-not-expired' };
					return;
				}
				this.db.run("UPDATE incarnations SET status = 'active' WHERE id = ?", [
					transition.source_incarnation_id,
				]);
				this.db.run('DELETE FROM epoch_rows WHERE incarnation_id = ?', [
					transition.target_incarnation_id,
				]);
				this.db.run('DELETE FROM epoch_actors WHERE incarnation_id = ?', [
					transition.target_incarnation_id,
				]);
				this.db.run('DELETE FROM incarnations WHERE id = ?', [
					transition.target_incarnation_id,
				]);
				this.db.run('DELETE FROM epoch_transition');
			})
			.immediate();
		return result;
	}

	dump(): EpochAuthorityDump {
		const activeIncarnationId = this.db
			.query<{ active_incarnation_id: string }, []>(
				'SELECT active_incarnation_id FROM family WHERE id = 1',
			)
			.get()?.active_incarnation_id;
		if (!activeIncarnationId) throw new Error('family state missing');
		const incarnations = this.db
			.query<
				{
					id: string;
					epoch_id: string;
					status: IncarnationStatus;
					head: number;
				},
				[]
			>('SELECT * FROM incarnations ORDER BY id')
			.all()
			.map((incarnation) => ({
				id: incarnation.id,
				epochId: incarnation.epoch_id,
				status: incarnation.status,
				head: incarnation.head,
				rows: this.readRows(incarnation.id),
				actorHighWater: Object.fromEntries(
					this.db
						.query<{ actor_id: string; sequence: number }, [string]>(
							'SELECT actor_id, sequence FROM epoch_actors WHERE incarnation_id = ? ORDER BY actor_id',
						)
						.all(incarnation.id)
						.map((row) => [row.actor_id, row.sequence]),
				),
			}));
		const transition = this.transition();
		return {
			activeIncarnationId,
			incarnations,
			transition: transition
				? {
						leaseId: transition.lease_id,
						sourceIncarnationId: transition.source_incarnation_id,
						targetIncarnationId: transition.target_incarnation_id,
						expiresAt: transition.expires_at,
						nextRowIndex: transition.next_row_index,
						totalRows: transition.total_rows,
					}
				: null,
		};
	}

	private active() {
		const row = this.db
			.query<{ id: string; epoch_id: string; status: IncarnationStatus }, []>(
				'SELECT incarnations.id, epoch_id, status FROM family JOIN incarnations ON incarnations.id = family.active_incarnation_id WHERE family.id = 1',
			)
			.get();
		if (!row) throw new Error('active incarnation missing');
		return row;
	}

	private transition() {
		return this.db
			.query<
				{
					lease_id: string;
					source_incarnation_id: string;
					target_incarnation_id: string;
					expires_at: number;
					next_row_index: number;
					total_rows: number;
					transform_json: string;
				},
				[]
			>('SELECT * FROM epoch_transition WHERE id = 1')
			.get();
	}

	private readRows(incarnationId: string): SnapshotRow[] {
		return this.db
			.query<
				{ table_name: string; row_id: string; cells_json: string },
				[string]
			>(
				'SELECT table_name, row_id, cells_json FROM epoch_rows WHERE incarnation_id = ? ORDER BY table_name, row_id',
			)
			.all(incarnationId)
			.map((row) => ({
				table: row.table_name,
				rowId: row.row_id,
				cells: JSON.parse(row.cells_json),
			}));
	}

	private writeRows(incarnationId: string, rows: SnapshotRow[]): void {
		for (const row of rows)
			this.db.run('INSERT INTO epoch_rows VALUES (?, ?, ?, ?)', [
				incarnationId,
				row.table,
				row.rowId,
				JSON.stringify(row.cells),
			]);
	}

	private apply(incarnationId: string, operation: Operation): void {
		if (operation.kind === 'deleteRow') {
			this.db.run(
				'DELETE FROM epoch_rows WHERE incarnation_id = ? AND table_name = ? AND row_id = ?',
				[incarnationId, operation.table, operation.rowId],
			);
			return;
		}
		const stored = this.db
			.query<{ cells_json: string }, [string, string, string]>(
				'SELECT cells_json FROM epoch_rows WHERE incarnation_id = ? AND table_name = ? AND row_id = ?',
			)
			.get(incarnationId, operation.table, operation.rowId);
		if (operation.kind === 'createRow') {
			if (stored) throw new Error(CREATE_CONFLICT);
			const cells: Cells = {};
			for (const [field, value] of Object.entries(operation.cells))
				if (value !== null) cells[field] = value;
			this.db.run('INSERT INTO epoch_rows VALUES (?, ?, ?, ?)', [
				incarnationId,
				operation.table,
				operation.rowId,
				JSON.stringify(cells),
			]);
			return;
		}
		if (!stored) return;
		const cells: Cells = JSON.parse(stored.cells_json);
		for (const [field, value] of Object.entries(operation.cells)) {
			if (value === null) delete cells[field];
			else cells[field] = value;
		}
		this.db.run(
			'UPDATE epoch_rows SET cells_json = ? WHERE incarnation_id = ? AND table_name = ? AND row_id = ?',
			[JSON.stringify(cells), incarnationId, operation.table, operation.rowId],
		);
	}
}

/** Independent transform copy: the SQLite authority shares no planner code. */
function transformRows(
	rows: SnapshotRow[],
	transform: EpochTransform,
): { result: TransitionResult; rows: SnapshotRow[] } {
	const rules = new Map(
		transform.tables.map((rule) => [rule.sourceTable, rule]),
	);
	const output: SnapshotRow[] = [];
	const identities = new Set<string>();
	for (const row of rows) {
		const rule = rules.get(row.table);
		if (!rule)
			return {
				result: { ok: false, reason: 'missing-table-transform' },
				rows: [],
			};
		if (rule.destinations.length > 1)
			return {
				result: { ok: false, reason: 'one-to-many-identity' },
				rows: [],
			};
		const destination = rule.destinations[0];
		if (!destination) continue;
		const rowId =
			destination.rowId === 'preserve' ? row.rowId : destination.rowId.constant;
		const key = JSON.stringify([destination.table, rowId]);
		if (identities.has(key))
			return {
				result: { ok: false, reason: 'many-to-one-identity' },
				rows: [],
			};
		identities.add(key);
		const cells: Cells = { ...rule.defaults };
		for (const [field, value] of Object.entries(row.cells)) {
			const target = Object.hasOwn(rule.fields, field)
				? rule.fields[field]
				: field;
			if (target !== null) cells[target] = value;
		}
		output.push({ table: destination.table, rowId, cells });
	}
	return {
		result: { ok: true },
		rows: output.sort((left, right) =>
			JSON.stringify([left.table, left.rowId]).localeCompare(
				JSON.stringify([right.table, right.rowId]),
			),
		),
	};
}
