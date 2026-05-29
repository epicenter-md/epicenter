import { toast } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import { goto } from '$app/navigation';
import { IS_MACOS } from '$lib/constants/platform';
import { tauri } from '$lib/tauri';

export function registerAccessibilityPermission() {
	// Only run on macOS desktop
	if (!IS_MACOS || !tauri) return;

	const accessibilityToastId = nanoid();

	// Check accessibility permission once on mount
	(async () => {
		const { data: isAccessibilityGranted, error } =
			await tauri.permissions.accessibility.check();

		if (error) {
			console.error('Failed to check accessibility permissions:', error);
			return;
		}

		if (!isAccessibilityGranted) {
			// Toast if permission not granted
			toast.warning('Accessibility Permission Issue', {
				id: accessibilityToastId,
				description:
					'Whispering needs accessibility permissions. This often requires removing and re-adding the app after updates.',
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: 'View Guide',
					onClick: () => {
						goto('/macos-enable-accessibility');
						// Dismiss the toast
						toast.dismiss(accessibilityToastId);
					},
				},
			});
		}
	})();

	// Return cleanup function
	return () => {
		toast.dismiss(accessibilityToastId);
	};
}
