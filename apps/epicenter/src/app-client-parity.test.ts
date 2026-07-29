/**
 * @fileoverview The public client, this host's generated bindings, and the
 * app-window capability agree about every command.
 *
 * `@epicenter/app` is written by hand against this crate's command names rather
 * than generated from it, because what an installed app may call is a product
 * decision and a generator would export whatever the crate happens to register
 * (ADR-0186). That is the right boundary and it is also the drift risk: a
 * renamed Rust parameter regenerates the bindings around itself, compiles
 * everywhere, and leaves the client sending a key the host will not read. The
 * failure appears the first time someone records.
 *
 * This is where that is caught, because this is the one place all three
 * artifacts are ordinary values. The capability is JSON, the bindings are a
 * module, and the client is a package, so nothing here parses source text: both
 * sides are *driven* through one fake IPC and compared on what they actually
 * sent.
 *
 * It lives here rather than in `packages/app` because the direction matters.
 * This app is AGPL and the client is MIT, so an app-owned test may import the
 * client, and a client-owned test importing this app would be the relicensing
 * edge the license boundary exists to prevent.
 */

import { afterEach, expect, test } from 'bun:test';
import { epicenter } from '@epicenter/app';
import developmentCapability from '../src-tauri/capabilities/trusted-app-windows-development.json' with {
	type: 'json',
};
import productionCapability from '../src-tauri/capabilities/trusted-app-windows-production.json' with {
	type: 'json',
};
import { commands } from './ui/bindings.gen';

type Invocation = { command: string; args: Record<string, unknown> };

/**
 * One answer every command's reader can consume.
 *
 * Both sides are being driven for their *requests*, so the response only has to
 * be shaped well enough that neither side throws on the way out.
 */
const ANSWER = {
	audioBlobId: 'blob_parity',
	device: { outcome: 'success', deviceId: 'microphone' },
	endedReason: null,
	durationMs: 0,
	byteLength: 0,
	status: 'ready',
	supportsPrompt: false,
	supportsLanguage: false,
	outcome: 'empty-audio',
};

const globals = globalThis as { window?: unknown };

/** Record every invoke both sides make, and answer them all the same way. */
function recordInvocations(): Invocation[] {
	const invocations: Invocation[] = [];
	globals.window = {
		__TAURI_INTERNALS__: {
			metadata: {
				currentWindow: { label: 'app-parity' },
				currentWebview: { label: 'app-parity' },
			},
			invoke: (command: string, args: Record<string, unknown>) => {
				invocations.push({ command, args: args ?? {} });
				return Promise.resolve(ANSWER);
			},
			transformCallback: () => 1,
		},
	};
	return invocations;
}

afterEach(() => {
	delete globals.window;
});

/**
 * Every operation the client offers, beside the generated binding for the same
 * command. Both are called with equivalent inputs so the only thing that can
 * differ is what each decides to send.
 */
const OPERATIONS: Array<{
	command: string;
	generated: () => Promise<unknown>;
	// `prewarm` returns nothing by contract, so this is not always awaitable.
	client: () => unknown;
}> = [
	{
		command: 'start_recording',
		generated: () => commands.startRecording(null),
		client: () => epicenter.recording.start(),
	},
	{
		command: 'current_recording',
		generated: () => commands.currentRecording(),
		client: () => epicenter.recording.current(),
	},
	{
		command: 'stop_recording',
		generated: () => commands.stopRecording('blob_parity'),
		client: () => epicenter.recording.stop('blob_parity'),
	},
	{
		command: 'cancel_recording',
		generated: () => commands.cancelRecording('blob_parity'),
		client: () => epicenter.recording.cancel('blob_parity'),
	},
	{
		command: 'transcribe_recording',
		generated: () =>
			commands.transcribeRecording('blob_parity', {
				language: null,
				initialPrompt: null,
			}),
		client: () => epicenter.transcription.transcribe('blob_parity'),
	},
	{
		command: 'prewarm_model',
		generated: () => commands.prewarmModel(),
		client: () => epicenter.transcription.prewarm(),
	},
	{
		command: 'get_local_transcription_readiness',
		generated: () => commands.getLocalTranscriptionReadiness(),
		client: () => epicenter.transcription.capabilities(),
	},
];

const argumentNames = (invocation: Invocation) =>
	Object.keys(invocation.args).sort();

test.each(
	OPERATIONS,
)('$command: the client sends what this host deserializes', async ({
	command,
	generated,
	client,
}) => {
	const invocations = recordInvocations();

	await generated();
	await client();
	// `prewarm` is deliberately outcome-free, so it fires its invoke without
	// anything to await. One turn is enough for it to land.
	await Promise.resolve();

	expect(invocations).toHaveLength(2);
	const [byHost, byClient] = invocations;
	if (!byHost || !byClient) throw new Error('unreachable');
	expect(byHost.command).toBe(command);
	expect(byClient.command).toBe(command);

	// The whole point: not "does this name appear somewhere", but "did these
	// two calls carry the same arguments".
	expect(argumentNames(byClient)).toEqual(argumentNames(byHost));
});

/**
 * The commands an app window is granted, from the capability itself. Plugin and
 * core grants belong to their plugins and are asserted in the Rust suite, where
 * the permission names are checked against the ones this build declares.
 */
function grantedCommands(capability: { permissions: unknown[] }) {
	return capability.permissions
		.filter(
			(permission): permission is string => typeof permission === 'string',
		)
		.filter((permission) => !permission.includes(':'))
		.map((permission) => permission.replace(/^allow-/, '').replaceAll('-', '_'))
		.sort();
}

// The third artifact. The client could agree with the bindings perfectly and
// still invoke something an app window was never granted, which fails only at
// runtime and only for whoever installed the app.
test('the client invokes exactly what an app window is granted', async () => {
	const invocations = recordInvocations();
	for (const { client } of OPERATIONS) await client();
	await Promise.resolve();

	const invoked = [
		...new Set(invocations.map(({ command }) => command)),
	].sort();

	for (const capability of [developmentCapability, productionCapability]) {
		expect(grantedCommands(capability)).toEqual(invoked);
	}
});
