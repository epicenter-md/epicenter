import { nanoid } from 'nanoid/non-secure';
import { Err, Ok } from 'wellcrafted/result';
import { fromTaggedError, WhisperingErr } from '$lib/result';
import { DbServiceErr } from '$lib/services/db';
import { settings } from '$lib/stores/settings.svelte';
import * as transformClipboardWindow from '../../routes/transform-clipboard/transformClipboardWindow.tauri';
import { rpc } from './';
import { defineMutation } from './_client';
import { db } from './db';
import { delivery } from './delivery';
import { notify } from './notify';
import { recorder } from './recorder';
import { sound } from './sound';
import { text } from './text';
import { transcription } from './transcription';
import { transformer } from './transformer';
import { vadRecorder } from './vad-recorder';

/**
 * Application actions. These are mutations at the UI boundary that can be invoked
 * from anywhere: command registry, components, stores, etc.
 *
 * They always return Ok() because there's nowhere left to propagate errors—errors flow
 * sideways through notify.error.execute() instead of up the call stack. Actions are
 * the end of the operation chain.
 */

// Track manual recording start time for duration calculation
let manualRecordingStartTime: number | null = null;

// Internal mutations for manual recording
const startManualRecording = defineMutation({
	mutationKey: ['commands', 'startManualRecording'] as const,
	resultMutationFn: async () => {
		await settings.switchRecordingMode('manual');

		const toastId = nanoid();
		notify.loading.execute({
			id: toastId,
			title: '🎙️ Preparing to record...',
			description: 'Setting up your recording environment...',
		});
		const { data: deviceAcquisitionOutcome, error: startRecordingError } =
			await recorder.startRecording.execute({ toastId });

		if (startRecordingError) {
			notify.error.execute({ id: toastId, ...startRecordingError });
			return Ok(undefined);
		}

		switch (deviceAcquisitionOutcome.outcome) {
			case 'success': {
				notify.success.execute({
					id: toastId,
					title: '🎙️ Whispering is recording...',
					description: 'Speak now and stop recording when done',
				});
				break;
			}
			case 'fallback': {
				const method = settings.value['recording.method'];
				settings.updateKey(
					`recording.${method}.deviceId`,
					deviceAcquisitionOutcome.deviceId,
				);
				switch (deviceAcquisitionOutcome.reason) {
					case 'no-device-selected': {
						notify.info.execute({
							id: toastId,
							title: '🎙️ Switched to available microphone',
							description:
								'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
							action: {
								type: 'link',
								label: 'Open Settings',
								href: '/settings/recording',
							},
						});
						break;
					}
					case 'preferred-device-unavailable': {
						notify.info.execute({
							id: toastId,
							title: '🎙️ Switched to different microphone',
							description:
								"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
							action: {
								type: 'link',
								label: 'Open Settings',
								href: '/settings/recording',
							},
						});
						break;
					}
				}
			}
		}
		// Track start time for duration calculation
		manualRecordingStartTime = Date.now();
		console.info('Recording started');
		sound.playSoundIfEnabled.execute('manual-start');
		return Ok(undefined);
	},
});

const stopManualRecording = defineMutation({
	mutationKey: ['commands', 'stopManualRecording'] as const,
	resultMutationFn: async () => {
		const toastId = nanoid();
		notify.loading.execute({
			id: toastId,
			title: '⏸️ Stopping recording...',
			description: 'Finalizing your audio capture...',
		});
		const { data, error: stopRecordingError } =
			await recorder.stopRecording.execute({ toastId });
		if (stopRecordingError) {
			notify.error.execute({ id: toastId, ...stopRecordingError });
			return Ok(undefined);
		}

		const { blob, recordingId } = data;

		notify.success.execute({
			id: toastId,
			title: '🎙️ Recording stopped',
			description: 'Your recording has been saved',
		});
		console.info('Recording stopped');
		sound.playSoundIfEnabled.execute('manual-stop');

		// Log manual recording completion
		let duration: number | undefined;
		if (manualRecordingStartTime) {
			duration = Date.now() - manualRecordingStartTime;
			manualRecordingStartTime = null; // Reset for next recording
		}
		rpc.analytics.logEvent.execute({
			type: 'manual_recording_completed',
			blob_size: blob.size,
			duration,
		});

		await processRecordingPipeline({
			blob,
			recordingId,
			toastId,
			completionTitle: '✨ Recording Complete!',
			completionDescription: 'Recording saved and session closed successfully',
		});

		return Ok(undefined);
	},
});

