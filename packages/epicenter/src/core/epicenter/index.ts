// Definition (config side)

export type { ActionInfo, EpicenterClient } from './client';
// Runtime (client side)
export { createEpicenterClient, iterActions } from './client';
export type { EpicenterConfig } from './config';
export { defineEpicenter } from './config';
