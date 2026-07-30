# Runtime Dependency Injection

This reference covers dynamic implementation selection from app settings or
platform capability.

## The Consuming Edge Chooses

Services stay free of app-owned settings. The operation or state module reads
settings and platform capability, chooses the implementation, and passes the
service explicit inputs. `$lib/queries` only selects a service when the adapter
directly owns the whole use case.

Whispering's transcription operation owns the current provider dispatch:

```typescript
export async function transcribeAudio(
	recordingId: string,
): Promise<Result<string, TranscriptionError>> {
	const selectedService = settings.get('transcription.service');

	return isOnDeviceProviderId(selectedService)
		? transcribeOnDevice(recordingId, selectedService)
		: transcribeViaUpload(recordingId, selectedService);
}
```

The upload branch uses a total `Record<UploadProviderId, UploadDispatch>` so a
new provider is a compile error until it has a dispatch entry. Each entry closes
over the exact settings, credentials, endpoint, transport, or provider client it
needs. The query layer observes the operation through
`queries.transcription.transcribeRecording`; it does not reimplement provider
selection.

## Ownership Check

- App settings and device configuration: operation or state owner.
- Platform implementation: `#platform/*` build-time seam where one exists.
- Provider routing: one exhaustive dispatch table or switch at the consuming edge.
- Cache identity and lifecycle observation: query layer.
- User presentation: component or report-owning operation.

Do not reintroduce removed service registries or runtime platform checks merely
to make the query layer choose between implementations.
