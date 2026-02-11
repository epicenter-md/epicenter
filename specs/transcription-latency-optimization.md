# Transcription Latency Optimization

## Problem

After recording stops, we have two latency bottlenecks:

1. **Sequential save → transcribe**: We wait for disk save to complete before starting transcription
2. **Unnecessary disk read**: Transcription reads the audio blob back from disk, even though we just had it in memory

```
Current flow:
Stop Recording → Save to Disk (200ms) → Read from Disk (50ms) → Transcribe (2000ms)
Total: 2250ms

Optimized flow:
Stop Recording → Save to Disk (200ms, background) ─┐
              → Transcribe from memory (2000ms) ───┴→ Done
Total: 2000ms
```

## Solution

Two changes:

1. Add `transcribeRecordingWithBlob()` that accepts the blob directly (skip disk read)
2. Run save and transcribe in parallel (don't await save before transcribing)

---

## Changes

### File 1: `apps/whispering/src/lib/query/isomorphic/transcription.ts`

**Add new mutation after `transcribeRecording` (around line 96):**

```typescript
/**
 * Transcribe a recording using an in-memory blob.
 * Use this when you already have the blob (e.g., right after recording stops).
 * Skips the disk read that transcribeRecording() does.
 */
transcribeRecordingWithBlob: defineMutation({
  mutationKey: transcriptionKeys.isTranscribing,
  mutationFn: async ({
    recording,
    blob,
  }: {
    recording: Recording;
    blob: Blob;
  }): Promise<Result<string, WhisperingError>> => {
    const { error: setRecordingTranscribingError } =
      await db.recordings.update({
        ...recording,
        transcriptionStatus: 'TRANSCRIBING',
      });
    if (setRecordingTranscribingError) {
      notify.warning({
        title:
          '⚠️ Unable to set recording transcription status to transcribing',
        description: 'Continuing with the transcription process...',
        action: {
          type: 'more-details',
          error: setRecordingTranscribingError,
        },
      });
    }

    const { data: transcribedText, error: transcribeError } =
      await transcribeBlob(blob);

    if (transcribeError) {
      await db.recordings.update({
        ...recording,
        transcriptionStatus: 'FAILED',
      });
      return Err(transcribeError);
    }

    const { error: setRecordingTranscribedTextError } =
      await db.recordings.update({
        ...recording,
        transcribedText,
        transcriptionStatus: 'DONE',
      });
    if (setRecordingTranscribedTextError) {
      notify.warning({
        title: '⚠️ Unable to update recording after transcription',
        description:
          "Transcription completed but unable to update recording's transcribed text and status in database",
        action: {
          type: 'more-details',
          error: setRecordingTranscribedTextError,
        },
      });
    }
    return Ok(transcribedText);
  },
}),
```

---

### File 2: `apps/whispering/src/lib/query/isomorphic/actions.ts`

**Replace `processRecordingPipeline` function (lines 604-755):**

```typescript
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

	// Start save in background (don't await yet)
	const savePromise = db.recordings.create({
		recording,
		audio: blob,
	});

	// Show success immediately (optimistic)
	notify.success({
		id: toastId,
		title: completionTitle,
		description: completionDescription,
	});

	// Start transcription with in-memory blob (don't wait for save)
	const transcribeToastId = nanoid();
	notify.loading({
		id: transcribeToastId,
		title: '📋 Transcribing...',
		description: 'Your recording is being transcribed...',
	});

	const { data: transcribedText, error: transcribeError } =
		await transcription.transcribeRecordingWithBlob({ recording, blob });

	// Now check save result
	const { error: createRecordingError } = await savePromise;

	if (createRecordingError) {
		notify.error({
			title: '⚠️ Recording could not be saved',
			description: createRecordingError.message,
			action: { type: 'more-details', error: createRecordingError },
		});
		// Continue - transcription may have succeeded
	}

	if (transcribeError) {
		if (transcribeError.name === 'WhisperingError') {
			notify.error({ id: transcribeToastId, ...transcribeError });
			return;
		}
		notify.error({
			id: transcribeToastId,
			title: '❌ Failed to transcribe recording',
			description: 'Your recording could not be transcribed.',
			action: { type: 'more-details', error: transcribeError },
		});
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');

	await delivery.deliverTranscriptionResult({
		text: transcribedText,
		toastId: transcribeToastId,
	});

	// Rest of transformation logic unchanged...
	const transformationId =
		settings.value['transformations.selectedTransformationId'];

	if (!transformationId) return;

	const { data: transformation, error: getTransformationError } =
		await db.transformations.getById(() => transformationId).fetch();

	if (getTransformationError) {
		notify.error({
			title: '❌ Failed to get transformation',
			description: getTransformationError.message,
			action: { type: 'more-details', error: getTransformationError },
		});
		return;
	}

	if (!transformation) {
		settings.updateKey('transformations.selectedTransformationId', null);
		notify.warning({
			title: '⚠️ No matching transformation found',
			description: 'Please select a different transformation.',
			action: {
				type: 'link',
				label: 'Select a different transformation',
				href: '/transformations',
			},
		});
		return;
	}

	const transformToastId = nanoid();
	notify.loading({
		id: transformToastId,
		title: '🔄 Running transformation...',
		description: 'Applying your selected transformation...',
	});

	const { data: transformationRun, error: transformError } =
		await transformer.transformRecording({
			recordingId: recording.id,
			transformation,
		});

	if (transformError) {
		notify.error({ id: transformToastId, ...transformError });
		return;
	}

	if (transformationRun.status === 'failed') {
		notify.error({
			id: transformToastId,
			title: '⚠️ Transformation error',
			description: transformationRun.error,
			action: { type: 'more-details', error: transformationRun.error },
		});
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	await delivery.deliverTransformationResult({
		text: transformationRun.output,
		toastId: transformToastId,
	});
}
```

---

## Summary

| Change                            | File               | What                                                |
| --------------------------------- | ------------------ | --------------------------------------------------- |
| Add `transcribeRecordingWithBlob` | `transcription.ts` | New mutation that takes blob directly               |
| Parallel save + transcribe        | `actions.ts`       | Fire save, immediately start transcribe, await both |

## Expected Latency Improvement

- **Before**: ~2250ms (save 200ms + read 50ms + transcribe 2000ms)
- **After**: ~2000ms (save runs in background during transcribe)
- **Savings**: ~250ms minimum, up to 500ms+ for larger files
