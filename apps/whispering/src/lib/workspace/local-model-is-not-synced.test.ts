import { describe, expect, it } from 'bun:test';
import { whisperingLens } from './index';

/**
 * The active local transcription model must never synchronize (ADR-0180).
 *
 * It names model files and an accelerator that exist on one machine: a second
 * device may have neither the bytes nor compatible hardware, so a synced choice
 * would arrive as a model that cannot run. Whispering therefore owns the
 * transcription *route* here and nothing about which local model runs; the host
 * owns that, device-locally, and Epicenter Home administers it.
 *
 * This guards the direction the mistake would come from. The Lens's `kv` section
 * IS the synced settings surface, so a local-model key landing in it is exactly
 * how the invariant would silently break: the key would look like an ordinary
 * setting and start replicating.
 */
describe('the active local model is device-local', () => {
	const settingKeys = Object.keys(whisperingLens.kv);

	it('is absent from the synced settings contract', () => {
		const localModelKeys = settingKeys.filter(
			(key) =>
				/local/i.test(key) && (/model/i.test(key) || /unload/i.test(key)),
		);
		expect(localModelKeys).toEqual([]);
	});

	it('leaves the transcription route synced, because a route is portable', () => {
		// The route is a preference that means the same thing on every device, so
		// it stays here. Keeping this alongside the assertion above is the point:
		// the two decisions are separate, and only one of them travels.
		expect(settingKeys).toContain('transcriptionService');
	});
});
