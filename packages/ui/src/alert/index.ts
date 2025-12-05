import Root from './alert.svelte';
import Description from './alert-description.svelte';
import Title from './alert-title.svelte';

export { type AlertVariant, alertVariants } from './alert.svelte';

export {
	Root,
	Description,
	Title,
	//
	Root as Alert,
	Description as AlertDescription,
	Title as AlertTitle,
};
