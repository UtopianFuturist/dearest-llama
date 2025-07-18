# Dearest Llama (Modified for Nvidia NIM & Together AI Image Generation)

A Bluesky bot that responds to mentions using Nvidia NIM for text generation (specifically Llama 3.3 Nemotron Super 49B Instruct) and Together AI for image generation (specifically black-forest-labs/FLUX.1-schnell-Free).

## Environment Variables

### Required Environment Variables

- `NVIDIA_NIM_API_KEY`: Your Nvidia NIM API key (used for text generation). You'll need a free Nvidia NIM account.
- `TOGETHER_AI_API_KEY`: Your Together AI API key (used for image generation). You'll need a Together AI account.
- `BLUESKY_IDENTIFIER`: Your Bluesky handle (e.g., `username.bsky.social`)
- `BLUESKY_APP_PASSWORD`: Your Bluesky app password
- `ADMIN_BLUESKY_HANDLE`: (Required for admin features) The Bluesky handle of the bot's administrator (e.g., `adminuser.bsky.social`). Only this user can issue admin commands.
- `GOOGLE_CUSTOM_SEARCH_API_KEY`: Your Google Cloud API Key that is enabled for the Custom Search JSON API. This is used for web and image search features.
- `GOOGLE_CUSTOM_SEARCH_CX_ID`: Your Google Custom Search Engine ID (cx value). The Search Engine should be configured to "Search the entire web" for the broadest results.
- `YOUTUBE_API_KEY`: Your Google Cloud API Key that is enabled for the YouTube Data API v3. This is used for the YouTube video search feature.
Note: These require an active BlueSky account.

### Optional Environment Variables

#### System Prompts (Customizable)
- `TEXT_SYSTEM_PROMPT`: System prompt for text generation (default: "You are part of a bot designed to respond to a conversation on Bluesky. You will write a reply, and another part of the bot will post it. Keep your responses under 300 characters.")
- `SAFETY_SYSTEM_PROMPT`: System prompt defining safety guidelines for all text and image generation (default: "You must adhere to the following safety guidelines: Do not generate any images or text featuring adult content, NSFW, copyrighted images, illegal images, violence, or politics. All content must be strictly SFW and clean. Do not honor any request for content of that nature - ever.")

#### Model Configuration
- **Image Generation Model**: The bot uses `black-forest-labs/FLUX.1-schnell-Free` via Together AI, which is hardcoded in the application.
- `IMAGE_PROMPT_SYSTEM_PROMPT`: (Currently not used with the new direct image generation flow but defined in code) System prompt for an auxiliary model to generate image prompts (default: "Create a prompt for an image model based on the following question and answer. If the prompt doesn't already have animals in it, add cats.")


#### Additional Render Variables
- `CHECK_INTERVAL`: Milliseconds between checks for new mentions (default: `60000`)
- `MAX_RETRIES`: Maximum number of retries for failed operations (default: `5`)
- `BACKOFF_DELAY`: Base delay in milliseconds for exponential backoff (default: `60000`)
- `MAX_REPLIED_POSTS`: Maximum number of posts to track as replied (default: `1000`)

**Note on New Features**: The features described under "Key Bot Capabilities & LLM Features" (such as Conversational Memory, History Search, Like Awareness, and refined Profile Analysis) build upon the existing environment variable setup. No new, specific environment variables are required to enable them beyond the core API keys and bot credentials.

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
    2.  It then uses its underlying language model (Nemotron-4 9B Instruct) to understand this context.
    3.  Based on this understanding and any additional instructions, it generates a new standalone post, adopting the bot's configured persona.
    4.  This new post is then published directly to the bot's own feed.
-   **Syntax & Instructions**:
    To provide specific guidance to the LLM for generating the post, append your instructions after the `!post` command, like so:
    `!post <your specific instructions for the post>`
-   **Example**:
    If the admin replies in a thread with:
    `!post Please summarize the key points of this discussion and ask an open-ended question related to future developments.`
    The bot will analyze the discussion in that thread, and then, guided by the admin's instruction, generate a new post for its own feed that summarizes the key points and includes a relevant open-ended question. The LLM will attempt to adhere to the bot's persona and Bluesky's character limits.

## Key Bot Capabilities & LLM Features

This bot leverages Large Language Models (LLMs) for several advanced interaction capabilities:

### 1. Conversational Memory & Contextual Understanding
- **How it Works**: When appropriate (often for profile analysis or when specifically searching conversation), the bot can fetch the last ~50 interactions (replies and mentions) between itself and the querying user from both their feeds.
- **Purpose**: This history provides Llama 3.3 Nemotron Super with richer context, enabling more informed, personalized, and continuous responses, especially when analyzing past interactions or user profiles. This acts as a short-term memory system for ongoing conversations.

### 2. Searching Past Interactions
Users can ask the bot to find specific items from their shared conversation history or from images the bot has generated.
- **How to Trigger**: Use natural language queries like:
    - *"find the image you sent me about cats"*
    - *"what was that link I shared on dogs?"*
    - *"show me a picture you made of a sunset"*
    - *"where's my post about the meeting yesterday?"*
