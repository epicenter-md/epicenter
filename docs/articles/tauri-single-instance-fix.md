# Running Dev and Production Tauri Apps Simultaneously

I hit a frustrating issue today: I had my production Whispering app open, and when I tried to run the dev version with `tauri dev`, it just focused the production window instead of opening a new dev instance.

I want to use the production version of Whispering while developing the dev version of Whispering.

The culprit? Tauri's single-instance plugin treats both builds as the same app because they share the same bundle identifier.

## The Fix

Override the identifier for your dev builds using the `--config` flag:

```bash
tauri dev --config '{"identifier": "com.whispering.app.dev"}'
```

That's it. Now your dev and production apps can run side by side.

## Why This Works

Tauri uses the bundle identifier to determine if an app instance is already running. By giving your dev build a different identifier (notice the `.dev` suffix), the single-instance plugin sees them as separate apps.

The `--config` flag uses JSON Merge Patch (RFC 7396), which means it only overwrites the specific property you specify. All your other bundle settings (name, version, resources) stay intact.

## Making It Permanent

Update your dev script in `apps/whispering/package.json`:

```json
{
  "scripts": {
    "dev": "bun tauri dev --config '{\"identifier\": \"com.bradenwong.whispering.dev\"}'",
    "build": "NODE_ENV=production vite build"
  }
}
```

Now `bun dev` will automatically use the dev identifier.

Or use the Rust approach if you prefer compile-time configuration:

```rust
fn main() {
    let mut context = tauri::generate_context!();

    #[cfg(debug_assertions)]
    {
        context.config_mut().identifier = "com.whispering.app.dev".to_string();
    }

    tauri::Builder::default()
        .run(context)
        .expect("error running tauri app");
}
```

## Related

There's an [open feature request](https://github.com/tauri-apps/tauri/issues/8418) for environment-specific config files (like `tauri.dev.conf.json`), but until that's implemented, this is the recommended approach.

The lesson: single-instance behavior is controlled by bundle identifiers. Different identifiers means different apps.
