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

This bot is designed to be deployed on Render.com's free tier. You can use the included `render.yaml` file for easy deployment.
You will need a Render account to deploy this bot.
When deploying on Render, ensure you set it up as a 'Web Service'.

**Important Note for Render's Free Tier:**

Render's free tier web services will automatically spin down after 15 minutes of inactivity (see https://render.com/docs/free for more details). This means your bot will stop checking for new mentions if it doesn't receive any web traffic.

To keep your bot alive and continuously checking for mentions, it's recommended to use an external cron job service to periodically send a request to your bot's health check endpoint. A popular free option is [cron-job.org](https://cron-job.org/en/).

Here's how you can set it up using an external service like cron-job.org:

1.  **Sign up or log in** to the external cron job service (e.g., [cron-job.org](https://cron-job.org/en/)).
2.  **Create a new cron job.**
3.  **Set the URL to call:** This will be your Render service's public URL, pointing to the `/health` endpoint. It will look something like `https://your-bot-name.onrender.com/health`. Make sure your bot's code has a `/health` endpoint that returns a 200 OK response (this project already includes one in `index.js`).
4.  **Set the schedule (Execution time):** A common schedule is every 10 to 14 minutes to ensure the service doesn't spin down. For example, on cron-job.org, you can select "Every 10 minutes".
5.  **Save the cron job.**

This setup will send a request to your bot at regular intervals, preventing it from spinning down due to inactivity.

## Local Development

1. Clone this repository
2. Create a `.env` file with the required environment variables
3. Run `npm install`
4. Run `npm start`

## License

ISC
