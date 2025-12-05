/*
	Installed from @ieedan/shadcn-svelte-extras
*/

import * as Avatar from '#/avatar';
import Bubble from './chat-bubble.svelte';
import BubbleAvatar from './chat-bubble-avatar.svelte';
import BubbleMessage from './chat-bubble-message.svelte';
import List from './chat-list.svelte';

const BubbleAvatarImage = Avatar.Image;
const BubbleAvatarFallback = Avatar.Fallback;

export {
	Bubble,
	BubbleAvatar,
	BubbleAvatarFallback,
	BubbleAvatarImage,
	BubbleMessage,
	List,
};

export type * from './types';
