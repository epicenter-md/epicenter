# Using Custom Endpoints for Local AI Transformations

**Transform your transcribed text with local AI models—completely offline and privacy-preserving.**

This guide walks you through setting up and using custom API endpoints (Ollama, LM Studio, llama.cpp) for transformations in Whispering. With this feature, you can run AI-powered text transformations entirely on your local machine without sending data to cloud services.

---

## Table of Contents

1. [What is a Custom Endpoint?](#what-is-a-custom-endpoint)
2. [Why Use Local Models?](#why-use-local-models)
3. [Supported Tools](#supported-tools)
4. [Setup Guide: Ollama](#setup-guide-ollama)
5. [Setup Guide: LM Studio](#setup-guide-lm-studio)
6. [Setup Guide: llama.cpp](#setup-guide-llamacpp)
7. [Configuring Whispering](#configuring-whispering)
8. [Creating Your First Transformation](#creating-your-first-transformation)
9. [Example Use Cases](#example-use-cases)
10. [Troubleshooting](#troubleshooting)
11. [FAQ](#faq)

---

## What is a Custom Endpoint?

A custom endpoint allows you to use any OpenAI-compatible API server for text transformations. Instead of sending your transcribed text to cloud services like OpenAI or Anthropic, you can run AI models locally on your own computer.

**How it works:**

1. You run a local inference server (like Ollama) on your machine
2. Whispering sends transformation requests to `http://localhost:PORT/v1`
3. The local model processes your text completely offline
4. Results are returned instantly without any cloud service involved

---

## Why Use Local Models?

✅ **Complete Privacy** - Your data never leaves your machine  
✅ **No API Costs** - Free inference with your own hardware  
✅ **Offline Usage** - Work without internet connection  
✅ **Data Compliance** - Meet enterprise security requirements  
✅ **Fast Processing** - No network latency (with good hardware)  
✅ **Full Control** - Choose any model that fits your needs

---

## Supported Tools

Whispering works with any OpenAI-compatible API server. Popular options:

| Tool          | Best For                      | Difficulty      | Platform              |
| ------------- | ----------------------------- | --------------- | --------------------- |
| **Ollama**    | Beginners, Mac users          | ⭐ Easy         | macOS, Linux, Windows |
| **LM Studio** | Desktop GUI users             | ⭐ Easy         | macOS, Windows, Linux |
| **llama.cpp** | Advanced users, customization | ⭐⭐ Moderate   | macOS, Linux, Windows |
| **LocalAI**   | Self-hosted server            | ⭐⭐⭐ Advanced | Docker, Kubernetes    |

This guide covers the three most popular options: Ollama, LM Studio, and llama.cpp.

---

## Setup Guide: Ollama

### What is Ollama?

Ollama is the easiest way to run large language models locally. It's like Docker for AI models—simple, fast, and works out of the box.

### Installation

#### macOS

```bash
# Download and install from the website
# Visit: https://ollama.com/download

# Or use Homebrew
brew install ollama
```

#### Linux

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

#### Windows

1. Download the installer from [ollama.com/download](https://ollama.com/download)
2. Run the `.exe` file
3. Follow the installation wizard

### Starting Ollama

```bash
# Start the Ollama server
ollama serve
```

**Note:** Keep this terminal window open. Ollama needs to be running for Whispering to connect to it.

You should see output like:

```
Listening on 127.0.0.1:11434 (version 0.x.x)
```

### Downloading Models

Ollama makes it super easy to download models:

```bash
# Recommended models for transformations

# Llama 3.2 (3B) - Fast, great for summarization
ollama pull llama3.2

# Mistral (7B) - Balanced performance
ollama pull mistral

# Phi-3 (3.8B) - Efficient, Microsoft's model
ollama pull phi3

# Gemma 2 (9B) - Google's model, excellent quality
ollama pull gemma2:9b
```

**Model Size Guide:**

- **2-4B parameters**: Fast, good for simple tasks (summaries, formatting)
- **7-9B parameters**: Balanced, handles most tasks well
- **13B+ parameters**: Best quality, needs more RAM/VRAM

### Verify Installation

```bash
# List installed models
ollama list

# Test a model
ollama run llama3.2 "Say hello in one sentence"

# Check if the API is running
curl http://localhost:11434/api/tags
```

### Configuration for Whispering

When creating a transformation in Whispering:

- **Provider**: `CustomEndpoint`
- **API Base URL**: `http://localhost:11434/v1`
- **Model Name**: `llama3.2` (or any model from `ollama list`)
- **API Key**: Leave empty (not required)

---

## Setup Guide: LM Studio

### What is LM Studio?

LM Studio is a desktop app with a beautiful GUI for running local models. Great if you prefer visual interfaces over command-line tools.

### Installation

1. **Download LM Studio**
   - Visit: [lmstudio.ai](https://lmstudio.ai)
   - Click "Download for [Your OS]"
   - Supported: macOS (Apple Silicon & Intel), Windows, Linux

2. **Install the Application**
   - macOS: Open the `.dmg` and drag to Applications
   - Windows: Run the installer `.exe`
   - Linux: Extract and run the AppImage

3. **Launch LM Studio**
   - Open the application
   - You'll see the main interface with a model browser

### Downloading Models

1. **Open the Model Browser**
   - Click the 🔍 search icon in the sidebar
2. **Search for Models**
   - Try searching: `llama`, `mistral`, `phi`, `gemma`
3. **Download a Model**
   - Click on a model (e.g., "Llama 3.2 3B Instruct")
   - Click the download button
   - Wait for download to complete (can be 2-10GB depending on model)

**Recommended Models in LM Studio:**

- `Llama-3.2-3B-Instruct-Q4_K_M.gguf` - Fast and efficient
- `Mistral-7B-Instruct-v0.3-Q4_K_M.gguf` - Excellent quality
- `Phi-3-mini-4k-instruct-Q4_K_M.gguf` - Very fast

### Starting the Local Server

1. **Load a Model**
   - Go to the "Chat" tab (💬)
   - Click "Select a model" at the top
   - Choose your downloaded model
   - Wait for it to load (you'll see progress)

2. **Start the Server**
   - Click the "↔️ Local Server" tab in the sidebar
   - Click "Start Server"
   - Default port is `1234`
   - You'll see: "Server running on http://localhost:1234"

3. **Verify Server Status**
   - Look for the green "Running" indicator
   - The interface shows request logs when active

### Configuration for Whispering

When creating a transformation in Whispering:

- **Provider**: `CustomEndpoint`
- **API Base URL**: `http://localhost:1234/v1`
- **Model Name**: Check LM Studio's server tab for the exact model name
  - Usually shown as: `TheBloke/Llama-2-7B-Chat-GGUF` or similar
  - Or use the model filename without `.gguf` extension
- **API Key**: Leave empty (not required)

**Tip:** Keep the LM Studio app open with the server running while using Whispering.

---

## Setup Guide: llama.cpp

### What is llama.cpp?

llama.cpp is a C++ implementation of LLaMA inference—fast, efficient, and highly customizable. Best for advanced users who want fine-grained control.

### Installation

#### macOS

```bash
# Using Homebrew
brew install llama.cpp

# Or build from source
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
make

# For Apple Silicon (M1/M2/M3), use Metal acceleration
make LLAMA_METAL=1
```

#### Linux

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install build-essential git

# Clone and build
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
make

# For NVIDIA GPU support
make LLAMA_CUDA=1

# For AMD GPU support
make LLAMA_HIPBLAS=1
```

#### Windows

```bash
# Using CMake (requires Visual Studio Build Tools)
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
cmake -B build
cmake --build build --config Release
```

### Downloading Models

llama.cpp uses GGUF model files. Download from Hugging Face:

```bash
# Create models directory
mkdir -p models
cd models

# Download a model (example: Llama 3.2 3B)
# Visit: https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF
# Download a Q4_K_M or Q5_K_M quantized file

# Example using wget
wget https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf
```

**Popular Model Sources:**

- [TheBloke on Hugging Face](https://huggingface.co/TheBloke) - Hundreds of quantized models
- [bartowski on Hugging Face](https://huggingface.co/bartowski) - Latest models

### Starting the Server

```bash
# Navigate to llama.cpp directory
cd llama.cpp

# Start the server with your model
./server \
  -m ./models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  --port 8080 \
  --host 127.0.0.1 \
  -c 2048

# For Apple Silicon (M1/M2/M3), add Metal support
./server \
  -m ./models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  --port 8080 \
  --host 127.0.0.1 \
  -c 2048 \
  -ngl 999

# For NVIDIA GPU
./server \
  -m ./models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
  --port 8080 \
  --host 127.0.0.1 \
  -c 2048 \
  -ngl 35
```

**Parameter Explanation:**

- `-m` : Path to model file
- `--port` : Server port (default: 8080)
- `--host` : Server address
- `-c` : Context size (how much text model can process)
- `-ngl` : Number of GPU layers (use 999 for all layers on GPU)

### Verify Server is Running

```bash
# Check server status
curl http://localhost:8080/health

# List loaded models
curl http://localhost:8080/v1/models
```

### Configuration for Whispering

When creating a transformation in Whispering:

- **Provider**: `CustomEndpoint`
- **API Base URL**: `http://localhost:8080/v1`
- **Model Name**: Use the exact model name from the GGUF filename
  - Example: `Llama-3.2-3B-Instruct-Q4_K_M`
- **API Key**: Leave empty (not required)

---

## Configuring Whispering

Once you have a local inference server running, configure Whispering to use it.

### Step 1: Open Transformations

1. Launch Whispering
2. Navigate to **Transformations** in the sidebar
3. Click **"+ New Transformation"**

### Step 2: Create a Transformation

1. **Basic Details:**
   - **Title**: Give it a descriptive name (e.g., "Summarize with Ollama")
   - **Description**: Optional description of what it does

2. **Add a Step:**
   - Click **"Add Your First Step"**
   - Select **"Prompt Transform"** as the step type

### Step 3: Configure Custom Endpoint

1. **Select Provider:**
   - Choose **"CustomEndpoint"** from the Provider dropdown

2. **API Base URL:**
   - Ollama: `http://localhost:11434/v1`
   - LM Studio: `http://localhost:1234/v1`
   - llama.cpp: `http://localhost:8080/v1`

3. **Model Name:**
   - Ollama: Use model name from `ollama list` (e.g., `llama3.2`)
   - LM Studio: Check the server tab for model name
   - llama.cpp: Use GGUF filename without extension

4. **System Prompt Template:**

   ```
   You are a helpful assistant that processes transcribed speech.
   ```

5. **User Prompt Template:**

   ```
   Please summarize the following text in 2-3 concise sentences:

   {{input}}
   ```

   **Important:** Always include `{{input}}` where you want the transcribed text to appear.

### Step 4: Save and Activate

1. Click **"Save"** to save your transformation
2. Click the **circle icon** next to your transformation to activate it
3. The icon will turn into a **green checkmark** when active

**Note:** Only ONE transformation can be active at a time. When active, it will automatically run on all future transcriptions.

---

## Creating Your First Transformation

Let's create a practical example: a meeting notes summarizer.

### Example 1: Meeting Summarizer

**Use Case:** Convert voice-recorded meeting discussions into structured bullet points.

**Configuration:**

- **Title**: "Meeting Notes Formatter"
- **Provider**: CustomEndpoint
- **Base URL**: `http://localhost:11434/v1`
- **Model**: `llama3.2`

**System Prompt:**

```
You are an expert note-taker who creates clear, structured summaries of meetings.
```

**User Prompt:**

```
Convert this meeting transcript into organized bullet points:

{{input}}

Format as:
• Key Discussion Points
• Decisions Made
• Action Items
```

### Example 2: Email Draft Generator

**Use Case:** Turn voice notes into professional email drafts.

**Configuration:**

- **Title**: "Voice to Email"
- **Provider**: CustomEndpoint
- **Base URL**: `http://localhost:11434/v1`
- **Model**: `mistral`

**System Prompt:**

```
You are a professional communication expert who writes clear, polite emails.
```

**User Prompt:**

```
Turn this voice note into a professional email:

{{input}}

Include:
- A clear subject line
- Proper greeting
- Well-structured body
- Professional closing
```

### Example 3: Code Documentation

**Use Case:** Explain technical concepts or code snippets in simple terms.

**Configuration:**

- **Title**: "Technical Explainer"
- **Provider**: CustomEndpoint
- **Base URL**: `http://localhost:11434/v1`
- **Model**: `gemma2:9b`

**System Prompt:**

```
You are a technical writer who explains complex topics in simple, clear language.
```

**User Prompt:**

```
Explain the following technical content in simple terms:

{{input}}

Make it understandable for non-technical readers.
```

### Example 4: Multi-Step Transformation

**Use Case:** Clean up transcription artifacts, then summarize.

**Step 1 - Cleanup (Find/Replace):**

- Type: Find/Replace
- Find: `umm`
- Replace: `` (empty)

**Step 2 - Summarize (Prompt Transform):**

- Provider: CustomEndpoint
- Base URL: `http://localhost:11434/v1`
- Model: `llama3.2`
- System: `You create concise summaries.`
- User: `Summarize: {{input}}`

This chains two operations: first removes filler words, then summarizes the cleaned text.

---

## Example Use Cases

### For Content Creators

- Convert video scripts into blog posts
- Generate social media captions from video transcripts
- Create podcast show notes automatically

### For Professionals

- Summarize client calls
- Generate meeting minutes
- Draft follow-up emails from meetings
- Create project status reports from standups

### For Students

- Summarize lecture recordings
- Convert study notes into flashcard format
- Generate essay outlines from brainstorming sessions

### For Developers

- Document code explanations
- Generate commit messages from code review discussions
- Create API documentation from verbal descriptions

### For Writers

- Transcribe and organize story ideas
- Generate character descriptions from notes
- Create plot summaries from brainstorming sessions

---

## Troubleshooting

### Ollama Issues

#### "Unable to connect to http://localhost:11434"

**Solution:**

```bash
# Check if Ollama is running
ps aux | grep ollama

# If not running, start it
ollama serve

# Verify it's listening
curl http://localhost:11434/api/tags
```

#### "Model not found: llama3.2"

**Solution:**

```bash
# List installed models
ollama list

# Pull the model if missing
ollama pull llama3.2

# Use exact model name from the list
```

#### "Pull model manifest: read tcp... can't assign requested address"

**Solution:**

```bash
# Network connectivity issue - try:
1. Disconnect VPN temporarily
2. Check firewall settings
3. Restart networking:
   sudo killall -HUP mDNSResponder

# Or restart your computer
```

#### Ollama is slow on Mac

**Solution:**

```bash
# Ensure Metal acceleration is enabled (Apple Silicon)
# Check: System Settings → Privacy & Security → Full Disk Access
# Add: /usr/local/bin/ollama

# Use smaller models for faster inference
ollama pull llama3.2  # 3B model, much faster than 70B
```

### LM Studio Issues

#### Server won't start

**Solution:**

1. Check if another app is using port 1234
2. Close and restart LM Studio
3. Try changing the port in server settings
4. Ensure model is fully loaded before starting server

#### "Model not found" error

**Solution:**

- Copy the EXACT model name from LM Studio's server tab
- Don't include the `.gguf` extension
- Model names are case-sensitive

#### App crashes when loading large models

**Solution:**

- Use quantized models (Q4_K_M or Q5_K_M)
- Close other apps to free up RAM
- Check if you have enough disk space
- Try smaller models (3B or 7B instead of 13B+)

### llama.cpp Issues

#### Server won't start

**Solution:**

```bash
# Check if port is already in use
lsof -i :8080

# Kill any process using that port
kill -9 <PID>

# Or use a different port
./server -m model.gguf --port 8081
```

#### "Failed to load model"

**Solution:**

- Verify GGUF file is not corrupted
- Check file permissions: `chmod +r model.gguf`
- Ensure you have enough RAM for the model
- Try a smaller quantization (Q4_K_M instead of Q8)

#### Slow inference / Using CPU instead of GPU

**Solution:**

```bash
# For Apple Silicon - rebuild with Metal
make clean
make LLAMA_METAL=1

# For NVIDIA GPU
make clean
make LLAMA_CUDA=1

# Use -ngl parameter to offload layers to GPU
./server -m model.gguf -ngl 999  # All layers on GPU
```

### Whispering Issues

#### Transformation fails silently

**Solution:**

1. Check browser DevTools console for errors (F12)
2. Verify the base URL is correct (with `/v1` at the end)
3. Test the endpoint directly:
   ```bash
   curl http://localhost:11434/v1/models
   ```
4. Check that model name matches exactly

#### "API returned an empty response"

**Solution:**

- Model might be overloaded (wait a moment and retry)
- Prompt might be too long (reduce input size)
- Model might not support system prompts (try removing it)

#### Transformation is very slow

**Solution:**

- Use smaller models (3B-7B instead of 13B+)
- Enable GPU acceleration in your inference server
- Reduce context size in llama.cpp
- Close other apps to free up resources

### General Tips

#### Finding the Right Model

**For Speed (on older hardware):**

- Ollama: `llama3.2` (3B)
- LM Studio: Any Q4_K_M model under 7B
- llama.cpp: Q4_K_M quantizations

**For Quality (on newer hardware):**

- Ollama: `mistral` or `gemma2:9b`
- LM Studio: Q5_K_M or Q6_K models
- llama.cpp: Q8 quantizations

**For Balance:**

- 7B models with Q5_K_M quantization
- Works well on most modern laptops

#### Monitoring Performance

```bash
# Check CPU/RAM usage (macOS)
top

# Check GPU usage (macOS)
sudo powermetrics --samplers gpu_power -i1000

# Check GPU usage (NVIDIA Linux)
nvidia-smi

# Watch llama.cpp inference stats
# Stats are printed in the terminal where server is running
```

---

## FAQ

### Do I need an API key for local models?

**No.** Local inference servers like Ollama, LM Studio, and llama.cpp don't require API keys. Leave the API Key field empty in Whispering.

### Can I use cloud services and local models simultaneously?

**No.** Only one transformation can be active at a time. However, you can:

1. Create multiple transformations (some using OpenAI, others using local models)
2. Switch between them by clicking the activation button
3. The active transformation runs on all future transcriptions

### Which model should I use?

**It depends on your hardware:**

| Hardware                    | Recommended Model        | Size  |
| --------------------------- | ------------------------ | ----- |
| MacBook Air M1/M2           | llama3.2, phi3           | 3-4B  |
| MacBook Pro M1/M2/M3        | mistral, gemma2:9b       | 7-9B  |
| Windows laptop (16GB RAM)   | llama3.2, mistral        | 3-7B  |
| Desktop with GPU (8GB VRAM) | mistral, llama2:13b      | 7-13B |
| High-end workstation        | mixtral:8x7b, llama3:70b | 40B+  |

### How much disk space do models take?

**Approximate sizes:**

- 3B model (Q4): ~2 GB
- 7B model (Q4): ~4 GB
- 13B model (Q4): ~7 GB
- 70B model (Q4): ~40 GB

### Can I use remote servers?

**Yes!** You can run the inference server on another machine and use its IP:

```
http://192.168.1.100:11434/v1  # Local network
http://your-server.com:11434/v1  # Internet (ensure firewall allows)
```

**Security Warning:** Only do this on trusted networks. Consider using a VPN or SSH tunnel for internet access.

### Does this work offline?

**Yes!** Once models are downloaded:

1. Start your local inference server
2. Disconnect from the internet
3. Transformations will work completely offline

This is perfect for:

- Airplanes, trains, or remote locations
- Sensitive data that must stay on your device
- Avoiding API costs

### How do I switch between different tools?

Just change the **API Base URL** in your transformation:

- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- llama.cpp: `http://localhost:8080/v1`

You can create separate transformations for each tool and switch between them.

### Can I use multiple models?

**Yes!** Create different transformations with different models:

- "Quick Summary" → llama3.2 (fast)
- "Detailed Analysis" → mistral (better quality)
- "Technical Writing" → gemma2:9b (specialized)

Switch between them as needed.

### What's the difference between providers?

| Provider               | Best For                                             |
| ---------------------- | ---------------------------------------------------- |
| **OpenAI**             | Highest quality, costs money, requires internet      |
| **Anthropic (Claude)** | Long documents, costs money, requires internet       |
| **Google (Gemini)**    | Free tier available, requires internet               |
| **Groq**               | Fast inference, free tier, requires internet         |
| **OpenRouter**         | Access to many models, requires internet             |
| **CustomEndpoint**     | Complete privacy, offline, free, needs good hardware |

### How can I improve performance?

**Software optimizations:**

1. Use GPU acceleration (Metal, CUDA, ROCm)
2. Choose smaller models (3B-7B instead of 13B+)
3. Use quantized models (Q4_K_M or Q5_K_M)
4. Reduce context size in server settings

**Hardware upgrades:**

1. More RAM (16GB minimum, 32GB recommended)
2. Better GPU (for CUDA/Metal acceleration)
3. SSD storage (faster model loading)
4. Better CPU (if not using GPU)

### Can I fine-tune models for my use case?

**Yes**, but it's advanced:

1. Fine-tune using tools like Axolotl or LLaMA Factory
2. Export as GGUF format
3. Load in llama.cpp or LM Studio
4. Use the custom model with Whispering

This is beyond the scope of this guide. Check out [Hugging Face documentation](https://huggingface.co/docs) for fine-tuning guides.

### Is my data really private?

**Yes**, when using local models:

- ✅ No data sent to cloud services
- ✅ All processing happens on your device
- ✅ No telemetry or tracking (depends on the tool)
- ✅ Works completely offline

**However:**

- Ollama, LM Studio, and llama.cpp may check for updates (can be disabled)
- Models are downloaded from the internet initially
- Always review privacy policies of the tool you choose

### Can I use this in a corporate environment?

**Yes!** This feature was specifically requested for enterprise compliance:

- ✅ Meets data residency requirements
- ✅ No third-party data processing
- ✅ Fully auditable (open-source inference servers)
- ✅ Can run on isolated networks

Perfect for:

- Healthcare (HIPAA compliance)
- Finance (PCI/SOC2 compliance)
- Government (data sovereignty)
- Legal (client confidentiality)

---

## Additional Resources

### Official Documentation

- **Ollama**: [ollama.com/docs](https://ollama.com/docs)
- **LM Studio**: [lmstudio.ai/docs](https://lmstudio.ai/docs)
- **llama.cpp**: [github.com/ggerganov/llama.cpp](https://github.com/ggerganov/llama.cpp)

### Model Repositories

- **Hugging Face**: [huggingface.co/models](https://huggingface.co/models)
- **Ollama Library**: [ollama.com/library](https://ollama.com/library)
- **TheBloke's Models**: [huggingface.co/TheBloke](https://huggingface.co/TheBloke)

### Community & Support

- **Whispering Discord**: [Join for support](https://discord.gg/whispering)
- **Ollama Discord**: [Join for Ollama help](https://discord.gg/ollama)
- **r/LocalLLaMA**: [Reddit community](https://reddit.com/r/LocalLLaMA)

### Learning Resources

- **Prompt Engineering Guide**: [promptingguide.ai](https://www.promptingguide.ai)
- **LLM Leaderboard**: [huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard](https://huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard)
- **Quantization Explained**: [github.com/ggerganov/llama.cpp/blob/master/examples/quantize/README.md](https://github.com/ggerganov/llama.cpp/blob/master/examples/quantize/README.md)

---

## Need Help?

If you encounter issues not covered in this guide:

1. **Check the Troubleshooting section** above
2. **Search GitHub Issues**: [github.com/epicenter-md/epicenter/issues](https://github.com/epicenter-md/epicenter/issues)
3. **Join our Discord**: Get help from the community
4. **Open a new issue**: Provide detailed error messages and steps to reproduce

---

**Happy transforming!** 🚀

With custom endpoints, you have complete control over your AI transformations—private, powerful, and completely free.
