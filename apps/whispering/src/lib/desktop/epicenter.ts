import { Channel } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { TextError } from '$lib/services/text/types';
import { commands, events } from '$lib/tauri/commands';
import type { WhisperingDesktop } from './contract';

async function unitResult<TError>(
	result: Promise<Result<null, TError>>,
): Promise<Result<void, TError>> {
	const { error } = await result;
	return error === null ? Ok(undefined) : Err(error);
}

async function unwrapHostResult<T>(
	result: Promise<Result<T, string>>,
): Promise<T> {
	const { data, error } = await result;
	if (error !== null) throw new Error(error);
	return data;
}

/**
 * Complete native product capabilities available to Whispering inside
 * Epicenter. This is the only adapter that groups generated host bindings for
 * feature code; it deliberately exposes no generic invoke, HTTP, filesystem,
 * window-construction, or permission primitive.
 */
export const desktop: WhisperingDesktop = {
	async reveal() {
		await unwrapHostResult(commands.revealWhisperingWindow());
	},
	shortcuts: {
		replace: (registrations) =>
			unitResult(commands.replaceGlobalShortcuts(registrations)),
		onTriggered: async (handler) => {
			const unlisten = await events.globalShortcutTriggered.listen(
				({ payload }) => handler(payload),
			);
			return unlisten;
		},
	},
	dictation: {
		setCursorDeliveryEnabled: (enabled) =>
			commands.setAutoPasteEnabled(enabled),
		getCapability: () => commands.getDictationCapability(),
		onCapabilityChanged: async (handler) => {
			const unlisten = await events.dictationCapabilityEvent.listen(
				({ payload }) => handler(payload.capability),
			);
			return unlisten;
		},
		requestAccess: () => commands.requestAccessibilityPermission(),
		openAccessSettings: () => unitResult(commands.openAccessibilitySettings()),
	},
	localTranscription: {
		listModels: () => commands.listModels(),
		downloadModel: (modelId, downloadId, onProgress) => {
			const channel = new Channel<Parameters<typeof onProgress>[0]>();
			channel.onmessage = onProgress;
			return unitResult(commands.downloadModel(modelId, downloadId, channel));
		},
		cancelDownload: (downloadId) => commands.cancelDownload(downloadId),
		deleteModel: (modelId) => unitResult(commands.deleteModel(modelId)),
		prewarm: (spec) => unitResult(commands.prewarmModel(spec)),
		transcribe: (recordingId, spec) =>
			commands.transcribeRecording(recordingId, spec),
		setUnloadPolicy: (policy) => commands.setUnloadPolicy(policy),
	},
	delivery: {
		supportsCursor: true,
		write: async (text, keepOnClipboard) => {
			const { data, error } = await commands.writeText(text, keepOnClipboard);
			if (error !== null) return TextError.WriteToCursor({ cause: error });
			return Ok(data);
		},
		pressEnter: async () => {
			const { error } = await commands.simulateEnterKeystroke();
			return error === null
				? Ok(undefined)
				: TextError.SimulateKeystroke({ cause: error });
		},
		copySelection: async () => {
			const { error } = await commands.simulateCopyKeystroke();
			return error === null
				? Ok(undefined)
				: TextError.SimulateKeystroke({ cause: error });
		},
	},
};
