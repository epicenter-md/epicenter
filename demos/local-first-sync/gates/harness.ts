import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteClientA } from './engine-client-a';
import { SqliteClientB } from './engine-client-b';
import { SqliteServer } from './engine-server';
import {
	ENVELOPE,
	type Operation,
	type PullResponse,
	type SnapshotChunk,
	type SnapshotInstallResult,
	type SnapshotManifest,
} from './protocol';
import { RefClient, RefServer } from './reference';
import { stableJson } from './util';

type Replica = {
	ref: RefClient;
	a: SqliteClientA;
	b: SqliteClientB;
	generation: number;
};
export type Event =
	| { kind: 'local'; replica: number; operations: Operation[] }
	| { kind: 'push'; replica: number; acceptLimit?: number }
	| { kind: 'pull'; replica: number; limit?: number }
	| { kind: 'duplicatePull'; replica: number }
	| { kind: 'reopen'; replica: number };

function equal(actual: unknown, expected: unknown, label: string): void {
	const left = stableJson(actual);
	const right = stableJson(expected);
	if (left !== right)
		throw new Error(`${label}\nexpected ${right}\nactual   ${left}`);
}

export class GateHarness {
	readonly directory = mkdtempSync(join(tmpdir(), 'epicenter-gate1-'));
	readonly refServer = new RefServer();
	sqlServer = new SqliteServer(join(this.directory, 'server.sqlite'));
	readonly replicas: Replica[];
	private readonly lastPull = new Map<number, PullResponse>();

	constructor(count = 3) {
		this.replicas = Array.from({ length: count }, (_, index) =>
			this.openReplica(index, `actor-${index + 1}`, 1),
		);
		this.compareAll('initial');
	}

	private openReplica(
		index: number,
		actorId: string,
		generation: number,
	): Replica {
		return {
			ref: new RefClient(actorId),
			a: new SqliteClientA(join(this.directory, `a-${index}.sqlite`), actorId),
			b: new SqliteClientB(join(this.directory, `b-${index}.sqlite`), actorId),
			generation,
		};
	}

	local(replica: number, operations: Operation[]): void {
		const target = this.replicas[replica];
		target.ref.local(operations);
		target.a.local(operations);
		target.b.local(operations);
		this.compareAll(`local(${replica})`);
	}

	push(replica: number, acceptLimit?: number): void {
		const target = this.replicas[replica];
		equal(target.a.pushRequest(), target.ref.pushRequest(), 'A push request');
		equal(target.b.pushRequest(), target.ref.pushRequest(), 'B push request');
		const expected = this.refServer.push(target.ref.pushRequest(), acceptLimit);
		const actual = this.sqlServer.push(target.a.pushRequest(), acceptLimit);
		equal(actual, expected, 'server push response');
		this.compareAll(`push(${replica})`);
	}

	pull(replica: number, limit = 100): PullResponse {
		const target = this.replicas[replica];
		equal(
			target.a.pullRequest(limit),
			target.ref.pullRequest(limit),
			'A pull request',
		);
		equal(
			target.b.pullRequest(limit),
			target.ref.pullRequest(limit),
			'B pull request',
		);
		const expected = this.refServer.pull(target.ref.pullRequest(limit));
		const actual = this.sqlServer.pull(target.a.pullRequest(limit));
		equal(actual, expected, 'server pull response');
		if (actual.ok && actual.snapshotRequired) return actual;
		const applied = target.ref.applyPull(expected);
		equal(target.a.applyPull(actual), applied, 'A pull application');
		equal(target.b.applyPull(actual), applied, 'B pull application');
		this.lastPull.set(replica, structuredClone(actual));
		this.compareAll(`pull(${replica})`);
		return actual;
	}

	duplicatePull(replica: number): void {
		const response = this.lastPull.get(replica);
		if (!response) return;
		const target = this.replicas[replica];
		const expected = target.ref.applyPull(response);
		equal(target.a.applyPull(response), expected, 'A duplicate pull');
		equal(target.b.applyPull(response), expected, 'B duplicate pull');
		this.compareAll(`duplicatePull(${replica})`);
	}

