import { describe, expect, test } from 'bun:test';
import { gateWhisperingBootstrap } from './prepare-whispering-index.ts';

const INDEX = `<!doctype html>
<script>
  Promise.all([
    import('/start.js'),
    import('/app.js')
  ]).then(([kit, app]) => {
    kit.start(app);
  });
</script>`;

describe('gateWhisperingBootstrap', () => {
	test('waits for the native credential preload before importing SvelteKit', () => {
		const gated = gateWhisperingBootstrap(INDEX);

		expect(gated).toContain(
			'(window.__EPICENTER_WHISPERING_AUTH_READY__ ?? Promise.resolve()).then(() => Promise.all([',
		);
		expect(gated).toContain('])).then(([kit, app]) => {');
	});

	test('refuses an unknown or ambiguous generated bootstrap shape', () => {
		expect(() => gateWhisperingBootstrap('<html></html>')).toThrow('found 0');
		expect(() => gateWhisperingBootstrap(`${INDEX}${INDEX}`)).toThrow(
			'found 2',
		);
	});
});
