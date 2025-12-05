// biome-ignore lint/complexity/noBannedTypes: nothing to configure yet
export type RedditAdapterConfig = {} | undefined;

const _DEFAULT_CONFIG = {} satisfies Exclude<RedditAdapterConfig, undefined>;
