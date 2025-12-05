# Transcription Services

This directory organizes transcription providers (service implementations). Since there are many, we further organize them into three folders:

**`/cloud`**: API-based services that send audio to external providers. Require API keys and internet connection.

**`/local`**: On-device processing that runs on the user's machine. Require model files but work offline.

**`/self-hosted`**: Services that connect to servers you deploy yourself on your own machine. You provide the base URL of your own instance.
