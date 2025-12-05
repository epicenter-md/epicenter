# Why I Stopped Rolling My Own MIME Type Utilities

I was building a MIME type module from scratch. Extension to MIME type mapping, reverse lookups, browser aliases for quirky MIME types like `audio/wave`. About 60 mappings, two utility functions, felt clean.

Then I looked at the `mime` npm package.

## The Reality Check

The `mime` package is the de facto standard. Millions of weekly downloads. Zero external dependencies. Works in both browser and Node.js. And it has 800+ MIME types compared to my 60.

More importantly: it's actively maintained by someone who's been doing this for years. Every edge case I might hit, they've probably already handled.

## The Decision

I'm using `mime` instead of my custom implementation.

```typescript
import mime from 'mime';

mime.getType('mp3');           // 'audio/mpeg'
mime.getExtension('audio/wav'); // 'wav'
```

The library also offers `mime/lite` which only includes standard IANA-registered types (no vendor-specific ones like `application/vnd.ms-excel`). For a transcription app dealing primarily with audio files, either works since all common audio formats (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `audio/mp4`, `audio/aac`, `audio/flac`, `audio/opus`) are standard types.

## Why This Matters

Zero dependencies means minimal attack surface. No supply chain risk from transitive dependencies I can't audit. The package does one thing well and has been battle-tested across millions of projects.

Sometimes the right engineering decision is recognizing when someone else has already solved your problem better than you would.

## Reference

See the implementation: [PR #1047](https://github.com/EpicenterHQ/epicenter/pull/1047)
