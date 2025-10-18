import type { Accessor } from '@tanstack/svelte-query';
import { Err, Ok } from 'wellcrafted/result';
import * as services from '$lib/services';
import type { Transformation } from '$lib/services/db/models';
import { settings } from '$lib/stores/settings.svelte';
import { defineMutation, defineQuery, queryClient } from './_client';

// Define the query key as a constant array
export const transformationsKeys = {
	all: ['transformations'] as const,
	byId: (id: string) => ['transformations', id] as const,
};

export const transformations = {
	queries: {
		getAllTransformations: defineQuery({
			queryKey: transformationsKeys.all,
			resultQueryFn: () => services.db.getAllTransformations(),
		}),
		getTransformationById: (id: Accessor<string>) =>
			defineQuery({
				queryKey: transformationsKeys.byId(id()),
				resultQueryFn: () => services.db.getTransformationById(id()),
				initialData: () =>
					queryClient
						.getQueryData<Transformation[]>(transformationsKeys.all)
						?.find((t) => t.id === id()),
				initialDataUpdatedAt: () =>
					queryClient.getQueryState(transformationsKeys.byId(id()))
						?.dataUpdatedAt,
			}),
	},
	mutations: {
		createTransformation: defineMutation({
			mutationKey: ['transformations', 'createTransformation'] as const,
			resultMutationFn: async (transformation: Transformation) => {
				const { data, error } =
					await services.db.createTransformation(transformation);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					transformationsKeys.all,
					(oldData) => {
						if (!oldData) return [transformation];
						return [...oldData, transformation];
					},
				);
				queryClient.setQueryData<Transformation>(
					transformationsKeys.byId(transformation.id),
					transformation,
				);

				return Ok(data);
			},
		}),
		updateTransformation: defineMutation({
			mutationKey: ['transformations', 'updateTransformation'] as const,
			resultMutationFn: async (transformation: Transformation) => {
				const { data, error } =
					await services.db.updateTransformation(transformation);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					transformationsKeys.all,
					(oldData) => {
						if (!oldData) return [transformation];
						return oldData.map((item) =>
							item.id === transformation.id ? transformation : item,
						);
					},
				);
				queryClient.setQueryData<Transformation>(
					transformationsKeys.byId(transformation.id),
					transformation,
				);

				return Ok(data);
			},
		}),
		deleteTransformation: defineMutation({
			mutationKey: ['transformations', 'deleteTransformation'] as const,
			resultMutationFn: async (transformation: Transformation) => {
				const { error } =
					await services.db.deleteTransformation(transformation);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					transformationsKeys.all,
					(oldData) => {
						if (!oldData) return [];
						return oldData.filter((item) => item.id !== transformation.id);
					},
				);
				queryClient.removeQueries({
					queryKey: transformationsKeys.byId(transformation.id),
				});

				if (
					transformation.id ===
					settings.value['transformations.selectedTransformationId']
				) {
					settings.updateKey('transformations.selectedTransformationId', null);
				}

				return Ok(undefined);
			},
		}),
		deleteTransformations: defineMutation({
			mutationKey: ['transformations', 'deleteTransformations'] as const,
			resultMutationFn: async (transformations: Transformation[]) => {
				const { error } =
					await services.db.deleteTransformations(transformations);
				if (error) return Err(error);

				queryClient.setQueryData<Transformation[]>(
					transformationsKeys.all,
					(oldData) => {
						if (!oldData) return [];
						const deletedIds = new Set(transformations.map((t) => t.id));
						return oldData.filter((item) => !deletedIds.has(item.id));
					},
				);
				for (const transformation of transformations) {
					queryClient.removeQueries({
						queryKey: transformationsKeys.byId(transformation.id),
					});
				}

				if (
					transformations.some(
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
};
