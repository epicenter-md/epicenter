import type { NonconformingRow } from '@epicenter/data';
import { assertValidTransformationStep } from '../operations/transformation-validation';
import type {
	Transformation,
	TransformationId,
	TransformationStep,
	TransformationStepId,
	WhisperingData,
} from '../workspace';

export type TransformationWithSteps = Transformation & {
	steps: TransformationStep[];
};

type Direction = 'up' | 'down';

type TransformationDiagnostics = {
	transformations: NonconformingRow[];
	steps: NonconformingRow[];
};

/**
 * Ordered deterministic Transformations over the active portable-work document.
 *
 * This domain is the sole writer of both tables. It validates the invariants the
 * declaration cannot express, joins child steps onto their parent, and derives a
 * stable order from position plus row id.
 */
export function createWhisperingTransformations({
	transformationsTable,
	stepsTable,
}: {
	transformationsTable: WhisperingData['tables']['transformations'];
	stepsTable: WhisperingData['tables']['transformationSteps'];
}) {
	let sorted = $state.raw<TransformationWithSteps[]>([]);
	let diagnostics = $state.raw<TransformationDiagnostics>({
		transformations: [],
		steps: [],
	});

	function read(): void {
		const transformations = transformationsTable.list();
		const steps = stepsTable.list();
		const stepsByParent = new Map<string, TransformationStep[]>();
		for (const step of steps.rows) {
			const siblings = stepsByParent.get(step.transformationId) ?? [];
			siblings.push(step);
			stepsByParent.set(step.transformationId, siblings);
		}
		sorted = sortByPosition(transformations.rows).map((transformation) => ({
			...transformation,
			steps: sortByPosition(stepsByParent.get(transformation.id) ?? []),
		}));
		diagnostics = {
			transformations: transformations.nonconforming,
			steps: steps.nonconforming,
		};
	}

	function getTransformation(id: TransformationId): TransformationWithSteps {
		const transformation = sorted.find((candidate) => candidate.id === id);
		if (transformation === undefined) {
			throw new Error(`Transformation '${id}' does not exist.`);
		}
		return transformation;
	}

	function getStep(id: TransformationStepId): TransformationStep {
		for (const transformation of sorted) {
			const step = transformation.steps.find(
				(candidate) => candidate.id === id,
			);
			if (step !== undefined) return step;
		}
		throw new Error(`Transformation step '${id}' does not exist.`);
	}

	function writePositions<TRow extends { id: string }>(
		table: {
			update(
				id: string,
				fields: { position: number },
			): { error: unknown | null };
		},
		rows: TRow[],
	): void {
		rows.forEach((row, position) => {
			const written = table.update(row.id, { position });
			if (written.error !== null) throw written.error;
		});
	}

	function moveInOrder<TRow extends { id: string }>(
		rows: TRow[],
		id: string,
		direction: Direction,
	): TRow[] {
		const from = rows.findIndex((row) => row.id === id);
		if (from === -1) throw new Error(`Ordered row '${id}' does not exist.`);
		const to = direction === 'up' ? from - 1 : from + 1;
		if (to < 0 || to >= rows.length) return rows;
		const reordered = [...rows];
		const current = reordered[from];
		const target = reordered[to];
		if (current === undefined || target === undefined) {
			throw new Error('Cannot move a row outside its ordered collection.');
		}
		reordered[from] = target;
		reordered[to] = current;
		return reordered;
	}

	function addStep(
		transformationId: TransformationId,
		fields:
			| { kind: 'spoken_urls' }
			| {
					kind: 'find_replace';
					find: string;
					replace?: string;
					useRegex?: boolean;
			  },
	): TransformationStep {
		const transformation = getTransformation(transformationId);
		const normalized = normalizeStep(fields);
		assertValidTransformationStep(normalized);
		const written = stepsTable.create({
			transformationId,
			position: nextPosition(transformation.steps),
			...normalized,
		});
		if (written.error !== null) throw written.error;
		return getStep(written.data.id);
	}

	read();
	const stopTransformations = transformationsTable.subscribe(read);
	const stopSteps = stepsTable.subscribe(read);

	return {
		[Symbol.dispose]() {
			stopSteps();
			stopTransformations();
		},
		get sorted(): TransformationWithSteps[] {
			return sorted;
		},
		get count(): number {
			return sorted.length;
		},
		get nonconforming(): TransformationDiagnostics {
			return diagnostics;
		},
		get(id: TransformationId): TransformationWithSteps | undefined {
			return sorted.find((transformation) => transformation.id === id);
		},
		create({
			name,
			description = '',
		}: {
			name: string;
			description?: string;
		}): TransformationWithSteps {
			const written = transformationsTable.create({
				name,
				description,
				enabled: false,
				position: nextPosition(sorted),
			});
			if (written.error !== null) throw written.error;
			return getTransformation(written.data.id);
		},
		update(
			id: TransformationId,
			fields: { name?: string; description?: string },
		): void {
			getTransformation(id);
			const written = transformationsTable.update(id, fields);
			if (written.error !== null) throw written.error;
		},
		setEnabled(id: TransformationId, enabled: boolean): void {
			const transformation = getTransformation(id);
			if (enabled) {
				if (transformation.steps.length === 0) {
					throw new Error(
						'A Transformation needs at least one step before it can be enabled.',
					);
				}
				for (const step of transformation.steps) {
					assertValidTransformationStep(step);
				}
			}
			const written = transformationsTable.update(id, { enabled });
			if (written.error !== null) throw written.error;
		},
		move(id: TransformationId, direction: Direction): void {
			const reordered = moveInOrder(sorted, id, direction);
			writePositions(transformationsTable, reordered);
		},
		delete(id: TransformationId): void {
			const transformation = getTransformation(id);
			for (const step of transformation.steps) stepsTable.delete(step.id);
			transformationsTable.delete(id);
		},
		addStep,
		updateStep(
			id: TransformationStepId,
			fields: Partial<
				Pick<TransformationStep, 'kind' | 'find' | 'replace' | 'useRegex'>
			>,
		): void {
			const current = getStep(id);
			const normalized = normalizeStep({ ...current, ...fields });
			assertValidTransformationStep(normalized);
			const written = stepsTable.update(id, normalized);
			if (written.error !== null) throw written.error;
		},
		duplicateStep(id: TransformationStepId): TransformationStep {
			const step = getStep(id);
			return addStep(
				step.transformationId,
				step.kind === 'spoken_urls'
					? { kind: 'spoken_urls' }
					: {
							kind: 'find_replace',
							find: step.find,
							replace: step.replace,
							useRegex: step.useRegex,
						},
			);
		},
		moveStep(id: TransformationStepId, direction: Direction): void {
			const step = getStep(id);
			const siblings = getTransformation(step.transformationId).steps;
			const reordered = moveInOrder(siblings, id, direction);
			writePositions(stepsTable, reordered);
		},
		deleteStep(id: TransformationStepId): void {
			const step = getStep(id);
			const parent = getTransformation(step.transformationId);
			if (parent.enabled && parent.steps.length === 1) {
				throw new Error(
					'Disable this Transformation before deleting its final step.',
				);
			}
			stepsTable.delete(id);
		},
	};
}

export type WhisperingTransformations = ReturnType<
	typeof createWhisperingTransformations
>;

function sortByPosition<TRow extends { id: string; position: number }>(
	rows: TRow[],
): TRow[] {
	return rows.toSorted(
		(left, right) =>
			left.position - right.position || left.id.localeCompare(right.id),
	);
}

function nextPosition(rows: { position: number }[]): number {
	return rows.reduce((largest, row) => Math.max(largest, row.position), -1) + 1;
}

function normalizeStep(
	step:
		| { kind: 'spoken_urls' }
		| {
				kind: 'find_replace';
				find: string;
				replace?: string;
				useRegex?: boolean;
		  },
): Pick<TransformationStep, 'kind' | 'find' | 'replace' | 'useRegex'> {
	return step.kind === 'spoken_urls'
		? { kind: 'spoken_urls', find: '', replace: '', useRegex: false }
		: {
				kind: 'find_replace',
				find: step.find,
				replace: step.replace ?? '',
				useRegex: step.useRegex ?? false,
			};
}
