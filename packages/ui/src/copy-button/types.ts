/*
	Installed from @ieedan/shadcn-svelte-extras
*/

import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import type { ButtonSize, ButtonVariant } from '#/button';
import type { UseClipboard } from '#/hooks/use-clipboard.svelte';

export type CopyButtonPropsWithoutHTML = {
	ref?: HTMLButtonElement | null;
	text: string;
	icon?: Snippet<[]>;
	animationDuration?: number;
	onCopy?: (status: UseClipboard['status']) => void;
	size?: ButtonSize;
	variant?: ButtonVariant;
	children?: Snippet<[]>;
};

export type CopyButtonProps = CopyButtonPropsWithoutHTML &
	Omit<HTMLButtonAttributes, 'children'>;
