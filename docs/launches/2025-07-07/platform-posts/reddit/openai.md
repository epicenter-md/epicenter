# Reddit r/OpenAI Launch Post

## Status: ✅ POSTED

## Posted URL: https://www.reddit.com/r/OpenAI/comments/1lu20tr/i_built_a_free_opensource_app_that_connects/

## Post Type: **Link Post with Screenshot**
- Primary: Link to GitHub repo
- Thumbnail: App screenshot showing transcription in action

## Title

I built a free, open-source app that connects directly to the Whisper API - pay $0.02/hour instead of $30/month

## Post Content (First Comment)

Hey r/OpenAI!

I built Whispering because I was tired of paying subscription fees for what's essentially a UI wrapper around OpenAI's Whisper API. It's completely free and open source.

I realized the actual Whisper API costs about $0.006/minute. At 3-4 hours daily use, that's only $3/month going directly to OpenAI.

So I built my own wrapper to destroy the other wrappers. You bring your own API key, make direct calls to Whisper (or Groq, or any provider), and your audio never touches any middleman servers. Same privacy guarantees as using the API directly.

It supports all the Whisper models - the standard `whisper-1`, the new `whisper-4o-transcribe` (super accurate), and `whisper-4o-transcribe-mini` (faster/cheaper). Plus models from other providers that go as low as $0.02/hour.

The killer feature for me is voice-activated mode. I use it constantly with ChatGPT and my code editor. Press shortcut, speak, get text, paste. No clicking around. It's completely changed how I write code and documentation.

Built with Svelte 5 and Tauri, so it's tiny (\~22MB) and starts instantly. Works on Mac, Windows, and Linux.

GitHub: [https://github.com/epicenter-md/epicenter](https://github.com/epicenter-md/epicenter)

[How I use it for coding](https://www.youtube.com/watch?v=tP1fuFpJt7g&t=8s)

Happy to answer questions about the implementation or how to optimize API costs. Been using this daily for months and it's saved me hundreds of dollars.