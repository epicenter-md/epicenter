import Field from './field.svelte';
import Content from './field-content.svelte';
import Description from './field-description.svelte';
// biome-ignore lint/suspicious/noShadowRestrictedNames: Component name matches its purpose
import Error from './field-error.svelte';
import Group from './field-group.svelte';
import Label from './field-label.svelte';
import Legend from './field-legend.svelte';
import Separator from './field-separator.svelte';
// biome-ignore lint/suspicious/noShadowRestrictedNames: Component name matches its purpose
import Set from './field-set.svelte';
import Title from './field-title.svelte';

export {
	Content,
	Content as FieldContent,
	Description,
	Description as FieldDescription,
	Error,
	Error as FieldError,
	Field,
	Group,
	Group as FieldGroup,
	Label,
	Label as FieldLabel,
	Legend,
	Legend as FieldLegend,
	Separator,
	Separator as FieldSeparator,
	Set,
	//
	Set as FieldSet,
	Title,
	Title as FieldTitle,
};
