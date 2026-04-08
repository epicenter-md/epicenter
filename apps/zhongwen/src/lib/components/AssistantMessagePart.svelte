<script lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import { annotateHtml } from '$lib/pinyin/annotate';

	type Props = {
		content: string;
		showPinyin: boolean;
	};

	let { content, showPinyin }: Props = $props();

	const PURIFY_CONFIG = {
		ADD_TAGS: ['ruby', 'rt', 'rp'],
	};

	const html = $derived.by(() => {
		const raw = marked.parse(content, { breaks: true, gfm: true }) as string;
		const annotated = showPinyin ? annotateHtml(raw) : raw;
		return DOMPurify.sanitize(annotated, PURIFY_CONFIG);
	});
</script>

<div class="prose prose-sm">{@html html}</div>
