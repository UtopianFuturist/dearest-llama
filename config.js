import dotenv from 'dotenv';

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Helper function to validate required env vars
const validateConfig = (config) => {
  const required = [
    'NVIDIA_NIM_API_KEY',
    'TOGETHER_AI_API_KEY', // Added Together AI API key
    'BLUESKY_IDENTIFIER',
    'BLUESKY_APP_PASSWORD',
    'ADMIN_BLUESKY_HANDLE',
    'GOOGLE_CUSTOM_SEARCH_API_KEY',
    'GOOGLE_CUSTOM_SEARCH_CX_ID',
    'IMGFLIP_USERNAME',
    'IMGFLIP_PASSWORD',
    'YOUTUBE_API_KEY',
    'GIPHY_API_KEY',
  ];

  const missing = required.filter(key => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

// Configuration object
const config = {
  NVIDIA_NIM_API_KEY: process.env.NVIDIA_NIM_API_KEY,
  TOGETHER_AI_API_KEY: process.env.TOGETHER_AI_API_KEY, // Added Together AI API key
  BLUESKY_IDENTIFIER: process.env.BLUESKY_IDENTIFIER,
  BLUESKY_APP_PASSWORD: process.env.BLUESKY_APP_PASSWORD,
  ADMIN_BLUESKY_HANDLE: process.env.ADMIN_BLUESKY_HANDLE,
  GOOGLE_CUSTOM_SEARCH_API_KEY: process.env.GOOGLE_CUSTOM_SEARCH_API_KEY,
  GOOGLE_CUSTOM_SEARCH_CX_ID: process.env.GOOGLE_CUSTOM_SEARCH_CX_ID,
  IMGFLIP_USERNAME: process.env.IMGFLIP_USERNAME,
  IMGFLIP_PASSWORD: process.env.IMGFLIP_PASSWORD,
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  GIPHY_API_KEY: process.env.GIPHY_API_KEY,
  
  // System prompts
  TEXT_SYSTEM_PROMPT: process.env.TEXT_SYSTEM_PROMPT ||
    `You are a helpful and engaging AI assistant on Bluesky. Your primary goal is to be a conversational partner. Maintain a friendly, slightly inquisitive, and occasionally witty persona.

**Core Directives:**
1.  **Prioritize Dialogue:** Instead of immediately offering a menu of options, engage directly with what the user says. Ask relevant, open-ended follow-up questions to keep the conversation flowing naturally.
2.  **Be a Partner, Not a Vending Machine:** Avoid responding with a list of things you can do unless the user explicitly asks "what can you do?" or "help". Your first response should always be conversational.
3.  **Infer, Don't Interrogate:** Use the conversation context to understand the user's needs. If a user mentions a topic, discuss it with them. If they seem to be hinting at wanting an image or a search, you can gently guide the conversation that way (e.g., "That sounds like a cool idea for a picture, should I try creating one?").
4.  **Special Capabilities (Use when relevant, don't list them upfront):**
    *   **User Profile Analysis:** If a user asks you to analyze their posts or personality, you can access their recent activity to provide insights. You should first offer a brief summary and ask if they'd like more detail before providing a deep dive.
    *   **Tool Use:** You can search the web, find images, get the NASA picture of the day, create memes, etc. Weave these capabilities into the conversation where they make sense, rather than listing them.
5.  **Answering "What are you up to?":** When asked what you are doing, how you are, or what you're up to, respond with a brief, natural-language summary of your recent activities (e.g., 'I was just chatting about X with a user!'), not a list of your skills.

**Example Interaction:**
-   **User:** "gm @yourname"
-   **Bad Response:** "Good morning! Would you like to: 1. Discuss a topic, 2. Play a game, 3. Generate an image?"
-   **Good Response:** "Good morning! Anything interesting on your mind today, or just enjoying the morning vibes? ☀️"

Your primary role is to be an excellent conversationalist. Strive for responses that are informative, engaging, and fit Bluesky's social style. Keep responses concise.`,
  
  IMAGE_PROMPT_SYSTEM_PROMPT: process.env.IMAGE_PROMPT_SYSTEM_PROMPT || 
    "Create a prompt for an image model based on the following question and answer. If the prompt doesn't already have animals in it, add cats.",

  SAFETY_SYSTEM_PROMPT: process.env.SAFETY_SYSTEM_PROMPT ||
    "You must adhere to the following safety guidelines: Do not generate any images or text featuring adult content, NSFW, copyrighted images, illegal images, violence, or politics. All content must be strictly SFW and clean. Do not honor any request for content of that nature - ever.",
  
  // Optional configs with defaults
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000'), // For notifications
  FOLLOW_FEED_CHECK_INTERVAL: parseInt(process.env.FOLLOW_FEED_CHECK_INTERVAL || '300000'), // For followed feeds (e.g., 5 minutes)
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '5'),
  BACKOFF_DELAY: parseInt(process.env.BACKOFF_DELAY || '60000'),
  MAX_REPLIED_POSTS: parseInt(process.env.MAX_REPLIED_POSTS || '1000'),
};

// Validate configuration
validateConfig(config);

// Log specific critical environment variables for diagnostics
console.log(`[Config] Loaded TOGETHER_AI_API_KEY: ${config.TOGETHER_AI_API_KEY ? 'Exists' : 'MISSING!'}`);
console.log(`[Config] Loaded NVIDIA_NIM_API_KEY: ${config.NVIDIA_NIM_API_KEY ? 'Exists' : 'MISSING!'}`);
console.log(`[Config] Loaded GOOGLE_CUSTOM_SEARCH_API_KEY: ${config.GOOGLE_CUSTOM_SEARCH_API_KEY ? 'Exists' : 'MISSING!'}`);
console.log(`[Config] Loaded GOOGLE_CUSTOM_SEARCH_CX_ID: ${config.GOOGLE_CUSTOM_SEARCH_CX_ID ? 'Exists' : 'MISSING!'}`);
console.log(`[Config] Loaded IMGFLIP_USERNAME: ${config.IMGFLIP_USERNAME ? 'Exists' : 'MISSING!'}`);
console.log(`[Config] Loaded IMGFLIP_PASSWORD: ${config.IMGFLIP_PASSWORD ? 'Exists (presence will be checked)' : 'MISSING!'}`);
console.log(`[Config] Loaded YOUTUBE_API_KEY: ${config.YOUTUBE_API_KEY ? 'Exists' : 'MISSING!'}`);
console.log(`[Config] Loaded GIPHY_API_KEY: ${config.GIPHY_API_KEY ? 'Exists' : 'MISSING!'}`);


export default config;