	reopen(replica: number): void {
		const target = this.replicas[replica];
		target.a.close();
		target.b.close();
		target.a = new SqliteClientA(
			join(this.directory, `a-${replica}.sqlite`),
			target.ref.actorId,
		);
		target.b = new SqliteClientB(
			join(this.directory, `b-${replica}.sqlite`),
			target.ref.actorId,
		);
		target.generation += 1;
		this.compareAll(`reopen(${replica})`);
	}

	/** A response belongs to the session generation that issued it. */
	applyCaptured(
		replica: number,
		generation: number,
		response: PullResponse,
	): boolean {
		const target = this.replicas[replica];
		if (target.generation !== generation) return false;
		const expected = target.ref.applyPull(response);
		equal(target.a.applyPull(response), expected, 'captured A pull');
		equal(target.b.applyPull(response), expected, 'captured B pull');
		this.compareAll('captured pull');
		return expected;
	}

	crashLocalBeforeCommit(replica: number, operations: Operation[]): void {
		const target = this.replicas[replica];
		for (const client of [target.a, target.b]) {
			try {
				client.local(operations, true);
			} catch (error) {
				if (
					!(error instanceof Error && error.message === 'injected local crash')
				)
					throw error;
			}
		}
		this.reopen(replica);
	}

	crashDuringPull(replica: number, response: PullResponse): void {
		const target = this.replicas[replica];
		for (const client of [target.a, target.b]) {
			try {
				client.applyPull(response, 1);
			} catch (error) {
				if (
					!(error instanceof Error && error.message === 'injected pull crash')
				)
					throw error;
			}
		}
		this.reopen(replica);
	}

	crashServerDuringPush(replica: number, failAfterOperation: number): void {
		try {
			this.sqlServer.push(
				this.replicas[replica].a.pushRequest(),
				Number.POSITIVE_INFINITY,
				failAfterOperation,
			);
		} catch (error) {
			if (
				!(error instanceof Error && error.message === 'injected server crash')
			)
				throw error;
		}
		this.sqlServer.close();
		this.sqlServer = new SqliteServer(join(this.directory, 'server.sqlite'));
		this.compareAll('server crash during mutation');
	}

	publishSnapshot(rowsPerChunk: number): SnapshotManifest {
		const expected = this.refServer.publishSnapshot(rowsPerChunk);
		const actual = this.sqlServer.publishSnapshot(rowsPerChunk);
		equal(actual, expected, 'snapshot manifest');
		this.compareAll('publishSnapshot');
		return actual;
	}

	crashDuringSnapshotPublication(rowsPerChunk: number): void {
		try {
			this.sqlServer.publishSnapshot(rowsPerChunk, true);
		} catch (error) {
			if (
				!(
					error instanceof Error &&
					error.message === 'injected snapshot publication crash'
				)
			)
				throw error;
		}
		this.sqlServer.close();
		this.sqlServer = new SqliteServer(join(this.directory, 'server.sqlite'));
		this.compareAll('server crash during snapshot publication');
	}

	snapshotRequired(replica: number): SnapshotManifest {
		const target = this.replicas[replica];
		const expected = this.refServer.pull(target.ref.pullRequest());
		const actual = this.sqlServer.pull(target.a.pullRequest());
		equal(actual, expected, 'snapshot-required response');
		if (!actual.ok || !actual.snapshotRequired)
			throw new Error('expected snapshot-required response');
		return actual.manifest;
	}

	snapshotChunk(manifest: SnapshotManifest, index: number): SnapshotChunk {
		const request = {
			kind: 'snapshotChunk' as const,
			...ENVELOPE,
			generation: manifest.generation,
			index,
		};
		const expected = this.refServer.snapshotChunk(request);
		const actual = this.sqlServer.snapshotChunk(request);
		equal(actual, expected, `snapshot chunk ${index}`);
		if (!actual.ok)
			throw new Error(`snapshot chunk unavailable: ${actual.reason}`);
		return actual.chunk;
	}

	beginSnapshot(
		replica: number,
		manifest: SnapshotManifest,
	): SnapshotInstallResult {
		const target = this.replicas[replica];
		const expected = target.ref.beginSnapshot(manifest);
		equal(target.a.beginSnapshot(manifest), expected, 'A begin snapshot');
		equal(target.b.beginSnapshot(manifest), expected, 'B begin snapshot');
		this.compareAll('beginSnapshot');
		return expected;
	}

