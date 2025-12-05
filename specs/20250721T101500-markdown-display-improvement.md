# Markdown Display Improvement Plan

## Problem
The current message display shows raw markdown text instead of properly rendered HTML, making code blocks, headers, and formatting hard to read.

## Current State
- Messages with markdown content display as plain text
- No syntax highlighting for code blocks  
- Headers, lists, and emphasis not visually distinguished
- Poor readability for formatted content

## Proposed Solution

### 1. Markdown to HTML Conversion
- [ ] Install a markdown parser library (e.g., `marked`, `markdown-it`, or `remark`)
- [ ] Create utility function to convert markdown strings to HTML
- [ ] Handle security concerns with HTML sanitization

### 2. TailwindCSS Typography Integration  
- [ ] Verify `@tailwindcss/typography` is available (already in packages/ui/package.json)
- [ ] Apply `prose` classes to rendered markdown content
- [ ] Configure typography plugin for dark mode support
- [ ] Customize prose styles to match existing design system

### 3. Component Integration
- [ ] Update `MessagePartRenderer.svelte` to detect markdown content
- [ ] Render HTML instead of plain text for markdown parts
- [ ] Maintain existing prose classes and styling
- [ ] Ensure proper escaping for non-markdown content

### 4. Syntax Highlighting (Optional)
- [ ] Add code syntax highlighting library (e.g., `prismjs`, `highlight.js`)
- [ ] Configure for common languages (JavaScript, Python, Bash, etc.)
- [ ] Apply highlighting to code blocks within markdown

## Implementation Steps

### Step 1: Choose Markdown Library
Options:
- **marked**: Fast, lightweight, well-established
- **markdown-it**: Extensible, plugin system
- **remark**: Part of unified ecosystem, more powerful but complex

Recommendation: `marked` for simplicity and performance

### Step 2: Create Markdown Utility
```typescript
// lib/utils/markdown.ts
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

export function parseMarkdown(text: string): string {
  const rawHtml = marked.parse(text);
  return DOMPurify.sanitize(rawHtml);
}
```

### Step 3: Update MessagePartRenderer
```svelte
<script lang="ts">
  import { parseMarkdown } from '$lib/utils/markdown';
  
  let { part } = $props();
  
  const isMarkdown = $derived(
    part.type === 'text' && 
    (part.text.includes('```') || part.text.includes('#') || part.text.includes('*'))
  );
  
  const renderedContent = $derived(
    isMarkdown ? parseMarkdown(part.text) : part.text
  );
</script>

{#if isMarkdown}
  <div class="prose prose-sm dark:prose-invert max-w-none">
    {@html renderedContent}
  </div>
{:else}
  {part.text}
{/if}
```

### Step 4: Typography Configuration
Ensure proper prose styling in existing classes:
```css
prose-pre:bg-slate-900 prose-pre:text-slate-50 
dark:prose-pre:bg-slate-950 dark:prose-pre:text-slate-50
prose-pre:overflow-x-auto prose-pre:max-w-full
prose-code:text-xs prose-code:leading-relaxed
```

## Security Considerations
- Use DOMPurify to sanitize HTML output
- Whitelist allowed HTML tags and attributes
- Escape user input that shouldn't be parsed as markdown
- Prevent XSS attacks through malicious markdown

## Dependencies to Install
```bash
pnpm add marked isomorphic-dompurify
pnpm add -D @types/marked @types/dompurify
```

## Success Metrics
- Markdown content renders as properly formatted HTML
- Code blocks display with appropriate styling
- Headers, lists, and emphasis are visually distinct  
- Dark mode support works correctly
- No security vulnerabilities introduced
- Performance remains acceptable for long messages

## Testing Strategy
- Test with various markdown formats (headers, lists, code blocks)
- Verify security with malicious input attempts
- Check dark/light mode rendering
- Test performance with large markdown content
- Ensure accessibility standards are maintained