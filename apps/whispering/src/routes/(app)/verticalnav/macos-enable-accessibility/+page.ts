import * as services from '$lib/services';

export const load = async () => {
	const { data: isAccessibilityGranted } =
		await services.permissions.accessibility.check();

	return {
		isAccessibilityGranted: isAccessibilityGranted ?? false,
	};
};
