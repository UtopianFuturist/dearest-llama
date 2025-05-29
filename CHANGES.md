# Dearest Llama - Changes from Original Repository

This repository is a modified version of the original [Dearest Claude](https://github.com/timfduffy/dearest-claude) repository, with several significant changes to modernize the codebase and switch to Nvidia NIM API and Llama models.

## Major Changes

### 1. Provider Change
- **Original**: Used Anthropic API for text generation and FAL AI for image generation
- **Modified**: Uses Nvidia NIM API for both text generation and image generation

### 2. Model Changes
- **Text Model**: Changed from Claude Sonnet 4 to Llama 4 Maverick 17b 128e instruct
- **Image Prompt Model**: Changed from Claude 3.5 Haiku to Llama 4 Scout 17b 16e instruct
- **Image Generation Model**: Changed from FAL AI Flux Schnell to Nvidia NIM Flux Dev

### 3. Removed Models
- Removed all DeepSeek and Gemini model references and implementations
- Simplified to a single bot implementation (LlamaBot) instead of multiple bots

### 4. Environment Variable Improvements
- Made model names configurable via environment variables
- Made system prompts configurable via environment variables
- Renamed authentication variables from Claude-specific to generic Bluesky variables

### 5. Code Cleanup
- Removed unused dependencies
- Streamlined authentication and API handling
- Updated documentation to reflect all changes

## API References

- [Llama 4 Maverick 17b 128e instruct](https://build.nvidia.com/meta/llama-4-maverick-17b-128e-instruct/modelcard)
- [Llama 4 Scout 17b 16e instruct](https://build.nvidia.com/meta/llama-4-scout-17b-16e-instruct/modelcard)
- [Flux Dev](https://build.nvidia.com/black-forest-labs/flux_1-dev)

## Deployment

This bot is designed to be deployed on Render.com using the included `render.yaml` file. Make sure to set all required environment variables in your Render dashboard.
