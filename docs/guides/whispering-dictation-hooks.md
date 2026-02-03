# Whispering: Local dictation hooks

You can run custom commands when you **start** and **stop** dictation (e.g. mute another app that uses the microphone, then unmute when you're done).

## Setup

1. Create `~/.epicenter/local.json` (create the `.epicenter` directory if needed).
2. Define one or more hooks in the `dictation_hooks` array.

Example config (copy to `~/.epicenter/local.json`):

```json
{
  "dictation_hooks": [
    {
      "name": "gather",
      "status_command": ["gather", "status", "--json"],
      "json_key": "muted",
      "do_toggle_when_value": false,
      "on_start_dictation": ["gather", "mute", "--json"],
      "on_stop_dictation": ["gather", "unmute", "--json"]
    }
  ]
}
```

## How it works

1. **When you start recording**  
   For each hook, Whispering runs `status_command` and reads JSON from stdout. It looks at the value at `json_key` (e.g. `muted`). If that value equals `do_toggle_when_value`, it runs `on_start_dictation` and remembers that this hook was toggled.

2. **When you stop recording**  
   For each hook that was toggled at start, Whispering runs `on_stop_dictation`.

So: if the app is currently **unmuted** (`muted` is `false`), we mute it when you start dictating and unmute it when you stop. If it's already muted, we do nothing.

## Field reference

| Field | Description |
|-------|-------------|
| `name` | Unique label for the hook (used when logging). |
| `debug` | Optional. If `true`, extra detail (status output, command stdout/stderr) is written to `~/.epicenter/dictation_hooks.log`. |
| `status_command` | List: program and args (e.g. `["gather", "status", "--json"]`). Must print JSON to stdout. |
| `json_key` | Key in that JSON to read (e.g. `"muted"`). |
| `do_toggle_when_value` | When the key has this value, we run start/stop commands. Can be a boolean or string (e.g. `false` or `"unmuted"`). In JSON you can use `do_toggle_key_value` as an alias. |
| `on_start_dictation` | List: program and args to run when recording starts (only if status matched). |
| `on_stop_dictation` | List: program and args to run when recording stops (only for hooks we toggled). |

## Example: Gather

Gather is an app that uses the microphone. To mute it while dictating and unmute when done:

- `gather status --json` returns e.g. `{"gather_running": true, "muted": false}`.
- When `muted` is `false`, we run `gather mute --json` on start and `gather unmute --json` on stop.

Config:

```json
{
  "dictation_hooks": [
    {
      "name": "gather",
      "status_command": ["gather", "status", "--json"],
      "json_key": "muted",
      "do_toggle_when_value": false,
      "on_start_dictation": ["gather", "mute", "--json"],
      "on_stop_dictation": ["gather", "unmute", "--json"]
    }
  ]
}
```

## Multiple hooks

You can define several hooks; each is evaluated independently. Add more entries under `dictation_hooks` for other apps or CLI tools.

## Debugging and logging

- **Log file**: Key events (start/stop invoked, which commands run, results) are appended to `~/.epicenter/dictation_hooks.log` (one line per event with a Unix timestamp). Use this to confirm whether unmute is being run and what the stored toggled list is.
- **Per-hook `debug`**: Set `"debug": true` on a hook to log extra detail for that hook: status command stdout/stderr and on_start/on_stop stdout/stderr.

## Notes

- Config is read from the user's home directory (`$HOME/.epicenter/local.json` on Unix, `%USERPROFILE%\.epicenter\local.json` on Windows).
- Hooks run only in the desktop app (Tauri); they are ignored in the web build.
- If the config file is missing or invalid, hooks are simply skipped (no error to the user).
- Commands are run with the same environment as the app (including `PATH`).
