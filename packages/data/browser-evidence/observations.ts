export function createObservationAccumulator() {
	const observed: string[] = [];
	return Object.freeze({
		append(batch: readonly string[]): readonly string[] {
			observed.push(...batch);
			return observed;
		},
	});
}