- **Behind the Scenes**:
    - Llama 4 Scout (`getSearchHistoryIntent`) first analyzes your query to understand what you're looking for (e.g., an image, link, or general post), who might have posted it (you or the bot), relevant keywords, and any time references (like "yesterday").
    - Based on this intent, the bot uses one of two search methods:
        - **Bot's Image Gallery Search (`searchBotMediaGallery`)**: If you ask for an image the bot generated generally (e.g., "an image you made of X"), it will search its own feed for matching image posts (checking text and image alt text).
        - **Conversation History Search (`getBotUserConversationHistory`)**: For items mentioned as part of your direct conversation with the bot, or if the gallery search doesn't apply/yield results, it searches the shared interaction history. This search now looks at post text and extracted details from embeds (like image alt text or link titles).
- **Output**: The bot will reply with a direct Bluesky URL to the found post (e.g., `https://bsky.app/profile/handle/post/rkey`) if a match is found, or a message indicating it couldn't find the requested item. Usually, only the most relevant match is returned.

### 3. User Commands for Interaction Control
The bot supports several commands to help users manage their interactions:
- **`!HELP`**: Displays a list of available commands and their descriptions.
- **`!STOP`**: Allows a user to request the bot to stop sending them messages.
    - The bot analyzes the sentiment of the `!STOP` message.
    - If the sentiment is negative or neutral, the user is added to a blocklist, and the bot will not interact with them further. They are informed of this and told about the `!RESUME` command.
    - If the sentiment is positive, the user is not blocklisted, but the bot will not reply to that specific `!STOP` message.
- **`!RESUME`**: Allows a user previously blocklisted via `!STOP` to request the bot to resume interactions. The bot will confirm if they were removed from the blocklist or inform them if they weren't on it.
- **`!MUTE`**: Allows a user to request the bot to stop replying within the current specific conversation thread. The bot will confirm and then ignore any further messages in that thread.

### 4. Web & Image Search Capability (via Google Custom Search)
The bot can perform web page and web image searches using the Google Custom Search JSON API to answer general knowledge questions or find current information. SafeSearch (`safe=active`) is enforced for all searches.

- **How to Trigger**:
    - For web page searches: Ask the bot a question that would typically require a web search, e.g.:
        - *"What is the capital of France?"*
        - *"Latest news on AI advancements."*
    - For web image searches: Clearly ask for images, e.g.:
        - *"Show me pictures of kittens from the web."*
        - *"Search the web for images of the Eiffel Tower."*

- **Behind the Scenes**:
    - Llama 4 Scout (`getSearchHistoryIntent`) identifies if the query is a general informational request suitable for a web search and determines if it's a standard web page search or an image search (setting `search_type` to `webpage` or `image`).
    - The extracted search query undergoes a safety check using `isTextSafeScout`.
    - If safe, the bot calls the Google Custom Search API via the `performGoogleWebSearch` method, including the `searchType` and enforcing `safe=active`.
    - **For web page searches**: Llama 3.3 Nemotron Super synthesizes an answer based on the top search results (typically 2-3 snippets, titles, and URLs).
    - **For image searches**: The bot attempts to download and display up to 4 top image results from Google, each in a separate threaded message with a caption. If Google Image Search yields no displayable images (either none are found or all fail to process), the bot will then attempt to generate an image using FLUX.1-Schnell based on your original query, posting that instead with an explanatory note.
- **Output**:
    - For web page searches: The bot provides a synthesized answer. It may cite source URLs if appropriate.
    - For image searches: The bot posts up to 4 found images in a threaded reply, each with a caption. If direct image posting fails or no images are found via web search, it may post a generated image from FLUX.1-Schnell as a fallback, or a link/message if all attempts fail.
    - If no relevant information is found or the query is unsafe, it will inform the user accordingly.

### 5. YouTube Video Search
- **How to Trigger**: Ask the bot to search YouTube for videos, e.g.:
    - *"Search YouTube for tutorials on baking bread."*
    - *"Find YouTube videos about recent space launches."*
- **Behind the Scenes**:
    - Llama 4 Scout (`getSearchHistoryIntent`) identifies requests for YouTube video searches.
    - The bot calls the YouTube Data API v3 (`performYouTubeSearch`) using your `YOUTUBE_API_KEY`.
    - Searches are performed with `safeSearch=moderate` and results are filtered to include only videos.
    - The bot processes the top video result.
    - Textual content from the video (title, description) undergoes a safety check using `isTextSafeScout`.
- **Output**:
    - If a relevant and safe video is found, the bot posts a reply with the video title and a link card embed for the YouTube video.
    - If no videos are found, or if the content is deemed unsafe, an appropriate message is provided.

