# Stop Using Navigator.mediaDevices for Desktop Recording in Tauri Apps

I spent weeks debugging what I thought was a global shortcut issue in Whispering. Users were reporting that the keyboard shortcut to start recording would randomly fail. The shortcut would register (I could see it in the logs), but the recording wouldn't actually start.

My first instinct? The global shortcut plugin must be buggy. I was ready to write my own Rust implementation.

I was completely wrong.

## The Real Problem: App Nap vs MediaRecorder

Here's what was actually happening: when users triggered recording via global shortcut while Whispering was in the background, macOS's App Nap would throttle the JavaScript runtime. The `navigator.mediaDevices.getUserMedia()` call would get queued but wouldn't execute until the app regained focus.

The recording would eventually start. Just not when the user pressed the key. Imagine pressing your recording shortcut, speaking for 30 seconds, then realizing nothing was captured because the stream hadn't actually initialized yet.

## Why I Didn't Notice Sooner

The confusing part? Voice-activated recording worked perfectly fine. Why? Because users typically start VAD while the app is in focus. Once you have an active MediaStream, it keeps running in the background without issues. The problem only occurs when you try to *initialize* a new stream while backgrounded.

It's the difference between:
```javascript
// This works fine in background (stream already exists)
existingStream.getTracks()[0].enabled = true;

// This gets throttled by App Nap
navigator.mediaDevices.getUserMedia({ audio: true });
```

## The Navigator API Wasn't Built for Desktop

Here's the thing about `navigator.mediaDevices`: it was designed for web browsers where user interaction happens in the foreground. The entire security model assumes the user is actively interacting with a visible page.

When you shoehorn this into a desktop app with global shortcuts, you're fighting against the platform. App Nap is doing exactly what it's supposed to do. Throttling background JavaScript to save battery. It just happens to break our recording flow.

## The Solution: Go Native

Instead of fighting the platform, embrace it. I moved all recording logic to the Rust backend using CPAL (Cross-Platform Audio Library). Now the recording flow looks like this:

```rust
// Rust backend - runs regardless of app focus
#[tauri::command]
pub async fn start_recording(device: String, output_path: PathBuf) -> Result<()> {
    // Direct hardware access, no throttling
    let stream = device.build_input_stream(...);
    stream.play()?;
    // Recording starts immediately
}
```

The JavaScript frontend just triggers commands:
```javascript
// Frontend - just sends commands
await invoke('start_recording', { device, outputPath });
```

## Bonus: Progressive WAV Writing

Since I was rewriting the recorder anyway, I added progressive WAV writing. This means:

1. Audio data is written to disk as it's captured
2. WAV headers are updated in-place
3. If your app crashes, you still have a valid WAV file

With MediaRecorder, you'd lose everything if the app crashed before calling `stop()`. Now, worst case, you lose the last few milliseconds.

Here's the key insight: instead of accumulating audio in memory and writing at the end, we write continuously:

```rust
// In the audio callback
move |data: &[f32], _| {
    if is_recording.load(Ordering::Acquire) {
        // Write immediately to disk
        writer.write_samples_f32(data);
    }
}
```

## The Lesson

For desktop Tauri apps, don't use Navigator APIs for anything that needs to work in the background. These APIs were designed for web pages, not desktop applications. The impedance mismatch will cause subtle, platform-specific bugs that are painful to debug.

Specifically for recording:
- MediaRecorder works great for web deployments
- Use native implementations for desktop
- Progressive file writing prevents data loss
- Platform-specific quirks (like App Nap) disappear when you go native

I wasted weeks thinking I had a global shortcut problem. The shortcuts were fine. They were implemented in Rust and worked perfectly. The issue was trying to use web APIs in a context they weren't designed for.

If you're building a Tauri app with recording features, learn from my mistake: implement recording in Rust from day one. Your users (and your future self) will thank you.