	stageSnapshotChunk(
		replica: number,
		chunk: SnapshotChunk,
	): SnapshotInstallResult {
		const target = this.replicas[replica];
		const expected = target.ref.stageSnapshotChunk(chunk);
		equal(
			target.a.stageSnapshotChunk(chunk),
			expected,
			'A stage snapshot chunk',
		);
		equal(
			target.b.stageSnapshotChunk(chunk),
			expected,
			'B stage snapshot chunk',
		);
		this.compareAll('stageSnapshotChunk');
		return expected;
	}

	installSnapshot(replica: number): SnapshotInstallResult {
		const target = this.replicas[replica];
		const expected = target.ref.installSnapshot();
		equal(target.a.installSnapshot(), expected, 'A install snapshot');
		equal(target.b.installSnapshot(), expected, 'B install snapshot');
		this.compareAll('installSnapshot');
		return expected;
	}

	bootstrapSnapshot(replica: number, manifest: SnapshotManifest): void {
		const begun = this.beginSnapshot(replica, manifest);
		if (!begun.ok) throw new Error(`snapshot begin failed: ${begun.reason}`);
		for (let index = 0; index < manifest.chunkChecksums.length; index += 1) {
			const staged = this.stageSnapshotChunk(
				replica,
				this.snapshotChunk(manifest, index),
			);
			if (!staged.ok)
				throw new Error(`snapshot chunk failed: ${staged.reason}`);
		}
		const installed = this.installSnapshot(replica);
		if (!installed.ok)
			throw new Error(`snapshot install failed: ${installed.reason}`);
	}

	crashDuringSnapshotInstall(replica: number): void {
		const target = this.replicas[replica];
		for (const client of [target.a, target.b]) {
			try {
				client.installSnapshot(true);
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						error.message === 'injected snapshot install crash'
					)
				)
					throw error;
			}
		}
		this.reopen(replica);
	}

	drain(): void {
		for (let pass = 0; pass < 100; pass += 1) {
			for (let index = 0; index < this.replicas.length; index += 1)
				this.push(index);
			for (let index = 0; index < this.replicas.length; index += 1) {
				const response = this.pull(index, 2);
				if (response.ok && response.snapshotRequired)
					this.bootstrapSnapshot(index, response.manifest);
			}
			if (
				this.replicas.every(({ ref }) => ref.dump().outbox.length === 0) &&
				this.replicas.every(
					({ ref }) =>
						ref.dump().pullCursor === this.refServer.dump().serverSequence,
				)
			)
				return;
		}
		throw new Error('drain did not converge in 100 passes');
	}

	run(events: readonly Event[]): void {
		for (const event of events) {
			if (event.kind === 'local') this.local(event.replica, event.operations);
			else if (event.kind === 'push')
				this.push(event.replica, event.acceptLimit);
			else if (event.kind === 'pull') this.pull(event.replica, event.limit);
			else if (event.kind === 'duplicatePull')
				this.duplicatePull(event.replica);
			else this.reopen(event.replica);
		}
	}

	compareAll(context: string): void {
		equal(this.sqlServer.dump(), this.refServer.dump(), `${context}: server`);
		for (const [index, replica] of this.replicas.entries()) {
			equal(
				replica.a.dump(),
				replica.ref.dump(),
				`${context}: candidate A replica ${index}`,
			);
			equal(
				replica.b.dump(),
				replica.ref.dump(),
				`${context}: candidate B replica ${index}`,
			);
		}
	}

	close(): void {
		for (const replica of this.replicas) {
			replica.a.close();
			replica.b.close();
		}
		this.sqlServer.close();
		rmSync(this.directory, { recursive: true, force: true });
	}
}

/** Delta-debug a failing concrete schedule for useful counterexamples. */
export function minimize(
	events: Event[],
	fails: (candidate: Event[]) => boolean,
): Event[] {
	let result = [...events];
	let width = Math.ceil(result.length / 2);
	while (width > 0) {
		let reduced = false;
		for (let start = 0; start < result.length; start += width) {
			const candidate = [
				...result.slice(0, start),
				...result.slice(start + width),
			];
			if (candidate.length > 0 && fails(candidate)) {
				result = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) width = Math.floor(width / 2);
	}
	return result;
}
