/**
 * An ingestor is responsible to parsing one or more input files into a normalized
 * payload that can be validated and upserted by an Adapter. This is completely separate
 * from the vault import/export lifecycle.
 */
export type Ingestor<TShape = unknown> = {
	/** Return true if this ingestor can handle the provided files */
	matches(file: File): boolean;
	/** Parse files into a normalized payload expected by validator/upsert */
	parse(file: File): Promise<TShape>;
};

/**
 * Define an Ingestor with full type inference.
 *
 * @param ingestor The ingestor implementation
 * @param T The shape of the parsed payload (default: unknown)
 * @returns The same ingestor, with types inferred
 */
export function defineIngestor<TShape = unknown>(
	ingestor: Ingestor<TShape>,
): Ingestor<TShape> {
	return ingestor;
}
