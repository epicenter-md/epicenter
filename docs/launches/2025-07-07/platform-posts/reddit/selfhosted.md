# Reddit r/selfhosted Post

## Title
Whispering - Self-hosted transcription using your own API keys (no subscription required)

## Post Content

Hey r/selfhosted!

I built Whispering because I was tired of transcription services charging $30/month for what's essentially an API wrapper. It's not self-hosted in the traditional sense, but it embodies the same principles we care about here.

Here's the deal: you bring your own API key (OpenAI, Groq, whatever), and the app makes direct calls from your machine. No middleman servers, no subscription fees, no data leaving your control. You pay the actual API costs - about $0.006/minute or $0.36/hour.

I've been using it daily for months. My total cost? About $3/month going directly to Groq. If I used a commercial service, I'd be paying $30/month for the exact same API calls.

The privacy aspect is what really matters to me. Your audio goes directly from your machine to your chosen API provider. No company in between logging your conversations or training on your data. API keys are encrypted locally. Zero telemetry.

It's a native desktop app built with Tauri, so it's tiny (~22MB) and runs without Docker. Works on Mac, Windows, and Linux. Has all the features you'd expect - real-time transcription, multiple languages, export formats, global hotkeys.

The code is 100% open source. You can audit exactly what it does with your data (spoiler: nothing except send it to your chosen API).

I know it's not traditional self-hosting since it uses external APIs, but it gives you the same control and ownership we value here. No SaaS lock-in, transparent costs, and your data stays yours.

GitHub: https://github.com/epicenter-md/epicenter

Anyone else tired of subscription services for basic utilities?