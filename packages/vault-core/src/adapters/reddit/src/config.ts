// biome-ignore lint/complexity/noBannedTypes: nothing to configure yet
export type RedditAdapterConfig = {} | undefined;

// biome-ignore lint/correctness/noUnusedVariables: Future config options
const DEFAULT_CONFIG = {} satisfies Exclude<RedditAdapterConfig, undefined>;
