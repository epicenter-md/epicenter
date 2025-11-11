import type { Accessor } from '@tanstack/svelte-query';
import { Err, Ok } from 'wellcrafted/result';
import * as services from '$lib/services';
import type {
	Recording,
	Transformation,
	TransformationRun,
} from '$lib/services/db';
import { settings } from '$lib/stores/settings.svelte';
import { defineMutation, defineQuery, queryClient } from './_client';

/**
 * Consolidated query keys that mirror the database service structure
 */
export const dbKeys = {
	recordings: {
		all: ['db', 'recordings'] as const,
		latest: ['db', 'recordings', 'latest'] as const,
		byId: (id: string) => ['db', 'recordings', id] as const,
		audioPlaybackUrl: (id: string) =>
			['db', 'recordings', id, 'audioPlaybackUrl'] as const,
	},
	transformations: {
		all: ['db', 'transformations'] as const,
		byId: (id: string) => ['db', 'transformations', id] as const,
	},
	runs: {
		byTransformationId: (id: string) =>
			['db', 'runs', 'transformationId', id] as const,
		byRecordingId: (id: string) => ['db', 'runs', 'recordingId', id] as const,
	},
};

/**
 * Unified database query layer that mirrors services.db structure exactly
 */
export const db = {
	/**
	 * Recording operations
	 */
	recordings: {
		getAll: defineQuery({
			queryKey: dbKeys.recordings.all,
			resultQueryFn: () => services.db.recordings.getAll(),
		}),

		getLatest: defineQuery({
			queryKey: dbKeys.recordings.latest,
			resultQueryFn: () => services.db.recordings.getLatest(),
			initialData: () =>
				queryClient
					.getQueryData<Recording[]>(dbKeys.recordings.all)
					?.toSorted(
						(a, b) =>
							new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
					)[0] ?? null,
			initialDataUpdatedAt: () =>
				queryClient.getQueryState(dbKeys.recordings.all)?.dataUpdatedAt,
		}),

		getById: (id: Accessor<string>) =>
			defineQuery({
				queryKey: dbKeys.recordings.byId(id()),
				resultQueryFn: () => services.db.recordings.getById(id()),
				initialData: () =>
					queryClient
						.getQueryData<Recording[]>(dbKeys.recordings.all)
						?.find((r) => r.id === id()) ?? null,
				initialDataUpdatedAt: () =>
					queryClient.getQueryState(dbKeys.recordings.all)?.dataUpdatedAt,
			}),

		/**
		 * Get audio playback URL for a recording by ID.
		 * Uses the accessor pattern for reactive updates.
		 * The URL is cached and managed by the DbService implementation.
		 */
		getAudioPlaybackUrl: (id: Accessor<string>) =>
			defineQuery({
				queryKey: dbKeys.recordings.audioPlaybackUrl(id()),
				resultQueryFn: () =>
					services.db.recordings.ensureAudioPlaybackUrl(id()),
			}),

		create: defineMutation({
			mutationKey: ['db', 'recordings', 'create'] as const,
			resultMutationFn: async (params: {
				recording: Recording;
				audio: Blob;
			}) => {
				const { error } = await services.db.recordings.create(params);
				if (error) return Err(error);

				// Use input params for optimistic update
				queryClient.setQueryData<Recording[]>(
					dbKeys.recordings.all,
					(oldData) => {
						if (!oldData) return [params.recording];
						return [...oldData, params.recording];
					},
				);
				queryClient.setQueryData<Recording>(
					dbKeys.recordings.byId(params.recording.id),
					params.recording,
				);
				queryClient.invalidateQueries({
					queryKey: dbKeys.recordings.all,
				});
				queryClient.invalidateQueries({
					queryKey: dbKeys.recordings.latest,
				});

				return Ok(undefined);
			},
		}),

		update: defineMutation({
			mutationKey: ['db', 'recordings', 'update'] as const,
			resultMutationFn: async (recording: Recording) => {
				const { data, error } = await services.db.recordings.update(recording);
				if (error) return Err(error);

				queryClient.setQueryData<Recording[]>(
					dbKeys.recordings.all,
					(oldData) => {
						if (!oldData) return [recording];
						return oldData.map((item) =>
							item.id === recording.id ? recording : item,
						);
					},
				);
				queryClient.setQueryData<Recording>(
					dbKeys.recordings.byId(recording.id),
					recording,
				);
				queryClient.invalidateQueries({
					queryKey: dbKeys.recordings.latest,
				});

				return Ok(data);
			},
		}),

		delete: defineMutation({
			mutationKey: ['db', 'recordings', 'delete'] as const,
			resultMutationFn: async (recordings: Recording | Recording[]) => {
				const recordingsArray = Array.isArray(recordings)
					? recordings
					: [recordings];
				const { error } = await services.db.recordings.delete(recordingsArray);
				if (error) return Err(error);

				queryClient.setQueryData<Recording[]>(
					dbKeys.recordings.all,
					(oldData) => {
						if (!oldData) return [];
						const deletedIds = new Set(recordingsArray.map((r) => r.id));
						return oldData.filter((item) => !deletedIds.has(item.id));
					},
				);
				for (const recording of recordingsArray) {
					queryClient.removeQueries({
						queryKey: dbKeys.recordings.byId(recording.id),
					});
				}
				queryClient.invalidateQueries({
					queryKey: dbKeys.recordings.latest,
				});

				return Ok(undefined);
			},
		}),
	},

	/**
	 * Transformation operations
	 */
	transformations: {
		getAll: defineQuery({
			queryKey: dbKeys.transformations.all,
			resultQueryFn: () => services.db.transformations.getAll(),
		}),

		getById: (id: Accessor<string>) =>
			defineQuery({
				queryKey: dbKeys.transformations.byId(id()),
				resultQueryFn: () => services.db.transformations.getById(id()),
				initialData: () =>
					queryClient
						.getQueryData<Transformation[]>(dbKeys.transformations.all)
						?.find((t) => t.id === id()) ?? null,
				initialDataUpdatedAt: () =>
					queryClient.getQueryState(dbKeys.transformations.byId(id()))
						?.dataUpdatedAt,
			}),

		create: defineMutation({
			mutationKey: ['db', 'transformations', 'create'] as const,
			resultMutationFn: async (transformation: Transformation) => {
				const { data, error } =
					await services.db.transformations.create(transformation);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					dbKeys.transformations.all,
					(oldData) => {
						if (!oldData) return [transformation];
						return [...oldData, transformation];
					},
				);
				queryClient.setQueryData<Transformation>(
					dbKeys.transformations.byId(transformation.id),
					transformation,
				);

				return Ok(data);
			},
		}),

		update: defineMutation({
			mutationKey: ['db', 'transformations', 'update'] as const,
			resultMutationFn: async (transformation: Transformation) => {
				const { data, error } =
					await services.db.transformations.update(transformation);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					dbKeys.transformations.all,
					(oldData) => {
						if (!oldData) return [transformation];
						return oldData.map((item) =>
							item.id === transformation.id ? transformation : item,
						);
					},
				);
				queryClient.setQueryData<Transformation>(
					dbKeys.transformations.byId(transformation.id),
					transformation,
				);

				return Ok(data);
			},
		}),

		delete: defineMutation({
			mutationKey: ['db', 'transformations', 'delete'] as const,
			resultMutationFn: async (
				transformations: Transformation | Transformation[],
			) => {
				const transformationsArray = Array.isArray(transformations)
					? transformations
					: [transformations];
				const { error } =
					await services.db.transformations.delete(transformationsArray);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					dbKeys.transformations.all,
					(oldData) => {
						if (!oldData) return [];
						const deletedIds = new Set(transformationsArray.map((t) => t.id));
						return oldData.filter((item) => !deletedIds.has(item.id));
					},
				);
				for (const transformation of transformationsArray) {
					queryClient.removeQueries({
						queryKey: dbKeys.transformations.byId(transformation.id),
					});
				}

				// Check if any deleted transformation was selected
				if (
					transformationsArray.some(
						(t) =>
							t.id ===
							settings.value['transformations.selectedTransformationId'],
					)
				) {
					settings.updateKey('transformations.selectedTransformationId', null);
				}

				return Ok(undefined);
			},
		}),
	},

	/**
	 * Transformation run operations
	 */
	runs: {
		getByTransformationId: (id: Accessor<string>) =>
			defineQuery({
				queryKey: dbKeys.runs.byTransformationId(id()),
				resultQueryFn: () => services.db.runs.getByTransformationId(id()),
			}),

		getByRecordingId: (recordingId: Accessor<string>) =>
			defineQuery({
				queryKey: dbKeys.runs.byRecordingId(recordingId()),
				resultQueryFn: () => services.db.runs.getByRecordingId(recordingId()),
			}),

		getLatestByRecordingId: (recordingId: Accessor<string>) =>
			defineQuery({
				queryKey: dbKeys.runs.byRecordingId(recordingId()),
				resultQueryFn: () => services.db.runs.getByRecordingId(recordingId()),
				select: (data) => data.at(0),
			}),

		delete: defineMutation({
			mutationKey: ['db', 'runs', 'delete'] as const,
			resultMutationFn: async (
				runs: TransformationRun | TransformationRun[],
			) => {
				const runsArray = Array.isArray(runs) ? runs : [runs];
				const { error } = await services.db.runs.delete(runsArray);
				if (error) return Err(error);

				// Invalidate all affected queries
				const transformationIds = new Set(
					runsArray.map((r) => r.transformationId),
				);
				const recordingIds = new Set(
					runsArray
						.map((r) => r.recordingId)
						.filter((id): id is string => id !== null),
				);

				// Invalidate queries for each transformation that had runs deleted
				for (const transformationId of transformationIds) {
					queryClient.invalidateQueries({
						queryKey: dbKeys.runs.byTransformationId(transformationId),
					});
				}

				// Invalidate queries for each recording that had runs deleted
				for (const recordingId of recordingIds) {
					queryClient.invalidateQueries({
						queryKey: dbKeys.runs.byRecordingId(recordingId),
					});
				}

				return Ok(undefined);
			},
		}),
	},
};
