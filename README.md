# Dearest Llama (Modified for Nvidia NIM)

A Bluesky bot that responds to mentions with Llama 4 Maverick and generates images with Nvidia NIM Flux Dev.

## Environment Variables

### Required Environment Variables

- `NVIDIA_NIM_API_KEY`: Your Nvidia NIM API key
- `BLUESKY_IDENTIFIER`: Your Bluesky handle (e.g., `username.bsky.social`)
- `BLUESKY_APP_PASSWORD`: Your Bluesky app password

### Optional Environment Variables

#### Model Configuration
- `TEXT_MODEL`: Model for text generation (default: `meta/llama-4-maverick-17b-128e-instruct`)
- `IMAGE_PROMPT_MODEL`: Model for image prompt generation (default: `meta/llama-4-scout-17b-16e-instruct`)
- `IMAGE_GENERATION_MODEL`: Model for image generation (default: `black-forest-labs/flux_1-dev`)

#### System Prompts (Customizable)
- `TEXT_SYSTEM_PROMPT`: System prompt for text generation (default: "You are part of a bot designed to respond to a conversation on Bluesky. You will write a reply, and another part of the bot will post it. Keep your responses under 300 characters.")
- `IMAGE_PROMPT_SYSTEM_PROMPT`: System prompt for image prompt generation (default: "Create a prompt for an image model based on the following question and answer. If the prompt doesn't already have animals in it, add cats.")

#### Other Settings
- `CHECK_INTERVAL`: Milliseconds between checks for new mentions (default: `60000`)
- `MAX_RETRIES`: Maximum number of retries for failed operations (default: `5`)
- `BACKOFF_DELAY`: Base delay in milliseconds for exponential backoff (default: `60000`)
- `MAX_REPLIED_POSTS`: Maximum number of posts to track as replied (default: `1000`)

## Deployment

This bot is designed to be deployed on Render.com. You can use the included `render.yaml` file for easy deployment.

## Local Development

1. Clone this repository
2. Create a `.env` file with the required environment variables
3. Run `npm install`
4. Run `npm start`

## Changes from Original Repository

See [CHANGES.md](./CHANGES.md) for a detailed list of modifications from the original Dearest Claude repository.

## License

ISC