// Internal mutations for VAD recording
const startVadRecording = defineMutation({
	mutationKey: ['commands', 'startVadRecording'] as const,
	resultMutationFn: async () => {
		await settings.switchRecordingMode('vad');

		const toastId = nanoid();
		console.info('Starting voice activated capture');
		notify.loading.execute({
			id: toastId,
			title: '🎙️ Starting voice activated capture',
			description: 'Your voice activated capture is starting...',
		});
		const { data: deviceAcquisitionOutcome, error: startActiveListeningError } =
			await vadRecorder.startActiveListening.execute({
				onSpeechStart: () => {
					notify.success.execute({
						title: '🎙️ Speech started',
						description: 'Recording started. Speak clearly and loudly.',
					});
				},
				onSpeechEnd: async (blob) => {
					const toastId = nanoid();
					notify.success.execute({
						id: toastId,
						title: '🎙️ Voice activated speech captured',
						description: 'Your voice activated speech has been captured.',
					});
					console.info('Voice activated speech captured');
					sound.playSoundIfEnabled.execute('vad-capture');

					// Log VAD recording completion
					rpc.analytics.logEvent.execute({
						type: 'vad_recording_completed',
						blob_size: blob.size,
						// VAD doesn't track duration by default
					});

					await processRecordingPipeline({
						blob,
						toastId,
						completionTitle: '✨ Voice activated capture complete!',
						completionDescription:
							'Voice activated capture complete! Ready for another take',
					});
				},
			});
		if (startActiveListeningError) {
			notify.error.execute({ id: toastId, ...startActiveListeningError });
			return Ok(undefined);
		}

		// Handle device acquisition outcome
		switch (deviceAcquisitionOutcome.outcome) {
			case 'success': {
				notify.success.execute({
					id: toastId,
					title: '🎙️ Voice activated capture started',
					description: 'Your voice activated capture has been started.',
				});
				break;
			}
			case 'fallback': {
				settings.updateKey(
					'recording.navigator.deviceId',
					deviceAcquisitionOutcome.deviceId,
				);
				switch (deviceAcquisitionOutcome.reason) {
					case 'no-device-selected': {
						notify.info.execute({
							id: toastId,
							title: '🎙️ VAD started with available microphone',
							description:
								'No microphone was selected for VAD, so we automatically connected to an available one. You can update your selection in settings.',
							action: {
								type: 'link',
								label: 'Open Settings',
								href: '/settings/recording',
							},
						});
						break;
					}
					case 'preferred-device-unavailable': {
						notify.info.execute({
							id: toastId,
							title: '🎙️ VAD switched to different microphone',
							description:
								"Your previously selected VAD microphone wasn't found, so we automatically connected to an available one.",
							action: {
								type: 'link',
								label: 'Open Settings',
								href: '/settings/recording',
							},
						});
						break;
					}
				}
			}
		}

		sound.playSoundIfEnabled.execute('vad-start');
		return Ok(undefined);
	},
});

const stopVadRecording = defineMutation({
	mutationKey: ['commands', 'stopVadRecording'] as const,
	resultMutationFn: async () => {
		const toastId = nanoid();
		console.info('Stopping voice activated capture');
		notify.loading.execute({
			id: toastId,
			title: '⏸️ Stopping voice activated capture...',
			description: 'Finalizing your voice activated capture...',
		});
		const { error: stopVadError } =
			await vadRecorder.stopActiveListening.execute(undefined);
		if (stopVadError) {
			notify.error.execute({ id: toastId, ...stopVadError });
			return Ok(undefined);
		}
		notify.success.execute({
			id: toastId,
			title: '🎙️ Voice activated capture stopped',
			description: 'Your voice activated capture has been stopped.',
		});
		sound.playSoundIfEnabled.execute('vad-stop');
		return Ok(undefined);
	},
});

