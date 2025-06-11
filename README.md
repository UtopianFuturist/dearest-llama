# Dearest Llama (Modified for Nvidia NIM)

A Bluesky bot that responds to mentions with Llama 4 Scout in the `TEXT_MODEL` environment variable.

## Environment Variables

### Required Environment Variables

- `NVIDIA_NIM_API_KEY`: Your Nvidia NIM API key (used for Llama 4 Scout text generation)
You'll need a free Nvidia NIM account. You can obtain your API key from [https://build.nvidia.com/meta/llama-4-scout-17b-16e-instruct](https://build.nvidia.com/meta/llama-4-scout-17b-16e-instruct) by clicking 'Get API Key'.
- `BLUESKY_IDENTIFIER`: Your Bluesky handle (e.g., `username.bsky.social`)
- `BLUESKY_APP_PASSWORD`: Your Bluesky app password
- `ADMIN_BLUESKY_HANDLE`: (Required for admin features) The Bluesky handle of the bot's administrator (e.g., `adminuser.bsky.social`). Only this user can issue admin commands.
Note: These require an active BlueSky account.

### Optional Environment Variables

#### Model Configuration
- `TEXT_MODEL`: Model for text generation (default: `meta/llama-4-maverick-17b-128e-instruct`)

#### System Prompts (Customizable)
- `TEXT_SYSTEM_PROMPT`: System prompt for text generation (default: "You are part of a bot designed to respond to a conversation on Bluesky. You will write a reply, and another part of the bot will post it. Keep your responses under 300 characters.")

#### Additional Render Variables
- `CHECK_INTERVAL`: Milliseconds between checks for new mentions (default: `60000`)
- `MAX_RETRIES`: Maximum number of retries for failed operations (default: `5`)
- `BACKOFF_DELAY`: Base delay in milliseconds for exponential backoff (default: `60000`)
- `MAX_REPLIED_POSTS`: Maximum number of posts to track as replied (default: `1000`)

## Admin Features

These features are intended for use by the bot administrator, whose Bluesky handle is set via the `ADMIN_BLUESKY_HANDLE` environment variable.

### Configuration

-   `ADMIN_BLUESKY_HANDLE`: (Already listed under Required Environment Variables, but reiterated here for clarity in the context of admin features) The Bluesky handle of the bot's administrator (e.g., `adminuser.bsky.social`). Only this user can issue admin commands. This variable is required if you intend to use any admin commands.

### Commands

#### `!post` Command

The `!post` command allows the administrator to instruct the bot to create a new, standalone post on its own profile. This post is generated based on the context of the thread where the `!post` command is issued, combined with any specific instructions provided by the admin.

-   **Admin-only**: This command can only be triggered by the user specified in `ADMIN_BLUESKY_HANDLE`.
-   **Function**:
    1.  The bot fetches the conversation context from the thread where the `!post` command was made.
    2.  It then uses its underlying language model (Llama 4 Scout) to understand this context.
    3.  Based on this understanding and any additional instructions, it generates a new standalone post, adopting the bot's configured persona.
    4.  This new post is then published directly to the bot's own feed.
-   **Syntax & Instructions**:
    To provide specific guidance to the LLM for generating the post, append your instructions after the `!post` command, like so:
    `!post <your specific instructions for the post>`
-   **Example**:
    If the admin replies in a thread with:
    `!post Please summarize the key points of this discussion and ask an open-ended question related to future developments.`
    The bot will analyze the discussion in that thread, and then, guided by the admin's instruction, generate a new post for its own feed that summarizes the key points and includes a relevant open-ended question. The LLM will attempt to adhere to the bot's persona and Bluesky's character limits.

## Deployment

This bot is designed to be deployed on Render.com's free tier. You can use the included `render.yaml` file for easy deployment.
You will need a Render account to deploy this bot.
When deploying on Render, ensure you set it up as a 'Web Service'. You must add all the environment variables mentioned here with their values except for TEXT_MODEL (which is now hardcoded)

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
