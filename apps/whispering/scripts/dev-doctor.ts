#!/usr/bin/env bun
/**
 * Diagnose the macOS dev Accessibility identity in one command:
 *
 *   bun run dev:doctor
 *
 * It reports the STATIC identity facts that decide whether the TCC grant will
 * stick: where the dev binary is, its code-signing Identifier, signature,
 * designated requirement, whether those match the dev identity, and the reset
 * command to copy. The LIVE facts (AXIsProcessTrusted, the current
 * DictationCapability, the grant watcher's last stop reason) are owned by the
 * running app's Rust supervisor and surface in the app itself plus the Tauri log,
 * so this script points there rather than guessing them from outside the process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_TAURI = join(import.meta.dir, '..', 'src-tauri');

function run(command: string, args: string[]): string {
	const result = Bun.spawnSync([command, ...args]);
	return (
		new TextDecoder().decode(result.stdout) +
		new TextDecoder().decode(result.stderr)
	).trim();
}

const devConfig = JSON.parse(
	readFileSync(join(SRC_TAURI, 'tauri.dev.conf.json'), 'utf8'),
);
const expectedIdentifier = devConfig.identifier;
const productName = devConfig.productName;

console.log('Whispering dev Accessibility doctor');
console.log('==================================');
console.log(`platform:           ${process.platform}`);
console.log(`expected identifier: ${expectedIdentifier}`);
console.log(`expected name:       ${productName}`);

if (process.platform !== 'darwin') {
	console.log('\nNot macOS: no Accessibility/TCC identity to check.');
	process.exit(0);
}

// Mirror the runner's binary path: honor CARGO_TARGET_DIR like cargo does.
const targetDir = process.env.CARGO_TARGET_DIR ?? join(SRC_TAURI, 'target');
const binary = join(targetDir, 'debug', 'whispering');
console.log(`\ndev binary:         ${binary}`);
if (!existsSync(binary)) {
	console.log('  (not built yet; run `bun run dev` first)');
	process.exit(0);
}

const codesign = run('codesign', ['-dv', '--verbose=4', binary]);
const requirements = run('codesign', ['-d', '-r-', binary]);
const identifierLine = codesign.match(/^Identifier=(.*)$/m)?.[1] ?? '(none)';
const signature = codesign.match(/^Signature=(.*)$/m)?.[1] ?? '(none)';
const teamIdentifier =
	codesign.match(/^TeamIdentifier=(.*)$/m)?.[1] ?? '(none)';
const cdhash = codesign.match(/^CDHash=(.*)$/m)?.[1] ?? '(none)';
const flags = codesign.match(/flags=(\S+)/)?.[1] ?? '(none)';
const requirementLine =
	requirements.match(/designated =>.*$/m)?.[0] ?? '(none)';
const expectedRequirement = `designated => identifier "${expectedIdentifier}"`;

console.log(`  signed Identifier: ${identifierLine}`);
console.log(`  signature:         ${signature}`);
console.log(`  team identifier:   ${teamIdentifier}`);
console.log(`  cdhash:            ${cdhash}`);
console.log(`  flags:             ${flags}`);
console.log(`  requirement:       ${requirementLine}`);

const isAdhoc = signature === 'adhoc' || /\badhoc\b/.test(flags);
const identifierMatches = identifierLine === expectedIdentifier;
const requirementMatches = requirementLine === expectedRequirement;

console.log('\nverdict:');
if (!identifierMatches) {
	console.log(
		`  x signed identifier is "${identifierLine}", expected "${expectedIdentifier}".`,
	);
	console.log('    The runner may not be wired in. Re-run `bun run dev`.');
} else if (!isAdhoc) {
	console.log(`  x signature is "${signature}", expected ad-hoc.`);
	console.log('    The runner should sign with `codesign --sign -`.');
} else if (!requirementMatches) {
	console.log('  x designated requirement is not identifier-only.');
	console.log(`    Expected requirement: ${expectedRequirement}`);
	console.log(
		'    Re-run `bun run dev` so the runner can overwrite the signature.',
	);
} else {
	console.log(
		'  ok: ad-hoc signature uses the fixed identifier-only requirement. Grant should persist.',
	);
}

console.log(
	'\nreset the dev grants (after the app has launched at least once):',
);
console.log(`  tccutil reset Microphone ${expectedIdentifier}`);
console.log(`  tccutil reset Accessibility ${expectedIdentifier}`);
console.log(
	'  then relaunch dev and grant the new Microphone/Accessibility entries.',
);

console.log('\nlive trust / capability / grant-watcher health:');
console.log(
	'  shown in the app (DictationCapability) and the Tauri log; the Rust',
);
console.log('  supervisor in src-tauri/src/keyboard/mod.rs owns those values.');
