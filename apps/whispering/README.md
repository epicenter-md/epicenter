<p align="center">
  <a href="https://whispering.epicenter.so">
    <img width="180" src="./src-tauri/recorder-state-icons/studio_microphone.png" alt="Whispering">
  </a>
  <h1 align="center">Whispering</h1>
  <p align="center">Press shortcut → speak → get text. Free and open source ❤️</p>
</p>

<p align="center">
  <!-- Latest Version Badge -->
  <img src="https://img.shields.io/github/v/release/EpicenterHQ/epicenter?style=flat-square&label=Latest%20Version&color=brightgreen" />
  <!-- License Badge -->
  <a href="../../LICENSE" target="_blank">
    <img alt="AGPLv3 License" src="https://img.shields.io/github/license/EpicenterHQ/epicenter.svg?style=flat-square" />
  </a>
  <!-- Discord Badge -->
  <a href="https://go.epicenterhq.com/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/discord/1391098486178582549?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" />
  </a>
  <!-- Platform Support Badges -->
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="macOS" src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
  </a>
  <!-- Tech Stack Badges -->
  <img alt="Svelte 5" src="https://img.shields.io/badge/-Svelte%205-orange?style=flat-square&logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/-Tauri-blue?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/-TypeScript-blue?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/-Rust-orange?style=flat-square&logo=rust&logoColor=white" />
</p>

Whispering is an open-source speech-to-text application. Press a keyboard shortcut, speak, and your words will transcribe, transform, then copy and paste at the cursor.

I really like hands-free voice dictation. For years, I relied on transcription tools that were _almost_ good, but they were all closed-source. Even those claiming to be "local" or "on-device" were still black boxes that left me wondering where my audio really went.

So I built Whispering. It's open-source, local-first, and most importantly, transparent with your data. ​​Your data is stored locally on your device, and your audio goes directly from your machine to a local provider (Whisper C++, Speaches, etc.) or your chosen cloud provider (Groq, OpenAI, ElevenLabs, etc.) without any middleman or vendor lock-in. For me, the features were good enough that I left my paid tools behind.

Productivity apps should be open-source and transparent with your data, but they also need to match the UX of paid, closed-software alternatives. I hope Whispering is near that point. I use it for several hours a day, from coding to thinking out loud while carrying pizza boxes back from the office.

> [!TIP]
> Whispering is designed for quick transcriptions, not long recordings. For extended recording sessions, use a dedicated recording app.

Here's an overview:

<div align="center">
  <a href="https://www.youtube.com/watch?v=1jYgBMrfVZs">
    <img src="https://img.youtube.com/vi/1jYgBMrfVZs/maxresdefault.jpg" alt="Whispering Complete Setup Guide" width="600">
  </a>
  <p><em>Click to watch: Complete setup and usage guide (5 min)</em></p>
  <p><em>Note: We recently added support for Whisper C++, which isn't included in the video. For setup, see the docs below.</em></p>
</div>