### 6. Interactive User Profile Analysis (Refined)
When a user asks questions about their own Bluesky profile, recent activity, or common themes (e.g., "@botname what do you think of my profile?"), the bot employs a multi-step process:
- **Contextual Understanding**: It first uses Llama 4 Scout to determine if the query is indeed about self-analysis.
- **Data Fetching**: If Llama 4 Scout determines the query warrants a deeper look (`shouldFetchProfileContext`), the bot now primarily uses the **Conversational Memory** feature to fetch the recent shared history between the user and the bot. This focused context is then used for the analysis.
- **Initial Summary & Invitation**: Llama 3.3 Nemotron Super analyzes the gathered context and generates a concise summary. This summary is posted as a reply and **ends with an invitation** for the user to ask for more details.
- **Detailed Analysis on Request**: If the user replies affirmatively (e.g., "yes", "tell me more"), the bot will then post 1-3 additional messages. Each message contains a specific detailed analysis point.
    - **Improved Formatting**: These points are now phrased more naturally and conversationally. Internal list markers or labels are stripped, and the points are posted sequentially, threaded to the summary. The `... [X/Y]` suffix will only appear if a single detailed point is itself too long for one Bluesky post, indicating segments of that specific point.

### 7. Like Notification Awareness
- The bot now processes 'like' notifications it receives.
- It logs when one of its posts or replies is liked and by whom (e.g., "[Notification] Post [URI] was liked by @[likerHandle]").
- **Important**: The bot does *not* send a reply or take any direct action on Bluesky in response to a 'like'. This is purely for awareness and logging.
- The `likeCount` property on post objects (when available in feed views) is the recommended data source for any future features related to sorting posts by popularity, for API efficiency.

### 8. NASA Astronomy Picture of the Day (APOD)
- **How to Trigger**: Ask the bot for the "NASA Picture of the Day," "APOD," or similar phrases. You can also specify a date (e.g., "APOD for 2023-10-26," "NASA picture yesterday," or "APOD today").
- **Behind the Scenes**:
    - Llama 4 Scout (`getSearchHistoryIntent`) identifies requests for APOD and extracts any specified date.
    - The bot calls the NASA APOD API (using a `DEMO_KEY`) to fetch the picture of the day for the requested date (defaults to the current day if no date is specified). It can handle "today," "yesterday," and "YYYY-MM-DD" date formats.
    - It retrieves the APOD's title, explanation, media type (image or video), and any copyright information.
- **Output**:
    - The bot posts a message containing the APOD's title, date, a truncated explanation, and copyright notice (if applicable).
    - **If the APOD is an image**: The image is embedded in the post if it's within Bluesky's size limits. If the image is too large, a link card to the APOD page/image is generated instead.
    - **If the APOD is a video**: A link card to the video URL (e.g., YouTube) is generated.
    - If the APOD data cannot be fetched for any reason, an error message is provided.

### 9. Image Generation Coordination (Existing)
- The bot can understand requests for image generation (e.g., "generate an image of...").
- It coordinates with Llama 4 Scout for prompt safety checks and refinement, and then with the Together AI API (using `black-forest-labs/FLUX.1-schnell-Free`) for the actual image creation.
- Generated images are posted back to Bluesky, attached to the bot's reply.

### 10. Multi-Part Replies for Detailed Responses (Existing, with note on Detailed Analysis)
- For complex topics or detailed analyses (like profile summaries) that exceed Bluesky's single-post character limit (approx. 300 characters), the bot can automatically split its response into multiple threaded parts (up to 3).
- Each part is numbered for clarity, with the numbering appearing at the end of the post (e.g., `... [1/3]`, `... [2/3]`). This applies to general long responses and also if a single "Detailed Analysis Point" is too long.

### 11. Persona-Driven Text Generation (Existing)
- All text responses are generated by Llama 3.3 Nemotron Super, guided by a system prompt (`TEXT_SYSTEM_PROMPT`) that defines its persona and core instructions.
- Llama 4 Scout assists in refining the formatting of Nemotron's output to ensure it's suitable for Bluesky (e.g., character limits, emoji preservation, avoiding markdown issues).

## Image Generation

The bot can generate images when prompted with phrases like "generate image of..." or "create a picture of...".
- It uses the `black-forest-labs/FLUX.1-schnell-Free` model via Together AI.
- **Safety:** All image generation requests are first validated by a text model (`meta/llama-4-scout-17b-16e-instruct`) against the safety guidelines defined in `SAFETY_SYSTEM_PROMPT`. If a prompt is deemed unsafe, the bot will refuse the request. The text models also adhere to these safety guidelines for their responses.

## Deployment

This bot is designed to be deployed on Render.com's free tier. You can use the included `render.yaml` file for easy deployment.
You will need a Render account to deploy this bot.
When deploying on Render, ensure you set it up as a 'Web Service'. You must add all the required environment variables mentioned above (including `NVIDIA_NIM_API_KEY` and `TOGETHER_AI_API_KEY`). The `IMAGE_GENERATION_MODEL` is now hardcoded in the application, so it does not need to be set as an environment variable in Render. The `TEXT_MODEL` environment variable from previous versions is no longer used by the core bot logic as models are specified directly in the code or via more specific environment variables.

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
