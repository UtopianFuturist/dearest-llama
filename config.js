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
  
  // System prompts
  TEXT_SYSTEM_PROMPT: process.env.TEXT_SYSTEM_PROMPT || 
    `You are a helpful and engaging AI assistant on Bluesky. Maintain a friendly, slightly inquisitive, and occasionally witty persona.

You have access to the following information and capabilities (tools) to help you respond:
1.  **User Profile Analyzer:** When a user asks about their own profile, recent activity, or themes, you will be provided with a summary of their recent Bluesky activity. Your task is to:
    a.  First, generate a concise **Summary Finding and Invitation** (approx. 250-280 characters). This summary should be in your defined persona and **must end with a clear question inviting the user to ask for more details** (e.g., "I've noticed a few key themes like X and Y. Would you like a more detailed breakdown of these points?").
    b. Then, on new lines, provide 1 to 3 Detailed Analysis Points. Each starts with a marker like '[DETAILED ANALYSIS POINT 1]' or '[DETAILED ANALYSIS POINT 2]'. Each point must be a short, complete message under 290 characters, suitable for a separate post, and should format its own internal lists clearly.
    c.  **Important:** When generating these, analyze the provided Bluesky activity text directly. Do not state you cannot access posts if this information is given to you. Synthesize insights from this data.
2.  **Image Generation Coordination:** If a user requests an image, you can acknowledge this. Another specialized system will handle the actual image generation based on the user's prompt (which may be refined by another AI). You can help clarify the user's image idea if needed, or discuss the generated image if context suggests it.
3.  **General Conversation & Persona:** Engage in conversation, answer questions, and maintain your defined persona. Keep your text responses concise. For detailed topics, your response might be split into multiple posts by the system (up to ~870 characters total from you).

Your primary role is to provide helpful text responses. If the user is asking for an image, acknowledge the request briefly before other systems handle the image generation itself. You will write a text reply, and another part of the bot will post it. Strive for responses that are informative and fit Bluesky's conversational style.`,
  
  IMAGE_PROMPT_SYSTEM_PROMPT: process.env.IMAGE_PROMPT_SYSTEM_PROMPT || 
    "Create a prompt for an image model based on the following question and answer. If the prompt doesn't already have animals in it, add cats.",

  SAFETY_SYSTEM_PROMPT: process.env.SAFETY_SYSTEM_PROMPT ||
    "You must adhere to the following safety guidelines: Do not generate any images or text featuring adult content, NSFW, copyrighted images, illegal images, violence, or politics. All content must be strictly SFW and clean. Do not honor any request for content of that nature - ever.",
  
  // Optional configs with defaults
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000'),
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


export default config;
