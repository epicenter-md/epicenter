# Enumerating All Extensions for a MIME Category

I needed to find audio files by ID, but they could be saved with any extension: `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`. My first instinct was to hardcode a list:

```typescript
const extensions = ['.wav', '.opus', '.mp3', '.ogg'];
```

Then a user dragged an m4a file and it broke. iOS Voice Memos use m4a. I'd missed it.

## The Problem with Hardcoding

Every time a new format comes up, you have to remember to update the list. Miss one and users hit cryptic errors. It's a maintenance burden that grows over time.

## Using mime v4's Public API

The `mime` package (v4+) has `getAllExtensions(type)` which returns all extensions for a MIME type:

```typescript
import mime from 'mime';

mime.getAllExtensions('audio/mpeg');
// Set { 'mpga', 'mp2', 'mp2a', 'mp3', 'm2a', 'm3a' }

mime.getAllExtensions('audio/mp4');
// Set { 'm4a', 'mp4a', 'm4b' }
```

But what if you want all audio extensions? You need to know every audio MIME type first.

## Enumerating All MIME Types

The `mime` package exports its type definitions as plain objects:

```typescript
import standardTypes from 'mime/types/standard.js';
import otherTypes from 'mime/types/other.js';

// These are objects: { 'audio/mpeg': ['mpga', 'mp2', ...], ... }
const allTypes = { ...standardTypes, ...otherTypes };

// Get all MIME types
Object.keys(allTypes);
// ['application/json', 'audio/mpeg', 'video/mp4', ...]
```

## Getting All Audio/Video Extensions

Combine both approaches:

```typescript
import mime from 'mime';
import standardTypes from 'mime/types/standard.js';
import otherTypes from 'mime/types/other.js';

const AUDIO_VIDEO_MIME_TYPES = Object.keys({ ...standardTypes, ...otherTypes })
  .filter(type => type.startsWith('audio/') || type.startsWith('video/'));

const SUPPORTED_EXTENSIONS = AUDIO_VIDEO_MIME_TYPES.flatMap(
  type => [...(mime.getAllExtensions(type) ?? [])]
);

// 124 extensions: ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'webm', 'mp4', 'mov', ...]
```

Now my file lookup checks all 124 audio/video extensions instead of 4 hardcoded ones.

## Why Two Imports?

- `standardTypes`: IANA-registered types (the official ones)
- `otherTypes`: Vendor and unofficial types (`x-*`, `vnd.*`, etc.)

For comprehensive coverage, merge both. For stricter validation, use only `standardTypes`.

## The Lesson

The `mime` package isn't just for `getType()` and `getExtension()`. Its type definition exports let you enumerate all registered MIME types, which is useful whenever you need to support "all audio formats" or "all video formats" without maintaining a list yourself.

## Reference

See the implementation: [PR #1051](https://github.com/EpicenterHQ/epicenter/pull/1051)