export const commands = {
	startManualRecording,
	stopManualRecording,
	startVadRecording,
	stopVadRecording,

	// Toggle manual recording
	toggleManualRecording: defineMutation({
		mutationKey: ['commands', 'toggleManualRecording'] as const,
		resultMutationFn: async () => {
			const { data: recorderState, error: getRecorderStateError } =
				await recorder.getRecorderState.fetch();
			if (getRecorderStateError) {
				notify.error.execute(getRecorderStateError);
				return Ok(undefined);
			}
			if (recorderState === 'RECORDING') {
				return await stopManualRecording.execute(undefined);
			}
			return await startManualRecording.execute(undefined);
		},
	}),

	// Cancel manual recording
	cancelManualRecording: defineMutation({
		mutationKey: ['commands', 'cancelManualRecording'] as const,
		resultMutationFn: async () => {
			const toastId = nanoid();
			notify.loading.execute({
				id: toastId,
				title: '⏸️ Canceling recording...',
				description: 'Cleaning up recording session...',
			});
			const { data: cancelRecordingResult, error: cancelRecordingError } =
				await recorder.cancelRecording.execute({ toastId });
			if (cancelRecordingError) {
				notify.error.execute({ id: toastId, ...cancelRecordingError });
				return Ok(undefined);
			}
			switch (cancelRecordingResult.status) {
				case 'no-recording': {
					notify.info.execute({
						id: toastId,
						title: 'No active recording',
						description: 'There is no recording in progress to cancel.',
					});
					break;
				}
				case 'cancelled': {
					// Session cleanup is now handled internally by the recorder service
					// Reset start time if recording was cancelled
					manualRecordingStartTime = null;
					notify.success.execute({
						id: toastId,
						title: '✅ All Done!',
						description: 'Recording cancelled successfully',
					});
					sound.playSoundIfEnabled.execute('manual-cancel');
					console.info('Recording cancelled');
					break;
				}
			}
			return Ok(undefined);
		},
	}),

	// Toggle VAD recording
	toggleVadRecording: defineMutation({
		mutationKey: ['commands', 'toggleVadRecording'] as const,
		resultMutationFn: async () => {
			const { data: vadState } = await vadRecorder.getVadState.fetch();
			if (vadState === 'LISTENING' || vadState === 'SPEECH_DETECTED') {
				return await stopVadRecording.execute(undefined);
			}
			return await startVadRecording.execute(undefined);
		},
	}),

	// Upload recordings (supports multiple files)
	uploadRecordings: defineMutation({
		mutationKey: ['recordings', 'uploadRecordings'] as const,
		resultMutationFn: async ({ files }: { files: File[] }) => {
			await settings.switchRecordingMode('upload');
			// Partition files into valid and invalid in a single pass
			const { valid: validFiles, invalid: invalidFiles } = files.reduce<{
				valid: File[];
				invalid: File[];
			}>(
				(acc, file) => {
					const isValid =
						file.type.startsWith('audio/') || file.type.startsWith('video/');
					acc[isValid ? 'valid' : 'invalid'].push(file);
					return acc;
				},
				{ valid: [], invalid: [] },
			);

			if (validFiles.length === 0) {
				return DbServiceErr({
					message: 'No valid audio or video files found.',
					context: { providedFiles: files.length },
					cause: undefined,
				});
			}

			if (invalidFiles.length > 0) {
				notify.warning.execute({
					title: '⚠️ Some files were skipped',
					description: `${invalidFiles.length} file(s) were not audio or video files`,
				});
			}

			// Process all valid files in parallel
			await Promise.all(
				validFiles.map(async (file) => {
					const arrayBuffer = await file.arrayBuffer();
					const audioBlob = new Blob([arrayBuffer], { type: file.type });

					// Log file upload event
					rpc.analytics.logEvent.execute({
						type: 'file_uploaded',
						blob_size: audioBlob.size,
					});

					// Each file gets its own toast notification
					const toastId = nanoid();
					await processRecordingPipeline({
						blob: audioBlob,
						toastId,
						completionTitle: '📁 File uploaded successfully!',
						completionDescription: file.name,
					});
				}),
			);

			return Ok({
				processedCount: validFiles.length,
				skippedCount: invalidFiles.length,
			});
		},
	}),

	// Open transformation picker to select a transformation
	openTransformationPicker: defineMutation({
		mutationKey: ['commands', 'openTransformationPicker'] as const,
		resultMutationFn: async () => {
			await transformClipboardWindow.toggle();
			return Ok(undefined);
		},
	}),

	// Run selected transformation on clipboard
	runTransformationOnClipboard: defineMutation({
		mutationKey: ['commands', 'runTransformationOnClipboard'] as const,
		resultMutationFn: async () => {
			// Get selected transformation from settings
			const transformationId =
				settings.value['transformations.selectedTransformationId'];

			if (!transformationId) {
				return WhisperingErr({
					title: '⚠️ No transformation selected',
					description: 'Please select a transformation in settings first.',
					action: {
						type: 'link',
						label: 'Select a transformation',
						href: '/transformations',
					},
				});
			}

			// Get the transformation
			const { data: transformation, error: getTransformationError } =
				await db.transformations.getById(() => transformationId).fetch();

			if (getTransformationError) {
				return Err(
					fromTaggedError(getTransformationError, {
						title: '❌ Failed to get transformation',
						action: { type: 'more-details', error: getTransformationError },
					}),
				);
			}

			if (!transformation) {
				settings.updateKey('transformations.selectedTransformationId', null);
				return WhisperingErr({
					title: '⚠️ Transformation not found',
					description:
						'The selected transformation no longer exists. Please select a different one.',
					action: {
						type: 'link',
						label: 'Select a transformation',
						href: '/transformations',
					},
				});
			}

			// Read clipboard text
			const { data: clipboardText, error: readClipboardError } =
				await text.readFromClipboard.fetch();

			if (readClipboardError) {
				return Err(
					fromTaggedError(readClipboardError, {
						title: '❌ Failed to read clipboard',
						action: { type: 'more-details', error: readClipboardError },
					}),
				);
			}

			if (!clipboardText?.trim()) {
				return WhisperingErr({
					title: '📋 Empty clipboard',
					description: 'Please copy some text before running a transformation.',
				});
			}

			// Run transformation
			const toastId = nanoid();
			notify.loading.execute({
				id: toastId,
				title: '🔄 Running transformation...',
				description: 'Transforming your clipboard text...',
			});

			const { data: output, error: transformError } =
				await transformer.transformInput.execute({
					input: clipboardText,
					transformation,
				});

			if (transformError) {
				notify.error.execute({ id: toastId, ...transformError });
				return Ok(undefined);
			}

			sound.playSoundIfEnabled.execute('transformationComplete');

			await delivery.deliverTransformationResult.execute({
				text: output,
				toastId,
			});

			return Ok(undefined);
		},
		onError: (error) => {
			notify.error.execute(error);
		},
	}),
};

