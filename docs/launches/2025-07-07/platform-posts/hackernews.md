# Hacker News Launch Posts

## Primary Post (Day 1 - Traditional Angle)

### Title

Show HN: Open-source transcription app that costs $0.02/hour instead of $30/month

### Post Content
I built Whispering because I believe transcription is too fundamental a tool to be locked behind paywalls. It's a cross-platform desktop and web transcription app that turns speech into text with a keyboard shortcut, among other things.

The app lets you bring your own API key (OpenAI, Groq, etc.) and make direct calls. If you want complete privacy, it also supports local transcription. Either way, your audio never goes through any middleman servers. It's super lightweight (~22MB), built with Svelte 5 and Tauri, and works on Mac, Windows, and Linux.

I've been using it daily for the past few months and just released v7 last night. I spent a considerable amount of time developing a clean architecture that's hopefully educational to read. This is one of the most complex Svelte 5 apps in production, with extensive use of runes and TanStack Query.

I'm happy to answer questions about implementation or how to build desktop apps with this stack!
---

### Prepared First Comment


For those interested in the architecture: I use dependency injection at build time to share ~95% of code between desktop and web versions. Instead of maintaining separate codebases, I detect the platform and inject the appropriate service implementations.

The three-layer architecture has been particularly helpful:

- *Services*: https://github.com/epicenter-md/epicenter/tree/main/apps/whispering/src/lib/services: Pure functions with platform abstraction, no UI dependencies

- *Query layer*: https://github.com/epicenter-md/epicenter/tree/main/apps/whispering/src/lib/query : Adds reactivity, caching, and runtime dependency injection

Voice-activated mode is particularly nice when coding—you can keep your hands on the keyboard while dictating. The Svelte 5 runes + TanStack Query combination has been fantastic for managing real-time audio state.

---

## Follow-up Post (Day 2-3 - Workflow Angle)

### Title Options
1. Show HN: Voice-driven development with Whispering + Claude Code
2. Show HN: My $0.02/hour voice coding setup with Groq
3. Show HN: How I use voice transcription for coding (open-source workflow)

### Post Content
Yesterday I shared Whispering, my open-source transcription app. Several people asked about my workflow, so here's how I actually use it to code faster than I can type.

My setup:
- Whispering in voice-activated mode (hands-free)
- Groq's Whisper API (near-instant transcription)
- Claude Code for the IDE integration
- Total cost: ~$0.02/hour

The workflow:
1. Think out loud about what I want to build
2. Whispering transcribes in real-time
3. Claude Code turns my words into actual code
4. I review and voice any corrections

Results:
- Faster for certain tasks (especially boilerplate and documentation)
- More natural for explaining complex logic out loud
- Helps with RSI/typing fatigue
- Works well for brainstorming and rubber duck debugging

Video demo: [link] (shows actual coding session)

What surprised me most: I can maintain flow state better when speaking than typing. The constraint of speaking forces clearer thinking about what I want to build.

Technical details on the integration and voice activation logic in the repo: [link]

Has anyone else experimented with voice-driven development? What worked/didn't work for you?