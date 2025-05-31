# Dearest Llama (Modified for Nvidia NIM)

A Bluesky bot that responds to mentions with Llama 4 Scout in the `TEXT_MODEL` environment variable.

## Environment Variables

### Required Environment Variables

- `NVIDIA_NIM_API_KEY`: Your Nvidia NIM API key (used for Llama 4 Scout text generation)
You'll need a free Nvidia NIM account. You can obtain your API key from [https://build.nvidia.com/meta/llama-4-scout-17b-16e-instruct](https://build.nvidia.com/meta/llama-4-scout-17b-16e-instruct) by clicking 'Get API Key'.
- `BLUESKY_IDENTIFIER`: Your Bluesky handle (e.g., `username.bsky.social`)
- `BLUESKY_APP_PASSWORD`: Your Bluesky app password
Note: These require an active BlueSky account.

### Optional Environment Variables

#### Model Configuration
- `TEXT_MODEL`: Model for text generation (default: `meta/llama-4-maverick-17b-128e-instruct`)

#### System Prompts (Customizable)
- `TEXT_SYSTEM_PROMPT`: System prompt for text generation (default: "You are part of a bot designed to respond to a conversation on Bluesky. You will write a reply, and another part of the bot will post it. Keep your responses under 300 characters.")

#### Other Settings
- `CHECK_INTERVAL`: Milliseconds between checks for new mentions (default: `60000`)
- `MAX_RETRIES`: Maximum number of retries for failed operations (default: `5`)
- `BACKOFF_DELAY`: Base delay in milliseconds for exponential backoff (default: `60000`)
- `MAX_REPLIED_POSTS`: Maximum number of posts to track as replied (default: `1000`)

## Deployment

This bot is designed to be deployed on Render.com. You can use the included `render.yaml` file for easy deployment.
You will need a Render account to deploy this bot.
When deploying on Render, ensure you set it up as a 'Web Service'.

## Local Development

1. Clone this repository
2. Create a `.env` file with the required environment variables
3. Run `npm install`
4. Run `npm start`

## License

ISC
