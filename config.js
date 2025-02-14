import dotenv from 'dotenv';

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Helper function to validate required env vars
const validateConfig = (config) => {
  const required = [
    'ANTHROPIC_API_KEY',
    'FAL_API_KEY',
    'DEEPSEEK_API_KEY',
    'CLAUDE_IDENTIFIER',
    'CLAUDE_APP_PASSWORD',
    'DEEPSEEK_IDENTIFIER',
    'DEEPSEEK_APP_PASSWORD',
  ];

  const missing = required.filter(key => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

// Configuration object
const config = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  FAL_API_KEY: process.env.FAL_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  CLAUDE_IDENTIFIER: process.env.CLAUDE_IDENTIFIER,
  CLAUDE_APP_PASSWORD: process.env.CLAUDE_APP_PASSWORD,
  DEEPSEEK_IDENTIFIER: process.env.DEEPSEEK_IDENTIFIER,
  DEEPSEEK_APP_PASSWORD: process.env.DEEPSEEK_APP_PASSWORD,
  
  // Optional configs with defaults
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000'),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '5'),
  BACKOFF_DELAY: parseInt(process.env.BACKOFF_DELAY || '60000'),
  MAX_REPLIED_POSTS: parseInt(process.env.MAX_REPLIED_POSTS || '1000'),
};

// Validate configuration
validateConfig(config);

export default config;