/**
 * Processes a recording through the full pipeline: save → transcribe → transform
 *
 * This function handles the complete flow from recording creation through transcription:
 * 1. Creates recording metadata and saves to database
 * 2. Handles database save errors
 * 3. Shows completion toast
 * 4. Executes transcription flow
 * 5. Applies transformation if one is selected
 *
 * @param recordingId - Optional recording ID. When provided (e.g., from CPAL recorder),
 * the ID was generated earlier in the pipeline and is passed through for consistency.
 * When omitted (e.g., VAD recording, file uploads), a new ID is generated here using nanoid().
 * This flexibility allows different recording methods to control ID generation at the
 * appropriate point in their respective pipelines.
 */
async function processRecordingPipeline({
	blob,
	recordingId,
	toastId,
	completionTitle,
	completionDescription,
}: {
	blob: Blob;
	recordingId?: string;
	toastId: string;
	completionTitle: string;
	completionDescription: string;
}) {
	const now = new Date().toISOString();
	const newRecordingId = recordingId ?? nanoid();

	const recording = {
		id: newRecordingId,
		title: '',
		subtitle: '',
		timestamp: now,
		createdAt: now,
		updatedAt: now,
		transcribedText: '',
		transcriptionStatus: 'UNPROCESSED',
	} as const;

	const { error: createRecordingError } = await db.recordings.create.execute({
		recording,
		audio: blob,
	});

	if (createRecordingError) {
		notify.error.execute({
			id: toastId,
			title:
				'❌ Your recording was captured but could not be saved to the database.',
			description: createRecordingError.message,
			action: { type: 'more-details', error: createRecordingError },
		});
		return;
	}

	notify.success.execute({
		id: toastId,
		title: completionTitle,
		description: completionDescription,
	});

	const transcribeToastId = nanoid();
	notify.loading.execute({
		id: transcribeToastId,
		title: '📋 Transcribing...',
		description: 'Your recording is being transcribed...',
	});

	const { data: transcribedText, error: transcribeError } =
		await transcription.transcribeRecording.execute(recording);

	if (transcribeError) {
		if (transcribeError.name === 'WhisperingError') {
			notify.error.execute({ id: transcribeToastId, ...transcribeError });
			return;
		}
		notify.error.execute({
			id: transcribeToastId,
			title: '❌ Failed to transcribe recording',
			description: 'Your recording could not be transcribed.',
			action: { type: 'more-details', error: transcribeError },
		});
		return;
	}

	sound.playSoundIfEnabled.execute('transcriptionComplete');

	await delivery.deliverTranscriptionResult.execute({
		text: transcribedText,
		toastId: transcribeToastId,
	});

	// Determine if we need to chain to transformation
	const transformationId =
		settings.value['transformations.selectedTransformationId'];

	// Check if transformation is valid if specified
	if (!transformationId) return;
	const { data: transformation, error: getTransformationError } =
		await db.transformations.getById(() => transformationId).fetch();

	const transformationNoLongerExists = !transformation;

	if (getTransformationError) {
		notify.error.execute(
			fromTaggedError(getTransformationError, {
				title: '❌ Failed to get transformation',
				action: { type: 'more-details', error: getTransformationError },
			}),
		);
		return;
	}

	if (transformationNoLongerExists) {
		settings.updateKey('transformations.selectedTransformationId', null);
		notify.warning.execute({
			title: '⚠️ No matching transformation found',
			description:
				'No matching transformation found. Please select a different transformation.',
			action: {
				type: 'link',
				label: 'Select a different transformation',
				href: '/transformations',
			},
		});
		return;
	}

	const transformToastId = nanoid();
	notify.loading.execute({
		id: transformToastId,
		title: '🔄 Running transformation...',
		description:
			'Applying your selected transformation to the transcribed text...',
	});
	const { data: transformationRun, error: transformError } =
		await transformer.transformRecording.execute({
			recordingId: recording.id,
			transformation,
		});
	if (transformError) {
		notify.error.execute({ id: transformToastId, ...transformError });
		return;
	}

	if (transformationRun.status === 'failed') {
		notify.error.execute({
			id: transformToastId,
			title: '⚠️ Transformation error',
			description: transformationRun.error,
			action: { type: 'more-details', error: transformationRun.error },
		});
		return;
	}

	sound.playSoundIfEnabled.execute('transformationComplete');

	await delivery.deliverTransformationResult.execute({
		text: transformationRun.output,
		toastId: transformToastId,
	});
}
