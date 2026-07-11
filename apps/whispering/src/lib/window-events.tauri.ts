import type { EventCallback } from '@tauri-apps/api/event';
import { emit, emitTo, listen } from '@tauri-apps/api/event';

/**
 * A typed channel for one window-to-window Tauri event that carries a payload.
 *
 * Tauri's raw `emit(name, payload)` / `listen<T>(name)` pair has no type link
 * from the event name to its payload: a listener's `T` is asserted by hand and
 * never checked against what the emitter actually sends. `defineWindowEvent`
 * binds the name and payload once across `emit`, `emitTo`, and `listen`, so
 * emitter and listener can't drift without a compile error. Use
 * `defineWindowSignal` for an event that carries nothing.
 *
 * Scope: frontend-to-frontend only (one webview window telling another to do
 * something). Events that cross the Rust boundary stay on the generated Specta
 * `events` (e.g. `dictationCapabilityEvent`), which are typed from the Rust
 * definitions. Don't route a window-to-window event through Rust just to borrow
 * Specta's types; Rust has no part in it.
 */
export function defineWindowEvent<T>(name: string) {
	return {
		emit: (payload: T) => emit(name, payload),
		emitTo: (label: string, payload: T) => emitTo(label, name, payload),
		listen: (handler: EventCallback<T>) => listen<T>(name, handler),
	};
}

/**
 * A window-to-window event that carries no payload, e.g. a child window's
 * mount handshake. Same name binding as `defineWindowEvent`, minus the payload.
 */
export function defineWindowSignal(name: string) {
	return {
		emit: () => emit(name),
		listen: (handler: () => void) => listen(name, handler),
	};
}
