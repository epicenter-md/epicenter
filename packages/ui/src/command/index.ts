import { Command as CommandPrimitive } from 'bits-ui';

import Root from './command.svelte';
import Dialog from './command-dialog.svelte';
import Empty from './command-empty.svelte';
import Group from './command-group.svelte';
import Input from './command-input.svelte';
import Item from './command-item.svelte';
import LinkItem from './command-link-item.svelte';
import List from './command-list.svelte';
import Separator from './command-separator.svelte';
import Shortcut from './command-shortcut.svelte';

const Loading = CommandPrimitive.Loading;

export {
	Dialog,
	Dialog as CommandDialog,
	Empty,
	Empty as CommandEmpty,
	Group,
	Group as CommandGroup,
	Input,
	Input as CommandInput,
	Item,
	Item as CommandItem,
	LinkItem,
	LinkItem as CommandLinkItem,
	List,
	List as CommandList,
	Loading,
	Loading as CommandLoading,
	Root,
	//
	Root as Command,
	Separator,
	Separator as CommandSeparator,
	Shortcut,
	Shortcut as CommandShortcut,
};
