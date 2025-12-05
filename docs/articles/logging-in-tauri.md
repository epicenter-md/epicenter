# Logging in Tauri Applications

I added console.log() in my Tauri app and... nothing. Where did it go?

Here's the thing: Tauri has two separate logging layers, and they output to completely different places. Understanding this will save you hours of debugging frustration.

Your Rust code (the backend) logs to one place, and your TypeScript code (the frontend) logs to another. When you use println!() or eprintln!() in a Tauri command, those logs appear in the terminal where you ran your dev server. If you're running `pnpm tauri dev` or `npm run tauri dev`, look at that terminal window. That's where your Rust logs live.

```rust
#[tauri::command]
fn process_file(path: String) {
    println!("Processing file: {}", path);  // Shows in terminal
}
```

Your TypeScript or JavaScript logs work differently. When you call console.log(), those logs appear in the browser dev tools console. Right-click your app window, select "Inspect Element", and open the Console tab. Your Tauri app's frontend runs in a webview, which is essentially a browser. So the dev tools work exactly like they do in Chrome or Firefox.

```typescript
async function handleUpload(file: File) {
    console.log("Uploading file:", file.name);  // Shows in dev tools
    await invoke("process_file", { path: file.path });
}
```

Why this split? Tauri is a hybrid architecture. Rust handles backend operations (file system access, process spawning, native APIs), while TypeScript handles the UI. They're separate processes that communicate across an FFI boundary using invoke calls. Each process has its own logging destination.

When debugging a Tauri command that spans both layers, keep both consoles open: your terminal for the Rust side and the browser dev tools for the TypeScript side. This lets you trace the entire flow of an invoke call from frontend request to backend processing and back. You'll often find that your frontend logs the request successfully, but the backend is where the error actually occurs (or vice versa).
