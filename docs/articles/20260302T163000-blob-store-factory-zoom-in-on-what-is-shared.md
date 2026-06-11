# Zoom In on What's Shared

I was designing a blob storage layer for audio files. Desktop stores them on the filesystem. Web stores them in IndexedDB. Both need the same operations: put a blob, get a blob, delete a blob, check if one exists. Classic dependency injection scenario. But the interesting part wasn't the shared interface. It was figuring out what NOT to put in it.

## The Setup

We have recordings. Each recording has metadata (title, transcription, timestamps) and an audio blob. The metadata goes into Yjs tables for sync. The audio blob stays local: too large for CRDT sync. So we need a separate blob storage layer, and it needs to work on two platforms:

- **Desktop**: Filesystem. Audio lives at `~/Library/Application Support/com.bradenwong.whispering/recordings/{id}.webm`
- **Web**: IndexedDB. Audio lives as a serialized `ArrayBuffer` + `blobType` string in a Dexie table row.

The shared operations are obvious:

```typescript
type BlobStore = {
  get(id: string): Promise<{ blob: Blob; mimeType: string } | null>;
  put(id: string, blob: Blob, mimeType: string): Promise<void>;
  delete(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
};
```

Simple. But here's where it gets interesting.

## The Temptation

My first instinct was to put the storage location into the method signatures. Something like:

```typescript
type BlobStore = {
  put(location: string, id: string, blob: Blob, mimeType: string): Promise<void>;
  get(location: string, id: string): Promise<{ blob: Blob; mimeType: string } | null>;
};
```

Where `location` would be... what, exactly? A folder path on desktop? A table name in IndexedDB? Already the abstraction is leaking.

You could try to make the argument generic. Call it `path`. But that's dishonest: IndexedDB doesn't have paths. You could call it `namespace`. But then on desktop you'd be mentally translating "namespace" to "folder" every time you read the code.

The worst version is a discriminated union:

```typescript
put(
  target:
    | { type: 'filesystem'; folder: string }
    | { type: 'indexeddb'; database: string; table: string },
  id: string,
  blob: Blob,
  mimeType: string,
): Promise<void>;
```

This completely destroys the point of having a shared interface. Now every call site has to know which platform it's on. You've dependency-injected nothing. You've just created a function that contains two implementations behind an `if` statement.

## The Insight: Zoom In

The solution is to stop trying to force platform-specific configuration into the shared interface. Instead, zoom in on only the parts that are genuinely shared, and push everything else into the factory functions.

```typescript
// The shared interface: no platform concepts at all
type BlobStore = {
  get(id: string): Promise<{ blob: Blob; mimeType: string } | null>;
  put(id: string, blob: Blob, mimeType: string): Promise<void>;
  delete(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
};
```

```typescript
// Desktop factory: takes a filesystem path
function createFileSystemBlobStore(basePath: string): BlobStore {
  return {
    async get(id) {
      // Read from {basePath}/{id}.{ext}
    },
    async put(id, blob, mimeType) {
      // Write to {basePath}/{id}.{ext}
    },
    async delete(id) {
      // Remove {basePath}/{id}.{ext}
    },
    async has(id) {
      // Check if {basePath}/{id}.* exists
    },
  };
}
```

```typescript
// Web factory: takes IndexedDB config
function createIndexedDbBlobStore(dbName: string): BlobStore {
  return {
    async get(id) {
      // Read from IndexedDB object store, deserialize ArrayBuffer → Blob
    },
    async put(id, blob, mimeType) {
      // Serialize Blob → { arrayBuffer, blobType }, write to IndexedDB
    },
    async delete(id) {
      // Remove from IndexedDB by key
    },
    async has(id) {
      // Check if key exists in IndexedDB
    },
  };
}
```

The filesystem factory takes a path because that's what filesystems care about. The IndexedDB factory takes a database name because that's what IndexedDB cares about. Neither concept appears in the shared interface because neither concept is shared.

## What This Gives You

The rest of the app just sees `BlobStore`. It never knows and never asks which platform it's on:

```typescript
// Some component or service: doesn't care about the platform
async function playRecording(blobStore: BlobStore, recordingId: string) {
  const audio = await blobStore.get(recordingId);
  if (!audio) {
    showMessage('Audio only available on the recording device');
    return;
  }
  const url = URL.createObjectURL(audio.blob);
  player.src = url;
}
```

Initialization happens once, at the top level, where you already know which platform you're on:

```typescript
// Desktop entry point
const blobStore = createFileSystemBlobStore(
  `${appDataDir}/recordings`
);

// Web entry point
const blobStore = createIndexedDbBlobStore('WhisperingAudioBlobs');
```

After that, `blobStore` flows through the app as a plain `BlobStore`. No generics, no discriminated unions, no platform checks at call sites.

## The General Principle

When two implementations share behavior but have different configuration needs, the instinct is to unify everything into one interface. Resist that. Instead:

1. Define the shared interface as the intersection of what both implementations actually do at call time.
2. Put all platform-specific configuration in the factory function that creates the implementation.
3. The factory's arguments are where the implementations diverge. The returned interface is where they converge.

A filesystem folder and an IndexedDB table are conceptually the same thing. A place to store blobs keyed by ID. But they're configured differently, named differently, and initialized differently. The factory function is where you acknowledge that difference. The returned interface is where you forget it.

## The Test

If your shared interface has an argument that would need a different name on each platform, it doesn't belong in the shared interface. Move it to the factory. Zoom in on what's actually shared, and let the factory handle the rest.