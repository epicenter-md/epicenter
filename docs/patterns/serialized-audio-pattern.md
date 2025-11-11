# SerializedAudio Pattern

## The Problem

You're building a web app that needs to store audio recordings in IndexedDB. Works great on Chrome, Firefox, Edge... but then you test on iOS Safari and things start breaking.

iOS Safari has serious issues with storing `Blob` objects directly in IndexedDB. The symptoms vary:
- Storage operations fail silently
- Blobs get corrupted or become unreadable
- Data disappears after closing the browser
- Sometimes it works, sometimes it doesn't

This makes it impossible to build a reliable audio storage system if you store Blobs directly. You need a different approach.

## The Solution: Deconstruct the Blob

Instead of storing the `Blob` directly, we "serialize" it by breaking it apart into pieces that IndexedDB can handle reliably on all platforms:

```typescript
type SerializedAudio = {
  arrayBuffer: ArrayBuffer;  // The raw audio data
  blobType: string;         // The MIME type (e.g., 'audio/webm')
}
```

Think of it like disassembling a package for shipping. The `Blob` is the assembled package, but for reliable storage, we break it down into:
1. The actual audio data (`arrayBuffer`)
2. The format information (`blobType`)

These primitive types can be stored reliably in IndexedDB on every platform, including iOS Safari.

## How It Works

### Converting Blob to SerializedAudio

When you get a `Blob` from the MediaRecorder or file upload, convert it before storing:

```typescript
async function serializeBlob(blob: Blob): Promise<SerializedAudio> {
  const arrayBuffer = await blob.arrayBuffer();
  return {
    arrayBuffer,
    blobType: blob.type
  };
}
```

### Converting SerializedAudio back to Blob

When you need to use the audio (play it, download it, transcribe it), reconstruct the Blob:

```typescript
function deserializeToBlob(serializedAudio: SerializedAudio): Blob {
  const { arrayBuffer, blobType } = serializedAudio;
  return new Blob([arrayBuffer], { type: blobType });
}
```

That's it. No complex ceremony, just a straightforward conversion.

## Implementation in Whispering

In the Whispering codebase, this pattern lives in the database layer. Here's how we use it:

### Database Schema

The database stores recordings with serialized audio instead of raw blobs:

```typescript
export type Recording = {
  id: string;
  title: string;
  // ... other fields
  blob: Blob | undefined;  // Used in application code
};

export type RecordingsDbSchemaV5 = {
  recordings: Omit<Recording, 'blob'> & {
    serializedAudio: { arrayBuffer: ArrayBuffer; blobType: string } | undefined;
  };
};
```

Notice the pattern: application code works with `Blob` objects, but the database stores `serializedAudio`.

### Storing a Recording

Before saving to IndexedDB, convert the Blob:

```typescript
const recordingToRecordingWithSerializedAudio = async (
  recording: Recording,
): Promise<RecordingsDbSchemaV5['recordings']> => {
  const { blob, ...rest } = recording;
  if (!blob) return { ...rest, serializedAudio: undefined };

  const arrayBuffer = await blob.arrayBuffer();
  return {
    ...rest,
    serializedAudio: { arrayBuffer, blobType: blob.type }
  };
};

// Then store it
await db.recordings.add(await recordingToRecordingWithSerializedAudio(recording));
```

### Retrieving a Recording

When reading from IndexedDB, convert back to a Blob:

```typescript
const recordingWithSerializedAudioToRecording = (
  recording: RecordingsDbSchemaV5['recordings'],
): Recording => {
  const { serializedAudio, ...rest } = recording;
  if (!serializedAudio) return { ...rest, blob: undefined };

  const { arrayBuffer, blobType } = serializedAudio;
  const blob = new Blob([arrayBuffer], { type: blobType });

  return { ...rest, blob };
};

// Reading from database
const dbRecording = await db.recordings.get(id);
const recording = recordingWithSerializedAudioToRecording(dbRecording);
```

## Why This Works

The key insight is that `ArrayBuffer` and strings (the MIME type) are primitive types that IndexedDB handles consistently across all browsers. Blobs, on the other hand, are complex objects that WebKit's IndexedDB implementation struggles with.

By converting to primitives before storage and reconstructing on retrieval, we get:
- **Reliability**: Works consistently on all platforms
- **Simplicity**: Clean separation between storage and application layers
- **Transparency**: Application code still works with familiar `Blob` objects

## When to Use This Pattern

Use the SerializedAudio pattern when:

1. **Storing binary data in IndexedDB** and you need iOS Safari support
2. **Working with audio or video files** that come from MediaRecorder or file uploads
3. **Building a cross-platform web app** that needs reliable offline storage
4. **You've encountered blob storage issues** on iOS Safari

## The Lesson

Not every API works the same way across browsers. Sometimes the "obvious" approach (storing Blobs directly) doesn't work everywhere. When you hit platform-specific limitations, look for a translation layer.

In this case, we're not fixing iOS Safari's IndexedDB implementation. We're working around it by translating to a format that works reliably everywhere. The application code stays clean, and the storage layer handles the platform differences.