and [here's how I personally am using it with Claude Code these days](https://www.youtube.com/watch?v=tpix588SeiQ).

There are plenty of transcription apps out there, each with their own strengths. Whispering has a few tricks up its sleeve, like a voice-activated mode for truly hands-free operation (no button holding), and customizable AI transformations with any prompt/model. The space is full of great ideas, but I just wanted to add some extra competition from the OSS ecosystem.

Built with Svelte 5 and Tauri, so it's tiny (~22MB) and starts instantly. The codebase is well-documented and designed to be understood and audited. That way, you know where your audio goes, how it's processed, and what data is stored. And finally, the cost savings. When you cut out the middleman, you pay providers directly:

| Service                           | Cost per Hour | Light Use (20 min/day) | Moderate Use (1 hr/day) | Heavy Use (3 hr/day) | Traditional Tools |
| --------------------------------- | ------------- | ---------------------- | ----------------------- | -------------------- | ----------------- |
| `whisper-large-v3-turbo` (Groq)   | $0.04         | $0.40/month            | $1.20/month             | $3.60/month          | $15-30/month      |
| `whisper-large-v3` (Groq)         | $0.111        | $1.11/month            | $3.33/month             | $9.99/month          | $15-30/month      |
| `gpt-4o-mini-transcribe` (OpenAI) | $0.18         | $1.80/month            | $5.40/month             | $16.20/month         | $15-30/month      |
| Local                             | $0.00         | $0.00/month            | $0.00/month             | $0.00/month          | $15-30/month      |

We're hoping that together in the open-source, local-first community, we can build something better than any closed-source alternative. The code is open-source because I believe that fundamental tools shouldn't require trusting a black box. Companies pivot, get acquired, or shut down. But open source is forever. ❤️

## Install Whispering

Set up Whispering and be ready to transcribe in about two minutes.

### 1️⃣ Download Whispering

<details>
<summary><strong>🍎 macOS</strong></summary>

#### Option 1: Install via Homebrew (Recommended)

The fastest way to install Whispering on macOS:

```bash
brew install --cask whispering
```

This automatically handles installation and updates.

#### Option 2: Direct Download

| Architecture      | Download                                                                                                                          | Requirements     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Apple Silicon** | [Whispering_7.11.0_aarch64.dmg](https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_aarch64.dmg) | M1/M2/M3/M4 Macs |

> **💡 Tip:** The direct macOS download is for Apple Silicon (M1/M2/M3/M4) Macs. Intel Mac builds are not currently published.

**Installation steps:**

1. Download the `.dmg` file
2. Open the downloaded file
3. Drag Whispering to your Applications folder
4. Open Whispering from Applications

#### Troubleshooting:

- **"Unverified developer" warning:** Right-click the app → Open → Open
- **"App is damaged" error (Apple Silicon):** Run `xattr -cr /Applications/Whispering.app` in Terminal

</details>

<details>
<summary><strong>🪟 Windows</strong></summary>

#### Download Options

| Installer Type    | Download                                                                                                                              | Description                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **MSI Installer** | [Whispering_7.11.0_x64_en-US.msi](https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_x64_en-US.msi) | Recommended Standard Windows installer |
| **EXE Installer** | [Whispering_7.11.0_x64-setup.exe](https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_x64-setup.exe) | Alternative installer option           |

#### Installation

1. Download the `.msi` installer (recommended)
2. Double-click to run the installer
3. If Windows Defender appears: Click "More Info" → "Run Anyway"
4. Follow the installation wizard

Whispering will appear in your Start Menu when complete.

</details>

<details>
<summary><strong>🐧 Linux</strong></summary>

#### Download Options

| Package Format  | Download                                                                                                                                | Compatible With          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **AppImage**    | [Whispering_7.11.0_amd64.AppImage](https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_amd64.AppImage) | All Linux distributions  |
| **DEB Package** | [Whispering_7.11.0_amd64.deb](https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_amd64.deb)           | Debian, Ubuntu, Pop!\_OS |
| **RPM Package** | [Whispering-7.11.0-1.x86_64.rpm](https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering-7.11.0-1.x86_64.rpm)     | Fedora, RHEL, openSUSE   |

#### Quick Install Commands

**AppImage (Universal)**

```bash
wget https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_amd64.AppImage
chmod +x Whispering_7.11.0_amd64.AppImage
./Whispering_7.11.0_amd64.AppImage
```

**Debian/Ubuntu**

```bash
wget https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering_7.11.0_amd64.deb
sudo dpkg -i Whispering_7.11.0_amd64.deb
```

**Fedora/RHEL**

```bash
wget https://github.com/EpicenterHQ/epicenter/releases/download/v7.11.0/Whispering-7.11.0-1.x86_64.rpm
sudo rpm -i Whispering-7.11.0-1.x86_64.rpm
```

</details>

> [!TIP]
> **Links not working?** Find all downloads at [GitHub Releases](https://github.com/EpicenterHQ/epicenter/releases/latest)

<details>
<summary><strong>Try in Browser (No Download)</strong></summary>

<br>

**[Open Whispering Web App](https://whispering.epicenter.so)**

No installation needed! Works in any modern browser.

> **📝 Note:** The web version doesn't have global keyboard shortcuts, but otherwise works great for trying out Whispering before installing.

</details>

### 2️⃣ Choose Your Transcription Method

Whispering offers two approaches to transcription. Pick the one that fits your needs:

<details>
<summary><strong>🏠 Option A: Local Transcription (Whisper C++)</strong></summary>

**Best for:** Complete privacy, offline use, no ongoing costs

Your audio never leaves your device. Works without internet. Free forever.

#### Setup Steps

**First, download a model (required):**

1. Open Whispering
2. Click **Settings** (⚙️) → **Privacy & Processing**
3. Select **Whisper C++** from the dropdown
4. Choose a model (start with `Small` for good balance of speed and accuracy)
5. Click **Download** button next to the model
6. Wait for download to complete (may take a few minutes)
7. Verify the model shows as **activated**

> **⚠️ Important:** You must download a model before you can transcribe.

#### Test Your Setup

1. Click the record button or use your keyboard shortcut
2. Say "Testing local transcription"
3. Press the stop record button and wait for processing to complete

**🎉 Success!** Your words are now in your clipboard. Paste anywhere!

> **📝 Note:** Local transcription is slower than cloud options but provides complete privacy. Processing speed depends on your hardware and the model size you chose.

</details>

<details>
<summary><strong>☁️ Option B: Cloud Transcription (Groq)</strong></summary>

**Best for:** Fast setup, near-instant results, high accuracy

I personally use Groq for most of my transcriptions because it's incredibly fast and accurate.

> **💡 Tip:** Why Groq? Fastest transcription models, super accurate, generous free tier, and unbeatable pricing (as cheap as $0.04/hour using `whisper-large-v3-turbo`)

#### Get Your Free API Key

1. Visit [console.groq.com/keys](https://console.groq.com/keys)
2. Sign up (free, no credit card required) → Create API key → Copy it

#### Setup Steps

1. Open Whispering
2. Click **Settings** (⚙️) → **Privacy & Processing**
3. Select **Groq** from the dropdown
4. Paste your API key in the API key field
5. Choose a model (`whisper-large-v3-turbo` is fastest and cheapest)

#### Test Your Setup

1. Click the record button or use your keyboard shortcut
2. Say "Testing cloud transcription"
3. Results appear almost instantly

**🎉 Success!** Your words are now in your clipboard. Paste anywhere!

> **📝 Note:** Cloud transcription requires an internet connection and sends your audio to Groq's servers. Your API key ensures the data goes directly from you to Groq with no middleman.

</details>

<details>
<summary><strong>Having trouble? Common issues & fixes</strong></summary>

### Quick Fixes

- **No transcription?** → Double-check API key in Settings
- **Shortcut not working?** → Bring Whispering to foreground (see macOS section below)
- **Wrong provider selected?** → Check Settings → Privacy & Processing

### Platform-Specific Issues

<details>
<summary><strong>macOS: Global shortcut stops working?</strong></summary>

This happens due to macOS App Nap, which suspends background apps to save battery.

**Quick fixes:**

1. Use Voice Activated mode for hands-free operation (recommended)
2. Bring Whispering to the foreground briefly to restore shortcuts
3. Keep the app window in the foreground (even as a smaller window)

**Best practice:** Keep Whispering in the foreground in front of other apps. You can resize it to a smaller window or use Voice Activated mode for minimal disruption.

</details>

<details>
<summary><strong>Accidentally rejected microphone permissions?</strong></summary>

If you accidentally clicked "Don't Allow" when Whispering asked for microphone access, here's how to fix it:

#### 🍎 macOS

1. Open **System Settings** → **Privacy & Security** → **Privacy** → **Microphone**
2. Find **Whispering** in the list
3. Toggle the switch to enable microphone access
4. If Whispering isn't in the list, reinstall the app to trigger the permission prompt again

#### 🪟 Windows

If you accidentally blocked microphone permissions, use the Registry solution:

**Registry Cleanup (Recommended)**

1. Close Whispering
2. Open Registry Editor (Win+R, type `regedit`)
3. Use Find (Ctrl+F) to search for "Whispering"
4. Delete all registry folders containing "Whispering"
5. Press F3 to find next, repeat until all instances are removed
6. Uninstall and reinstall Whispering
7. Accept permissions when prompted

<details>
<summary>Alternative solutions</summary>

**Delete App Data:** Navigate to `%APPDATA%\so.epicenter.whispering` and delete this folder, then reinstall.

**Windows Settings:** Settings → Privacy & security → Microphone → Enable "Let desktop apps access your microphone"

</details>

See [Issue #526](https://github.com/EpicenterHQ/epicenter/issues/526) for more details.

</details>

</details>

### 3️⃣ Next Steps: Power User Features

Take your transcription experience to the next level with these advanced features:

<details>
<summary><strong>🎯 Custom Transcription Services</strong></summary>

Choose from multiple transcription providers based on your needs for speed, accuracy, and privacy:

#### 🚀 Groq (Recommended)

- **API Key:** [console.groq.com/keys](https://console.groq.com/keys)
- **Models:** `whisper-large-v3-turbo` ($0.04/hr), `whisper-large-v3` ($0.111/hr)
- **Why:** Fastest, cheapest, generous free tier

#### 🎯 OpenAI

- **API Key:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys) ([Enable billing](https://platform.openai.com/settings/organization/billing/overview))
- **Models:** `whisper-1` ($0.36/hr), `gpt-4o-transcribe` ($0.36/hr), `gpt-4o-mini-transcribe` ($0.18/hr)
- **Why:** Industry standard

#### 🎙️ ElevenLabs

- **API Key:** [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
- **Models:** `scribe_v2`, `scribe_v1`, `scribe_v1_experimental`
- **Why:** High-quality voice AI

#### 🏠 Speaches (Local)

- **API Key:** None needed!
- **Why:** Complete privacy, offline use, free forever

</details>

<details>
<summary><strong>🤖 AI-Powered Transformations</strong></summary>

Transform your transcriptions automatically with custom AI workflows:

**Quick Example: Format Text**

1. Go to **Transformations** (📚) in the top bar
2. Click "Create Transformation" → Name it "Format Text"
3. Add a **Prompt Transform** step:
   - Model: `Claude Sonnet 3.5` (or your preferred AI)
   - System prompt: `You are an intelligent text formatter specializing in cleaning up transcribed speech. Your task is to transform raw transcribed text into well-formatted, readable content while maintaining the speaker's original intent and voice.

Core Principles:

1. Preserve authenticity: Keep the original wording and phrasing as much as possible
2. Add clarity: Make intelligent corrections only where needed for comprehension
3. Enhance readability: Apply proper formatting, punctuation, and structure

Formatting Guidelines:

Punctuation & Grammar:

- Add appropriate punctuation (periods, commas, question marks)
- Correct obvious transcription errors while preserving speaking style
- Fix run-on sentences by adding natural breaks
- Maintain conversational tone and personal speaking patterns

Structure & Organization:

- Create paragraph breaks at natural topic transitions
- Use bullet points or numbered lists when the speaker is listing items
- Add headings if the content has clear sections
- Preserve emphasis through italics or bold when the speaker stresses words

Intelligent Corrections:

- Fix homophones (e.g., "there/their/they're")
- Complete interrupted thoughts when the intention is clear
- Remove excessive filler words (um, uh) unless they add meaning
- Correct obvious misspeaks while noting significant ones in [brackets]

Special Handling:

- Technical terms: Research and correct spelling if unclear
- Names/places: Make best guess and mark uncertain ones with [?]
- Numbers: Convert spoken numbers to digits when appropriate
- Time references: Standardize format (e.g., "3 PM" not "three in the afternoon")

Preserve Original Intent:

- Keep colloquialisms and regional expressions
- Maintain the speaker's level of formality
- Don't "upgrade" simple language to sound more sophisticated
- Preserve humor, sarcasm, and emotional tone

Output Format:
Return the formatted text with:

- Clear paragraph breaks
- Proper punctuation and capitalization
- Any structural elements (lists, headings) that improve clarity
- [Bracketed notes] for unclear sections or editorial decisions
- Original meaning and voice intact

Remember: You're a translator from spoken to written form, not an editor trying to improve the content. Make it readable while keeping it real.`

- User prompt: `Here is the text to format:

<text>{{input}}</text>` 4. Save and select it in your recording settings

**What can transformations do?**

- Fix grammar and punctuation automatically
- Translate to other languages
- Convert casual speech to professional writing
- Create summaries or bullet points
- Remove filler words ("um", "uh")
- Chain multiple steps together

**Example workflow:** Speech → Transcribe → Fix Grammar → Translate to Spanish → Copy to clipboard

<details>
<summary>Setting up AI providers for transformations</summary>

You'll need additional API keys for AI transformations. Choose from these providers based on your needs:

#### 🧠 OpenAI

- **API Key:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Models:** `gpt-4o`, `gpt-4o-mini`, `o3-mini` and more
- **Why:** Most capable, best for complex text transformations

#### 🤖 Anthropic

- **API Key:** [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys)
- **Models:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- **Why:** Excellent writing quality, nuanced understanding

#### ✨ Google Gemini

- **API Key:** [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- **Models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`
- **Why:** Free tier available, fast response times

#### ⚡ Groq

- **API Key:** [console.groq.com/keys](https://console.groq.com/keys)
- **Models:** `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `gemma2-9b-it`, and more
- **Why:** Lightning fast inference, great for real-time transformations

#### 🧩 Custom (OpenAI-Compatible)

- **API Key:** From your provider's settings, if applicable
- **Base URL:** Any OpenAI-compatible `/v1` endpoint (Ollama, LM Studio, vLLM, etc.)
- **Models:** Whatever your endpoint exposes
- **Why:** Point Whispering at any self-hosted or private LLMs you want

</details>

</details>

<details>
<summary><strong>🎙️ Voice Activity Detection (VAD)</strong></summary>

Hands-free recording that starts when you speak and stops when you're done.

**Two ways to enable VAD:**

**Option 1: Quick toggle on homepage**

- On the homepage, click the **Voice Activated** tab (next to Manual)

**Option 2: Through settings**

1. Go to **Settings** → **Recording**
2. Find the **Recording Mode** dropdown
3. Select **Voice Activated** instead of Manual

**How it works:**

- Press shortcut once → VAD starts listening
- Speak → Recording begins automatically
- Stop speaking → Recording stops after a brief pause
- Your transcription appears instantly

Perfect for dictation without holding keys!

</details>

<details>
<summary><strong>⌨️ Custom Shortcuts</strong></summary>

Change the recording shortcut to whatever feels natural:

1. Go to **Settings** → **Recording**
2. Click on the shortcut field
3. Press your desired key combination
4. Popular choices: `F1`, `Cmd+Space+R`, `Ctrl+Shift+V`

</details>

## How is my data stored?

Whispering stores as much data as possible locally on your device, including recordings and text transcriptions. The privacy boundary depends on two separate choices: where audio is transcribed, and where Polish sends transcript text. Here's an overview of how data is handled:

1. **Local Storage**: Voice recordings and transcriptions are stored in IndexedDB, which is used as blob storage and a place to store all of your data like text and transcriptions.

2. **Transcription Service**: If you choose a cloud or self-hosted transcription service, your recording is sent to that service. If you choose a local transcription engine, audio stays on your device. You have the following options:
   - External services like OpenAI, Groq, or ElevenLabs (with your own API keys)
   - Self-hosted transcription through Speaches
   - Local transcription engines like Whisper C++, Parakeet, or Moonshine, which keep audio on-device

3. **Polish and Recipes**: Polish is the meaning-preserving cleanup pass that can run after transcription. Recipes are manual text transformations. Both use the selected completion provider when they need AI.
   - Cloud completion providers send transcript text to services like OpenAI, Anthropic, Google, Groq, or OpenRouter.
   - Custom completion can point at a local OpenAI-compatible server, such as Ollama or LM Studio. With a local server and no API key, Polish transcript text stays on your device.

   Local transcription does not automatically make Polish local. Audio can stay on-device while transcript text is still sent to a cloud completion provider. **Settings → Privacy & Processing** shows the current boundary for both stages.

You can change both the transcription and completion providers under **Settings → Privacy & Processing** to control which parts of the pipeline stay local.

### Local Polish with Ollama or LM Studio

Local Polish already works through the Custom completion provider. Run an OpenAI-compatible local server yourself, then under **Settings → Privacy & Processing** choose **Custom (OpenAI-compatible)** as the text AI provider, paste the server URL, leave the API key empty unless your server requires one, and type the model name you want to use.

Common local URLs:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`

Whispering does not start or discover local completion servers. It only sends Polish and Recipe requests to the endpoint you configure.

## Frequently Asked Questions

### How is this different from other transcription apps?

Most apps are middlemen charging $30/month for API calls that cost pennies. With Whispering, you bring your own API key and pay providers directly. Your audio goes straight from your device to the API. No servers in between, no data collection, no subscriptions.

I built this for myself and use it every day. The code is open source so you can verify exactly what it does.

### What's it built with?

Svelte 5 + Tauri. The app is tiny (~22MB), starts instantly, and uses minimal resources. The codebase is clean and well-documented if you want to learn or contribute.

### Can I use it offline?

Yes, use a local transcription engine such as Whisper C++, Parakeet, or Moonshine. No internet, no API keys, completely private.

### How much does it actually cost?

With Groq (my favorite): $0.02-$0.06/hour. With OpenAI: $0.18-$0.36/hour. Local transcription: free forever. I use it several hours daily and pay about $3/month total.

### Is it really private?

Your recordings stay on your device in IndexedDB. When you transcribe, audio goes directly to your chosen provider using your API key. No middleman servers. For maximum privacy, use local transcription.

Note: we use anonymized event logging with [Aptabase](https://github.com/aptabase), an open-source, privacy-first analytics service. No personal data is attached to any of these events. You can see exactly what events we log [in `analytics.ts`](https://github.com/EpicenterHQ/epicenter/tree/main/apps/whispering/src/lib/services/analytics.ts) and where they are logged [by searching for `rpc.analytics.logEvent` in our codebase](https://github.com/search?q=repo%3AEpicenterHQ%2Fepicenter+rpc.analytics.logEvent&type=code). You can turn this off in settings at any time.

### Can I format the output automatically?

Yes - set up AI transformations to fix grammar, translate languages, or reformat text. Works with any LLM provider.

### What platforms work?

Desktop: Apple Silicon Mac, Windows, Linux. Web: Any modern browser at [whispering.epicenter.so](https://whispering.epicenter.so).

### Found a bug?

Open an issue on [GitHub](https://github.com/EpicenterHQ/epicenter/issues). I actively maintain this and respond quickly.

## Development

### Built With Modern Web Technologies

Whispering showcases the power of modern web development as a comprehensive example application:

#### Web and Desktop

- [Svelte 5](https://svelte.dev): The UI reactivity library of choice with cutting-edge runes system
- [SvelteKit](https://kit.svelte.dev): For routing and static site generation
- [Tauri](https://tauri.app): The desktop app framework for native performance
- [WellCrafted](https://github.com/wellcrafted-dev/wellcrafted): Lightweight type-safe error handling
- [Svelte Sonner](https://svelte-sonner.vercel.app): Toast notifications for errors
- [TanStack Query](https://tanstack.com/query): Powerful data synchronization
- [TanStack Table](https://tanstack.com/table): Comprehensive data tables
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) & [Dexie.js](https://dexie.org): Local data storage
- [shadcn-svelte](https://www.shadcn-svelte.com): Beautiful, accessible components
- [TailwindCSS](https://tailwindcss.com): Utility-first CSS framework
- [Bun workspaces](https://bun.com/docs/install/workspaces): Monorepo management
- [Rust](https://www.rust-lang.org): Native desktop features
- [Vercel](https://vercel.com): Hosting platform
- [Zapsplat.com](https://www.zapsplat.com): Royalty-free sound effects

#### Browser Extension

- [React](https://reactjs.org): UI library
- [shadcn/ui](https://ui.shadcn.com): Component library
- [Chrome API](https://developer.chrome.com/docs/extensions/reference): Extension APIs

**Note:** The browser extension is temporarily disabled while we stabilize the desktop app.

### Architecture Overview

Whispering uses a clean three-layer architecture with 97% code sharing between desktop and web versions:

- **Service Layer**: Platform-agnostic business logic with Result types
- **RPC Layer**: Reactive data management with caching
- **UI Layer**: Clean Svelte 5 components with minimal logic

The architecture achieves extensive code reuse through build-time platform detection, allowing the same codebase to run natively on desktop (via Tauri) and in the browser.

**→ For developers:** See the detailed [Architecture Deep Dive](./ARCHITECTURE.md) to understand how everything fits together.

### Run Whispering in Local Development Mode

1. Clone the repository: `git clone https://github.com/EpicenterHQ/epicenter.git`
2. Change into the project directory: `cd epicenter`
3. Install the necessary dependencies: `bun i`

> Want to contribute? See [CONTRIBUTING.md](../../CONTRIBUTING.md) for fork and PR instructions.

To run the desktop app and website:

```bash
cd apps/whispering
bun tauri dev
```

### Build The Executable Yourself

If you have concerns about the installers or want more control, you can build the executable yourself. This requires more setup, but it ensures that you are running the code you expect. Such is the beauty of open-source software!

#### Desktop

```bash
cd apps/whispering
bun i
bun tauri build
```

Find the executable in `apps/whispering/target/release`

### Contributing

We welcome contributions! Whispering is built with care and attention to clean, maintainable code.

#### Code Style Guidelines

- Follow existing TypeScript and Svelte patterns throughout
- Use Result types from the [WellCrafted library](https://github.com/wellcrafted-dev/wellcrafted) for all error handling
- Follow WellCrafted best practices: explicit errors with `Result<T, E>`, structured `TaggedError` objects, and comprehensive error context
- Study the existing patterns in these key directories:
  - **[Services Architecture](./src/lib/services/README.md)** - Platform-agnostic business logic
  - **[RPC Layer Patterns](./src/lib/rpc/README.md)** - RPC pattern and reactive state
  - **[Constants Organization](./src/lib/constants/README.md)** - Type-safe configuration

**→ New to the codebase?** Start with the [Architecture Deep Dive](./ARCHITECTURE.md) to understand how everything fits together.

#### Contributing New Adapters

We'd love to expand Whispering's capabilities with more transcription and AI service adapters! Here's how to add a new adapter:

**Overview of the adapter system:**

1. **Transcription services** (`src/lib/services/transcription/`): Convert audio to text
2. **Completion services** (`src/lib/services/completion/`): Power AI transformations in the transformation pipeline
3. **Provider registries** (`src/lib/services/transcription/providers.ts`, `src/lib/constants/inference.ts`): Own every provider fact, including the names of the config keys that hold its credentials and selections
4. **Stores**: Own the values behind those keys. `src/lib/state/device-config.svelte.ts` holds device-local values like API keys; `src/lib/workspace/definition.ts` holds synced settings like model selections
5. **Operations** (`src/lib/operations/transcribe.ts`, `src/lib/operations/transform.ts`): Dispatch tables that resolve registry pointers against the stores and call your service

##### Adding a Transcription Service Adapter

The provider registry owns every provider fact, including the names of the config keys that hold its credentials and model selection. The stores own the values. The dispatcher and the settings UI resolve those pointers through the registry, so most of the integration is compile-error driven: once your provider is in the registry, the type checker points at every table that still needs an entry.

The local GGUF engine is implemented in Rust behind Tauri commands, so this guide covers upload-based services that live in TypeScript: API-key providers and endpoint providers.

1. **Create the service implementation**:
   - **Cloud services**: `src/lib/services/transcription/cloud/` (OpenAI, Groq, Deepgram, ElevenLabs, Mistral)
   - **Self-hosted services**: `src/lib/services/transcription/self-hosted/` (Speaches)

   ```typescript
   // Example: src/lib/services/transcription/cloud/your-service.ts
   import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
   import { Ok, tryAsync, type Result } from 'wellcrafted/result';

   // Define a tagged error for this service. Variant names should humanize
   // cleanly (see $lib/report/humanize) since the report spine derives
   // toast titles from them by default.
   export const YourServiceError = defineErrors({
     MissingApiKey: () => ({
       message: 'YourService API key is required',
     }),
     Unexpected: ({ cause }: { cause: unknown }) => ({
       message: extractErrorMessage(cause),
       cause,
     }),
   });
   export type YourServiceError = InferErrors<typeof YourServiceError>;

   export const YourServiceTranscriptionServiceLive = {
	async transcribe(
		audioBlob: Blob,
		options: {
			prompt: string;
			outputLanguage: string;
			apiKey: string;
			modelName: string;
			baseURL?: string;
		},
	): Promise<Result<string, YourServiceError>> {
		if (!options.apiKey) return YourServiceError.MissingApiKey();

		return tryAsync({
			try: async () => {
				const data = await yourServiceClient.transcribe(audioBlob, options);
				return data.text.trim();
			},
			catch: (error) => YourServiceError.Unexpected({ cause: error }),
		});
	},
   };
   ```

   The call site in `src/lib/operations/transcribe.ts` decides how to present any error from the service: by default `report.error({ cause: error })` auto-derives a title from the variant name and a description from the message. Override inline only when context-specific copy or an action helps.

2. **Add the config keys the registry will point at.** API keys and endpoints are device-local and never sync. Add them to `src/lib/state/device-config.svelte.ts`:

   ```typescript
   'providers.yourservice.apiKey': defineEntry(type('string'), ''),
   ```

   The model selection syncs across devices. Add it to the transcription section of `src/lib/workspace/definition.ts`:

   ```typescript
   'transcription.yourservice.model': defineKv(
	field.string(),
	() => PROVIDERS.YourService.defaultModel as string,
   ),
   ```

3. **Register the provider facts** in `PROVIDERS` in `src/lib/services/transcription/providers.ts`:

   ```typescript
   YourService: {
     access: 'key',
     label: 'Your Service',
     description: 'What makes this service worth picking',
     capabilities: { supportsPrompt: true, supportsLanguage: true },
     apiKeyConfigKey: 'providers.yourservice.apiKey',
     modelSettingKey: 'transcription.yourservice.model',
     endpointConfigKey: null, // or a 'providers.yourservice.endpoint' override key
     modelsDoc: {
       label: 'Your Service docs',
       href: 'https://yourservice.com/docs/speech-to-text',
     },
     defaultModel: 'model-v1',
     models: [
       {
         name: 'model-v1',
         description: 'What makes this model special',
         cost: '$0.XX/hour',
       },
     ],
   },
   ```

   The suffix names the store: `*ConfigKey` fields hold `deviceConfig` key names, `*SettingKey` fields hold synced `settings` key names. Everything downstream resolves these pointers instead of hardcoding keys.

4. **Fix the compile errors the registry entry creates.** Each of these tables is exhaustive over the provider ids, so the type checker walks you to them:

   - `UPLOAD_DISPATCH` in `src/lib/operations/transcribe.ts`: map your id to `YourServiceTranscriptionServiceLive.transcribe`.
   - `PROVIDER_ICONS` in `src/lib/services/transcription/provider-ui.ts`: add your SVG icon.
   - `PROVIDER_FIELDS` in `src/lib/components/settings/ProviderConfigFields.svelte`: declare the API key (and optional endpoint) fields with their labels, placeholders, and docs links. This is where provider-specific copy lives, like where to find the API key.

That's the whole integration. The Privacy & Processing surface, the quick-pick selector, the configuration warning badge, and the dispatcher need no edits; they all render and resolve through the registry entry. Endpoint and on-device providers get bespoke sections in `src/lib/components/settings/TranscriptionRuntimeConfig.svelte`, because their setup instructions are the product copy.

##### Adding an AI Transformation Adapter

AI transformations use completion services. The same registry scheme applies: `INFERENCE` in `src/lib/constants/inference.ts` owns the provider facts, `COMPLETION_PROVIDERS` in `src/lib/operations/transform.ts` owns the service wiring and config-key pointers, and `deviceConfig` owns the credential values.

1. **Create the completion service** in `src/lib/services/completion/`:

   ```typescript
   // src/lib/services/completion/your-provider.ts
   import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
   import { tryAsync, type Result } from 'wellcrafted/result';

   export const YourProviderError = defineErrors({
     MissingApiKey: () => ({ message: 'YourProvider API key is required' }),
     Unexpected: ({ cause }: { cause: unknown }) => ({
       message: extractErrorMessage(cause),
       cause,
     }),
   });
   export type YourProviderError = InferErrors<typeof YourProviderError>;

   export const YourProviderCompletionServiceLive = {
	async complete(options: {
		apiKey: string;
		model: string;
		systemPrompt: string;
		userPrompt: string;
		baseUrl?: string;
	}): Promise<Result<string, YourProviderError>> {
		if (!options.apiKey) return YourProviderError.MissingApiKey();

		return tryAsync({
			try: async () => {
				const data = await yourProviderClient.complete(options);
				return data.text;
			},
			catch: (error) => YourProviderError.Unexpected({ cause: error }),
		});
	},
   };
   ```

2. **Register the service** in `src/lib/services/completion/index.ts`:

   ```typescript
   import { YourProviderCompletionServiceLive } from './your-provider';

   export {
	// ... existing exports
	YourProviderCompletionServiceLive as yourprovider,
   };
   ```

3. **Add the API key** to `src/lib/state/device-config.svelte.ts`:

   ```typescript
   'providers.yourprovider.apiKey': defineEntry(type('string'), ''),
   ```

4. **Register the provider** in `INFERENCE` in `src/lib/constants/inference.ts` (label, `stepModelField`, models), and add the matching step model field (for example `yourproviderModel: field.string()`) to the transformation step schema in `src/lib/workspace/definition.ts`.

5. **Fix the compile errors the `INFERENCE` entry creates**:

   - `COMPLETION_PROVIDERS` in `src/lib/operations/transform.ts`: your service plus its `apiKeyConfigKey` and `endpointConfigKey` pointers.
   - `PROVIDER_FIELDS` in `src/lib/components/settings/ProviderConfigFields.svelte`: the API key field with its label and docs link.

   The transformation step editor reads providers and models from `INFERENCE`; no UI switch statements to extend.

##### Error Handling Best Practices

Services return tagged errors via `defineErrors`. The call site decides what the user sees by calling `report.error`, `report.info`, `report.success`, or `report.loading` from `$lib/report`. The toast and OS notification surfaces are sinks the spine fans out to.

```typescript
// Service: return a tagged error, not pre-baked UI copy.
return YourServiceError.RateLimit({ retryAfterSec });

// Call site: default rendering auto-derives the title from the variant name
// ("Rate limit") and the description from the error's message field.
if (error) {
	report.error({ cause: error });
	return;
}

// Inline override only when context-specific copy or an action helps.
if (error.name === 'Unauthorized') {
	report.error({
		cause: error,
		title: 'Authentication required',
		action: { label: 'Update API key', onClick: () => goto('/settings') },
	});
	return;
}

// Pair with tryAsync for catch-side error construction.
const { data, error } = await tryAsync({
	try: () => apiClient.makeRequest(),
	catch: (cause) => YourServiceError.Unexpected({ cause }),
});
```

##### Testing Your Adapter

Create a test file alongside your service:

```typescript
// Example: src/lib/services/transcription/cloud/your-service.test.ts
import { describe, it, expect } from 'vitest';
import { YourServiceTranscriptionServiceLive } from './your-service';

describe('YourService Transcription', () => {
	it('should handle missing API key', async () => {
		const result = await YourServiceTranscriptionServiceLive.transcribe(new Blob(), {
			apiKey: '',
			// other options
		} as any);

		expect(result.error).toBeDefined();
		expect(result.error?.name).toBe('MissingApiKey');
	});

	// Add more tests
});
```

##### Example PR Structure

When submitting a PR for a new adapter, include:

- The service implementation with comprehensive error handling
- The registry entry plus the dispatcher, icon, and `PROVIDER_FIELDS` entries it demands
- The config keys in `deviceConfig` and, for transcription, the synced model key
- Tests covering success and error cases
- Documentation of any special requirements or limitations
- Example `.env` entries if needed

We're excited to see what services you'll integrate! Feel free to open an issue first to discuss your adapter idea.

#### Contributing Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes and commit them
4. Push to your fork: `git push origin your-branch-name`
5. Create a pull request

#### Version Bumping

When preparing a new release, use our version bumping script to update all necessary files:

```bash
# Update version across all project files
bun run bump-version <new-version>

# Example:
bun run bump-version 7.0.1
```

This script automatically updates:

- Root `package.json`
- App `package.json`
- Tauri configuration (`tauri.conf.json`)
- Cargo manifest (`Cargo.toml`)

After running the script, follow the displayed instructions to commit, tag, and push the changes.

#### Good First Issues

- UI/UX improvements and accessibility enhancements
- Performance optimizations
- New transcription or transformation service integrations

Feel free to suggest and implement any features that improve usability. I'll do my best to integrate contributions that make Whispering better for everyone.

## Acknowledgments

### Local Transcription

Whispering's local transcription capabilities are powered by amazing open-source projects:

- **[transcribe-rs](https://github.com/cjpais/transcribe-rs)** by [CJ Pais](https://github.com/cjpais) - A unified Rust library providing abstraction over multiple speech-to-text engines (Whisper, Parakeet, and Moonshine). This library enables Whispering to seamlessly support different transcription engines with a consistent API.

- **[Handy](https://github.com/cjpais/handy)** by [CJ Pais](https://github.com/cjpais) - The original project that birthed `transcribe-rs`. Handy is a an awesome cross-platform desktop speech-to-text application, and I personally use it especially when developing Whispering locally.

- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** by Georgi Gerganov - High-performance C/C++ port of OpenAI's Whisper model that makes local transcription fast and efficient.

Special thanks to [CJ Pais](https://github.com/cjpais) for creating and maintaining essential libraries that make local, privacy-preserving transcription possible in Whispering.

## Support and Community

### License

Whispering is released under the [AGPLv3 License](../../LICENSE). Fork it, modify it, build on top of it, make it yours.

### Support and Feedback

We're built in public, shaped by user feedback. If you encounter any issues or have suggestions for improvements, please open an issue on the [GitHub issues tab](https://github.com/EpicenterHQ/epicenter/issues). I really appreciate it!

- Community Discord: [Discord](https://go.epicenterhq.com/discord)
- Feature Requests, Issues, and Bug Reports: [GitHub Issues](https://github.com/EpicenterHQ/epicenter/issues)

### Sponsors

This project is supported by amazing people and organizations:

<!-- sponsors --><a href="https://github.com/DavidGP"><img src="https:&#x2F;&#x2F;github.com&#x2F;DavidGP.png" width="60px" alt="User avatar: " /></a><a href="https://github.com/Wstnn"><img src="https:&#x2F;&#x2F;github.com&#x2F;Wstnn.png" width="60px" alt="User avatar: " /></a><a href="https://github.com/rkhrkh"><img src="https:&#x2F;&#x2F;github.com&#x2F;rkhrkh.png" width="60px" alt="User avatar: " /></a><a href="https://github.com/doxgt"><img src="https:&#x2F;&#x2F;github.com&#x2F;doxgt.png" width="60px" alt="User avatar: " /></a><a href="https://github.com/OLH21"><img src="https:&#x2F;&#x2F;github.com&#x2F;OLH21.png" width="60px" alt="User avatar: Olivier H" /></a><a href="https://github.com/noboomu"><img src="https:&#x2F;&#x2F;github.com&#x2F;noboomu.png" width="60px" alt="User avatar: JL Bauer" /></a><a href="https://github.com/syntaxsurge"><img src="https:&#x2F;&#x2F;github.com&#x2F;syntaxsurge.png" width="60px" alt="User avatar: Jade Laurence Empleo" /></a><a href="https://github.com/christabone"><img src="https:&#x2F;&#x2F;github.com&#x2F;christabone.png" width="60px" alt="User avatar: Chris Tabone" /></a><!-- sponsors -->

---

Transcription should be free, open, and accessible to everyone. Join us in making it so.
