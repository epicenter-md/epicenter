import { defineCodec } from '../core/codec';
import { YAML } from '../utils/format/yaml';

// TODO figure out condition for body prop (name based??)
export const markdownFormat = defineCodec({
	id: 'markdown',
	fileExtension: 'md',
	parse(text) {
		return YAML.parse(text);
	},
	stringify(rec) {
		return YAML.stringify(rec);
	},
});
