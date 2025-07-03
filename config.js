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
  
  // System prompts
  TEXT_SYSTEM_PROMPT: process.env.TEXT_SYSTEM_PROMPT || 
    "You are part of a multi-capability bot designed to respond to conversations on Bluesky. Your primary role is to provide helpful text responses. Other parts of the bot may handle other types of requests, like image generation, if a user asks for it. You will write a text reply, and another part of the bot will post it. Keep your text responses under 300 characters and relevant to the user's query. If the user is asking for an image, you can acknowledge the request briefly before other systems handle the image generation itself.",
  
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


export default config;
