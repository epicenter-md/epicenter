import { fromTaggedError } from '$lib/result';
import { DbServiceErr } from '$lib/services/db';
import { settings } from '$lib/stores/settings.svelte';
import { nanoid } from 'nanoid/non-secure';
import { Err, Ok } from 'wellcrafted/result';
import { defineMutation } from './_client';
import { delivery } from './delivery';
import { recorder } from './recorder';
import { notify } from './notify';
import { recordings } from './recordings';
import { sound } from './sound';
import { transcription } from './transcription';
import { transformations } from './transformations';
import { transformer } from './transformer';
import { vadRecorder } from './vad-recorder';
import { rpc } from './';
import { media } from './media';

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
		// Pause media before starting recording
		await media.pauseIfEnabled.execute(undefined);
		
		const { data: deviceAcquisitionOutcome, error: startRecordingError } =
			await recorder.startRecording.execute({ toastId });

		if (startRecordingError) {
			notify.error.execute({ id: toastId, ...startRecordingError });
			return Err(startRecordingError);
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
		const { data: blob, error: stopRecordingError } =
			await recorder.stopRecording.execute({ toastId });
		
		// Resume media after stopping recording
		await media.resumePaused.execute(undefined);
		if (stopRecordingError) {
			notify.error.execute({ id: toastId, ...stopRecordingError });
			return Err(stopRecordingError);
		}

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
		// Pause media before starting VAD
		await media.pauseIfEnabled.execute(undefined);
		
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
			return Err(startActiveListeningError);
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
					'recording.vad.selectedDeviceId',
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
		
		// Resume media after stopping VAD
		await media.resumePaused.execute(undefined);
		if (stopVadError) {
			notify.error.execute({ id: toastId, ...stopVadError });
			return Err(stopVadError);
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
				return Err(getRecorderStateError);
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
			
			// Resume media after canceling recording
			await media.resumePaused.execute(undefined);
			if (cancelRecordingError) {
				notify.error.execute({ id: toastId, ...cancelRecordingError });
				return Err(cancelRecordingError);
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
 */
async function processRecordingPipeline({
	blob,
	toastId,
	completionTitle,
	completionDescription,
}: {
	blob: Blob;
	toastId: string;
	completionTitle: string;
	completionDescription: string;
}) {
	const now = new Date().toISOString();
	const newRecordingId = nanoid();

	const { data: createdRecording, error: createRecordingError } =
		await recordings.createRecording.execute({
			id: newRecordingId,
			title: '',
			subtitle: '',
			createdAt: now,
			updatedAt: now,
			timestamp: now,
			transcribedText: '',
			blob,
			transcriptionStatus: 'UNPROCESSED',
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
		await transcription.transcribeRecording.execute(createdRecording);

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
		await transformations.queries
			.getTransformationById(() => transformationId)
			.fetch();

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
			recordingId: createdRecording.id,
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
