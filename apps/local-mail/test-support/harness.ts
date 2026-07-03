/**
 * Manual boot of the safe write harness, for browser exploration. Stands up the
 * throwaway-copy + mock Gmail + `local-mail up` stack (the same safe stack the
 * smokes use, see ./boot.ts), prints a launch URL to open in a browser, and
 * stays alive until Ctrl-C.
 *
 *   bun run apps/local-mail/test-support/harness.ts [--catching-up]
 *
 * With `--catching-up` the mock omits labelIds (`folded:false`), so writes flash
 * the "catching up" mirror chip instead of folding immediately.
 *
 * The bootstrap token in the URL is single-use, so re-run for each fresh browser
 * session. Runtime artifacts live under LM_TEST_DIR, never the repo.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootHarness } from './boot.ts';

const fold = !process.argv.includes('--catching-up');
const uiDist = join(import.meta.dir, '..', 'ui', 'dist', 'index.html');

const harness = await bootHarness({ fold });

console.log(`URL=${harness.appOrigin}/#token=${harness.bootstrapToken}`);
console.log(`MOCK_LOG=${harness.mockLog}`);
console.log(`fold=${fold}${fold ? ' (pass --catching-up for the folded:false chip)' : ''}`);
if (!existsSync(uiDist)) {
	console.log('note: SPA not built; the page will be blank. Build it with:');
	console.log('  bun run --cwd apps/local-mail/ui build');
}
console.log('Open the URL in a browser. Ctrl-C to stop.');

// Keep the process (and the mock + app it owns) alive until interrupted.
const keepAlive = setInterval(() => {}, 1 << 30);
process.on('SIGINT', () => {
	clearInterval(keepAlive);
	harness.teardown();
	process.exit(0);
});
