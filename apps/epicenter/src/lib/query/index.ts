import { workspaces } from '$lib/workspaces/dynamic/queries';
import { staticWorkspaces } from '$lib/workspaces/static/queries';

export { queryClient } from './client';

export const rpc = {
	staticWorkspaces,
	workspaces,
};
