import { defineTransformRegistry } from '../../../core/migrations';

/**
 * Reddit transform registry: keyed by target tag.
 * 0001: baseline forward step; currently a no-op. Replace with real transforms as schema evolves.
 *
 * Note: we pass the required tag union to enforce compile-time coverage.
 */
export const redditTransforms = defineTransformRegistry({});
