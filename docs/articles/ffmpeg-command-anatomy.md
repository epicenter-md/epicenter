# The Anatomy of an FFmpeg Command: Why Three Parts Beat One Template

I was building FFmpeg recording into Whispering when I hit an interesting design decision. Originally, I was going to let users customize the entire FFmpeg command through a single template string. Something like:

```bash
ffmpeg -f avfoundation -i ":{{device}}" -acodec pcm_s16le -ar 16000 "{{outputFolder}}/{{recordingId}}.wav"
```

But then I realized: this was both too much and not enough control.

## The Problem with Template Strings

Here's what I mean. Users wanted to customize their FFmpeg settings, but certain parts HAD to remain under application control:
- The device name (selected from a dropdown)
- The output path (managed by the app)
- The recording ID (generated uniquely each time)

So I had this awkward template with placeholders. Users could edit around them, but not touch them. It felt wrong.

## The Three-Layer Solution

Then it clicked: an FFmpeg command isn't one monolithic thing. It's three distinct layers:

```bash
ffmpeg [GLOBAL] [INPUT] -i device [OUTPUT] path
```

Each layer has a different purpose:

### 1. Global Options: The Personality
These options affect FFmpeg's overall behavior:
- `-hide_banner` - Skip the copyright notice
- `-loglevel warning` - Only show warnings and errors
- `-stats` - Show encoding progress

Think of these as FFmpeg's personality settings. Chatty or quiet? Verbose or minimal?

### 2. Input Options: The Capture Method
These control HOW audio gets captured from your device:
- `-f avfoundation` - Use macOS's audio system
- `-ac 1` - Capture in mono
- `-t 60` - Record for maximum 60 seconds

This is about the source: what format, what quality, what constraints.

### 3. Output Options: The Final Product
These determine what kind of file you get:
- `-acodec libmp3lame` - Encode as MP3
- `-ar 44100` - 44.1kHz sample rate
- `-b:a 192k` - 192 kbps bitrate

This is about the destination: compression, quality, file format.

## Why This Split Matters

By separating the command into three fields instead of one template, several things became clearer:

**1. Users understand what they're changing**
Instead of editing a cryptic command string, they're adjusting three focused areas. Want better quality? That's output options. Need lower latency? Check input options.

**2. The app maintains control where needed**
The device and output path aren't templates anymore; they're inserted at known positions. No more `{{placeholders}}` to work around.

**3. Platform differences become manageable**
Different platforms need different input formats (`-f avfoundation` vs `-f dshow`). With separated options, we can provide smart defaults while still allowing overrides.

## The Implementation

In practice, this looks like three simple text fields:

```javascript
// Instead of one template string:
commandTemplate: "ffmpeg -f avfoundation -i \":{{device}}\" -acodec pcm_s16le..."

// We have three focused options:
globalOptions: "-hide_banner -loglevel warning"
inputOptions: "-f avfoundation"  // or empty for auto-detect
outputOptions: "-acodec libmp3lame -ar 44100 -b:a 192k"
```

When recording starts, we assemble them:

```javascript
const command = [
  'ffmpeg',
  globalOptions,
  inputOptions,
  '-i', deviceName,  // App controls this
  outputOptions,
  outputPath         // App controls this
].filter(Boolean).join(' ');
```

## The Lesson

Sometimes the best interface isn't the most flexible one. By breaking the FFmpeg command into its natural layers, we gave users better control with less complexity. They can customize what matters without touching what shouldn't change.

The irony? By offering "less" customization (three fields instead of a full template), we actually made the system more powerful. Users can now understand what they're changing, and the app can provide better defaults and platform-specific help.

That's the anatomy of an FFmpeg command: not one big string, but three distinct layers, each with its own job to do.