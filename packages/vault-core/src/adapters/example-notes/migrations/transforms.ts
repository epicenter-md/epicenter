/**
 * Transform registry for example_notes adapter.
 *
 * With versions ['0000', '0001'], provide a no-op transform for target tag '0001'
 * to keep registry length aligned with versions (all tags except the first/baseline).
 */
import { defineTransformRegistry } from '../../../core/migrations';

export const exampleNotesTransforms = defineTransformRegistry({
	'0001': (input) => input,
});
