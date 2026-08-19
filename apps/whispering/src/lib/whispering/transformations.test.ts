/**
 * Portable Transformations domain tests.
 *
 * Exercises the real in-memory data stack so ordering, validation, subscriptions,
 * and parent-step ownership are tested at the document boundary.
 *
 * Key behaviors:
 * - Parents and steps append, reorder, and resolve equal positions deterministically
 * - Invalid deterministic steps and empty enablement are refused before writes
 * - Parent deletion cascades while orphan rows remain ignored
 */
import { expect, test } from 'bun:test';

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);

import { openMemory } from '@epicenter/data/bun';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDatabase } from '../workspace';
import { createWhisperingTransformations } from './transformations.svelte';

function setup() {
	const data = openMemory(whisperingDatabase);
	const domain = createWhisperingTransformations({
		transformationsTable: data.tables.transformations,
		stepsTable: data.tables.transformationSteps,
	});
	return { data, domain };
}

test('new Transformations and steps append disabled in stable order', async () => {
	const { data, domain } = setup();
	try {
		const first = domain.create({ name: 'First' });
		const second = domain.create({ name: 'Second', description: 'later' });
		expect(domain.sorted.map(({ id }) => id)).toEqual([first.id, second.id]);
		expect(domain.sorted.map(({ enabled }) => enabled)).toEqual([false, false]);

		const literal = domain.addStep(first.id, {
			kind: 'find_replace',
			find: 'one',
			replace: 'two',
		});
		const urls = domain.addStep(first.id, { kind: 'spoken_urls' });
		expect(domain.get(first.id)?.steps.map(({ id }) => id)).toEqual([
			literal.id,
			urls.id,
		]);
		expect(urls).toMatchObject({
			find: '',
			replace: '',
			useRegex: false,
		});
	} finally {
		domain[Symbol.dispose]();
		await data[Symbol.asyncDispose]();
	}
});

test('validation refuses blank find, invalid regex, and empty enablement', async () => {
	const { data, domain } = setup();
	try {
		const transformation = domain.create({ name: 'Draft' });
		expect(() => domain.setEnabled(transformation.id, true)).toThrow(
			'needs at least one step',
		);
		expect(() =>
			domain.addStep(transformation.id, {
				kind: 'find_replace',
				find: '   ',
			}),
		).toThrow('non-blank find text');
		expect(() =>
			domain.addStep(transformation.id, {
				kind: 'find_replace',
				find: '[',
				useRegex: true,
			}),
		).toThrow('Invalid regular expression');
		expect(data.tables.transformationSteps.list().rows).toEqual([]);

		const onlyStep = domain.addStep(transformation.id, {
			kind: 'spoken_urls',
		});
		domain.setEnabled(transformation.id, true);
		expect(domain.get(transformation.id)?.enabled).toBe(true);
		expect(() => domain.deleteStep(onlyStep.id)).toThrow(
			'Disable this Transformation',
		);
		domain.setEnabled(transformation.id, false);
		domain.deleteStep(onlyStep.id);
		expect(domain.get(transformation.id)?.steps).toEqual([]);
	} finally {
		domain[Symbol.dispose]();
		await data[Symbol.asyncDispose]();
	}
});

test('explicit parent and step moves compact positions', async () => {
	const { data, domain } = setup();
	try {
		const first = domain.create({ name: 'First' });
		domain.create({ name: 'Second' });
		const third = domain.create({ name: 'Third' });
		domain.move(third.id, 'up');
		expect(domain.sorted.map(({ name, position }) => [name, position])).toEqual(
			[
				['First', 0],
				['Third', 1],
				['Second', 2],
			],
		);

		const one = domain.addStep(first.id, {
			kind: 'find_replace',
			find: 'one',
		});
		domain.addStep(first.id, {
			kind: 'find_replace',
			find: 'two',
		});
		const duplicate = domain.duplicateStep(one.id);
		domain.moveStep(duplicate.id, 'up');
		expect(
			domain.get(first.id)?.steps.map(({ find, position }) => [find, position]),
		).toEqual([
			['one', 0],
			['one', 1],
			['two', 2],
		]);
	} finally {
		domain[Symbol.dispose]();
		await data[Symbol.asyncDispose]();
	}
});

test('equal positions use row id as the deterministic tie-breaker', async () => {
	const { data, domain } = setup();
	try {
		const left = domain.create({ name: 'Left' });
		const right = domain.create({ name: 'Right' });
		expectOk(data.tables.transformations.update(left.id, { position: 4 }));
		expectOk(data.tables.transformations.update(right.id, { position: 4 }));
		expect(domain.sorted.map(({ id }) => id)).toEqual(
			[left.id, right.id].toSorted((a, b) => a.localeCompare(b)),
		);

		const first = domain.addStep(left.id, { kind: 'spoken_urls' });
		const second = domain.addStep(left.id, {
			kind: 'find_replace',
			find: 'x',
		});
		expectOk(data.tables.transformationSteps.update(first.id, { position: 2 }));
		expectOk(
			data.tables.transformationSteps.update(second.id, { position: 2 }),
		);
		expect(domain.get(left.id)?.steps.map(({ id }) => id)).toEqual(
			[first.id, second.id].toSorted((a, b) => a.localeCompare(b)),
		);
	} finally {
		domain[Symbol.dispose]();
		await data[Symbol.asyncDispose]();
	}
});

test('parent deletion cascades and schema-conforming orphans stay ignored', async () => {
	const { data, domain } = setup();
	try {
		const parent = domain.create({ name: 'Parent' });
		domain.addStep(parent.id, { kind: 'spoken_urls' });
		const orphan = expectOk(
			data.tables.transformationSteps.create({
				transformationId: 'missing-parent',
				position: 0,
				kind: 'spoken_urls',
				find: '',
				replace: '',
				useRegex: false,
			}),
		);
		expect(domain.sorted.flatMap(({ steps }) => steps)).toHaveLength(1);

		domain.delete(parent.id);
		expect(domain.sorted).toEqual([]);
		expect(
			data.tables.transformationSteps.list().rows.map(({ id }) => id),
		).toEqual([orphan.id]);
	} finally {
		domain[Symbol.dispose]();
		await data[Symbol.asyncDispose]();
	}
});

test('external table writes refresh until disposal', async () => {
	const { data, domain } = setup();
	try {
		expectOk(
			data.tables.transformations.create({
				name: 'Remote',
				description: '',
				enabled: false,
				position: 0,
			}),
		);
		expect(domain.sorted.map(({ name }) => name)).toEqual(['Remote']);

		domain[Symbol.dispose]();
		expectOk(
			data.tables.transformations.create({
				name: 'After disposal',
				description: '',
				enabled: false,
				position: 1,
			}),
		);
		expect(domain.sorted.map(({ name }) => name)).toEqual(['Remote']);
	} finally {
		await data[Symbol.asyncDispose]();
	}
});
