/**
 * One principal's ledger of one database's generations, in a Durable Object.
 *
 * It exists because a Durable Object namespace cannot be enumerated. There is
 * `idFromName` and there is `get`, and there is nothing that lists what a
 * namespace holds, so "which generations exist" has no answer unless something
 * durable writes the set down. That is the whole reason for a second object;
 * everything below is about how it stays true under a crash.
 *
 * A generation exists if and only if its row is here (ADR-0293). That sentence
 * is the whole design: the state is stored first, in the generation's own
 * authority object, and the row is written last, so a crash between them leaves
 * an object nothing addresses rather than a generation somebody can open and
 * find half-written. There is no publication step, no completeness marker, and
 * no application-document-written-last convention; those were artifacts of a
 * multi-request upload where no single party saw the whole thing.
 *
 * The ledger holds numbers and nothing else. It never sees a byte of anyone's
 * data: the state goes straight to the authority object, and what comes back
 * here is a number that landed. That keeps the "the authority reads nothing"
 * rule (ADR-0298) true of the collection as well as of each log.
 *
 * Deletion is not here. ADR-0283's tombstone-sever-sweep is a real decision and
 * an unbuilt one; a generation is never removed today, which is the safe half
 * to be missing.
 */
import { DurableObject } from 'cloudflare:workers';

type LedgerRow = { generation: number };

export class GenerationsLedger extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		// One relation, two states. `admitted` is the whole of existence: a row
		// with it unset is a number that was handed out and whose import never
		// finished, which is a gap rather than a generation. Keeping the
		// allocation as a row is what makes "never reused" durable without a
		// second place to remember it.
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS _generations (
				generation INTEGER NOT NULL,
				admitted   INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (generation)
			)
		`);
	}

	/**
	 * Take the next number, durably, before anything is stored under it.
	 *
	 * Monotonic and never reused, including across a failed import: an
	 * abandoned reservation stays in the table unadmitted, so the next
	 * allocation steps past it rather than handing two imports one number.
	 */
	allocate(): number {
		const rows = [
			...this.ctx.storage.sql.exec<{ next: number | null }>(
				'SELECT MAX(generation) AS next FROM _generations',
			),
		];
		const generation = (rows[0]?.next ?? 0) + 1;
		this.ctx.storage.sql.exec(
			'INSERT INTO _generations (generation, admitted) VALUES (?, 0)',
			generation,
		);
		return generation;
	}

	/** The last write of an import: this generation now exists. */
	admit(generation: number): void {
		this.ctx.storage.sql.exec(
			'UPDATE _generations SET admitted = 1 WHERE generation = ?',
			generation,
		);
	}

	/** Whether this generation exists, which is the bootstrap GET's whole gate. */
	holds(generation: number): boolean {
		return (
			[
				...this.ctx.storage.sql.exec<LedgerRow>(
					'SELECT generation FROM _generations WHERE generation = ? AND admitted = 1',
					generation,
				),
			].length > 0
		);
	}

	/** Every generation that exists, ascending. The browse list. */
	list(): number[] {
		return [
			...this.ctx.storage.sql.exec<LedgerRow>(
				'SELECT generation FROM _generations WHERE admitted = 1 ORDER BY generation',
			),
		].map((row) => row.generation);
	}
}
