const dictationCapability = {
	async requestAccess() {},
	async openAccessSettings() {
		return { data: undefined, error: undefined } as const;
	},
	get isActive() {
		return false;
	},
	get needsAccessibility() {
		return false;
	},
	get isStale() {
		return false;
	},
	get override() {
		return null;
	},
	cycleOverride() {},
	attach() {
		return () => {};
	},
};

export { dictationCapability };
