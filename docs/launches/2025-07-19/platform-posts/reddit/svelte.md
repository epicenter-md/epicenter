# Reddit r/sveltejs Post

## Title

How I implemented drag-and-drop file uploads in Whispering using shadcn-svelte-extras

## Post Content

Hey r/sveltejs! Just shipped a file upload feature for Whispering and wanted to share how I implemented drag-and-drop files.

I used the [FileDropZone component from shadcn-svelte-extras](https://www.shadcn-svelte-extras.com/components/file-drop-zone), which provided a clean abstraction that allows users to drop and click to upload files:

```svelte
<FileDropZone
  accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
  maxFiles={10}
  maxFileSize={25 * MEGABYTE}
  onUpload={(files) => {
    if (files.length > 0) {
      handleFileUpload(files);
    }
  }}
/>
```

The component handles web drag-and-drop, but since Whispering is a Tauri desktop app, drag-and-drop functionality didn't work on the desktop (click-to-select still worked fine). So I reached for Tauri's [onDragDropEvent](https://tauri.app/reference/javascript/api/namespacewebviewwindow/#ondragdropevent) to add native support for dragging files anywhere into the application.

You can see the [full implementation here](https://github.com/epicenter-md/epicenter/blob/50c15b65dd4667d968bda726e4664310339c4980/apps/whispering/src/routes/+page.svelte#L122) (note that the code is still somewhat messy by my standards; it is slated for cleanup!).

Whispering is a large, open-source, production Svelte 5 + Tauri app: [https://github.com/epicenter-md/epicenter](https://github.com/epicenter-md/epicenter) .

Feel free to check it out for more patterns! If you're building Svelte 5 apps and need file uploads, definitely check out shadcn-svelte-extras. Not affiliated, it just saved me hours of implementation time.

Happy to answer any questions about the implementation!