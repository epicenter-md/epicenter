import { tauri } from '#platform/tauri';
import { outputWritesToCursor } from '$lib/operations/delivery';

/**
 * Tell Rust whether delivery writes at the cursor. Cursor delivery uses a
 * synthetic Cmd/Ctrl+V; on macOS the supervisor holds a passive tap to verify
 * that Accessibility can deliver it and surface the notice when the grant is
 * missing or stale. `outputWritesToCursor` is the single source of truth shared
 * with `delivery.ts`; reading it inside the `$effect` keeps the push live as the
 * output toggles change. Desktop only.
 *
 * The `$effect` is owned by the mounting component's lifecycle, so it disposes
 * with the runtime; the returned cleanup is a no-op.
 */
export function attachAutoPasteIntent() {
	if (!tauri) return () => {};
	const t = tauri;

	$effect(() => {
		void t.keyboard.setAutoPasteEnabled(outputWritesToCursor());
	});

	return () => {};
}
