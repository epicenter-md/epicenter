/**
 * Lightweight orchestrator that lifts adapter metadata (versions + transforms)
 * into a data-fix pipeline before rows touch the database. Hosts supply the raw
 * dataset gathered from disk/ingestors; we return the fully-normalized rows.
 *
 * High-level flow:
 *   1. Determine which transform registry + version tuple to use (allowing runtime overrides).
 *   2. If a manifest/versions tuple exists, run every forward transform and optional validator.
 *   3. Otherwise run the validator directly (legacy adapters).
 *   4. Hand the morphed dataset back to the caller for ingestion.
 */
import type { Adapter } from '../adapter';
import type {
	DataValidator,
	Tag4,
	TransformRegistry,
	TransformRegistryForVersions,
	VersionDef,
} from '../migrations';
import { transformAndValidate } from '../migrations';

/**
 * Runtime configuration for a single pipeline run.
 *
 * dataset          — Adapter-shaped record of unprefixed table keys mapped to rows.
 * adapter          — The adapter we’re importing (used to grab default versions/transforms).
 * transformsOverride / versionsOverride
 *                  — Allows tests or hosts to inject a different transform chain.
 * dataValidator    — Optional Standard Schema validator; defaults to adapter.validator upstream.
 * sourceTag        — Tag provided explicitly (e.g., host UI choice).
 * detectedTag      — Tag auto-detected out of the import metadata (migration.json).
 */
export type ImportPipelineInput = {
	dataset: Record<string, unknown[]>;
	adapter: Adapter;
	transformsOverride?: TransformRegistry | undefined;
	versionsOverride?: readonly VersionDef<Tag4>[] | undefined;
	dataValidator?: DataValidator | undefined;
	sourceTag?: string | undefined;
	detectedTag?: string | undefined;
};

/**
 * Executes the import pipeline, producing a dataset that matches the adapter’s current schema.
 * - Chooses effective version + transform chain (preferring overrides over adapter defaults).
 * - Runs transform chain + validator when available.
 * - Falls back to direct validation for legacy adapters without versions/transforms.
 */
export async function runImportPipeline(
	input: ImportPipelineInput,
): Promise<Record<string, unknown[]>> {
	const {
		dataset,
		adapter,
		transformsOverride,
		versionsOverride,
		dataValidator,
		sourceTag,
		detectedTag,
	} = input;

	const transforms = (transformsOverride ?? adapter.transforms) as
		| TransformRegistry
		| undefined;
	const baseVersions = adapter.versions;
	const effectiveVersions = (versionsOverride ?? baseVersions) as
		| readonly VersionDef<Tag4>[]
		| undefined;
	const resolvedSourceTag = sourceTag ?? detectedTag;

	// Any transforms/validation happen purely in-memory; we never mutate the original dataset object.
	let pipelineOutput: Record<string, unknown[]> = dataset;

	if (effectiveVersions && transforms) {
		// Both versions + transforms exist → run the forward chain plus validation.
		const typedVersions = effectiveVersions;
		const typedTransforms = transforms as TransformRegistryForVersions<
			typeof typedVersions
		>;
		const typedDataset = dataset as {
			[key: string]: Record<string, unknown>[];
		};
		const result = await transformAndValidate(
			typedVersions,
			typedTransforms,
			typedDataset,
			resolvedSourceTag,
			dataValidator,
		);
		pipelineOutput = result as Record<string, unknown[]>;
	} else if (dataValidator) {
		// Legacy adapter path: run a validator if provided, but skip transform orchestration.
		const validated = await dataValidator(dataset);
		pipelineOutput = validated as Record<string, unknown[]>;
	}

	return pipelineOutput;
}
