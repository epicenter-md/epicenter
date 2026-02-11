---
name: social-media
description: Social media post guidelines for LinkedIn, Reddit, and Twitter/X. Use when drafting posts, announcements, or sharing technical content on social platforms.
---

# Social Media Post Guidelines

Follow [writing-voice](../writing-voice/SKILL.md) for tone.

## Platform-Specific Brevity

- **LinkedIn**: 3-5 lines max. State the feature, drop the link, done.
- **Twitter/X**: Each tweet should have ONE idea. Don't overexplain.
- **Reddit technical subs**: Focus on implementation details, not benefits

## What to Remove

- All hashtags except when platform culture expects them
- Section headers in post content ("## Implementation", "## Benefits")
- Bullet lists of features/benefits
- Marketing phrases ("game-changing", "seamless", "powerful")
- Call-to-action phrases ("See it in action!", "Try it today!")
- Redundant adjectives ("excellent", "really")

## What to Add

- Specific technical details that developers care about
- Actual implementation challenges and solutions
- Links to relevant libraries/APIs used
- One unique feature detail ("with your model of choice")
- Disclaimers when recommending tools ("Not affiliated, it just...")
- Personal standards/opinions ("by my standards", "slated for cleanup")
- Formal transitions with proper punctuation (semicolons, periods)
- Include disclaimers when praising external tools
- Use more precise language ("functionality" vs just "function")

## Examples: LinkedIn Posts

### Good (Actual Human Post)

```
Whispering now supports direct file uploads!

Simply drag and drop (or click to browse) your audio files for instant transcription, with your model of choice.

Free open-source app: https://github.com/EpicenterHQ/epicenter
```

### Bad (AI-Generated Feel)

```
Excited to announce that Whispering now supports direct file uploads!

This game-changing feature allows you to:
- Drag and drop any audio/video file
- Get instant, accurate transcriptions
- Save time and boost productivity

Built with the same philosophy of transparency and user control, you pay only actual API costs (just 2c/hour!) with no hidden fees or subscriptions.

Ready to revolutionize your workflow? Try it now!

GitHub: https://github.com/EpicenterHQ/epicenter

#OpenSource #Productivity #Innovation #DeveloperTools #Transcription
```

## Examples: Reddit Technical Posts

### Good (Focused on Implementation)

````
Hey r/sveltejs! Just shipped a file upload feature for Whispering and wanted to share how I implemented drag-and-drop files.

I used the [FileDropZone component from shadcn-svelte-extras](https://www.shadcn-svelte-extras.com/components/file-drop-zone), which provided a clean abstraction that allows users to drop and click to upload files:

```svelte
<FileDropZone
  accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
  maxFiles={10}
  maxFileSize={25 * MEGABYTE}
  onUpload={(files) => {
    if (files.length > 0) {
      handleFileUpload(files);
    }
  }}
/>
```

The component handles web drag-and-drop, but since Whispering is a Tauri desktop app, drag-and-drop functionality didn't work on the desktop (click-to-select still worked fine). So I reached for Tauri's [onDragDropEvent](https://tauri.app/reference/javascript/api/namespacewebviewwindow/#ondragdropevent) to add native support for dragging files anywhere into the application.

You can see the [full implementation here](link) (note that the code is still somewhat messy by my standards; it is slated for cleanup!).

Whispering is a large, open-source, production Svelte 5 + Tauri app: https://github.com/EpicenterHQ/epicenter

Feel free to check it out for more patterns! If you're building Svelte 5 apps and need file uploads, definitely check out shadcn-svelte-extras. Not affiliated, it just saved me hours of implementation time.

Happy to answer any questions about the implementation!
````

### Bad (Marketing-Focused)

```
## The Problem
Users were asking for file upload support...

## The Solution
I implemented a beautiful drag-and-drop interface...

## Key Benefits
- User-friendly interface
- Supports multiple file formats
- Lightning-fast processing

## Why This Matters
This transforms the user experience...
```
