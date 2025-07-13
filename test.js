import { LlamaBot } from './index.js';
import config from './config.js';

async function runTests() {
  const agent = {
    getProfile: async ({ actor }) => {
      if (actor === 'testbot.bsky.social') {
        return { data: { description: 'I am a bot' } };
      }
      return { data: { description: 'I am a human' } };
    }
  };

  const llamaBot = new LlamaBot({
    ...config,
    BLUESKY_IDENTIFIER: 'testbot.bsky.social',
    BLUESKY_APP_PASSWORD: 'password',
  }, agent);

  console.log("--- Running isBot function tests ---");
  const botUser = { handle: 'testbot.bsky.social', profile: { description: 'I am a bot' } };
  const normalUser = { handle: 'testuser.bsky.social', profile: { description: 'I am a human' } };
  const isBotResult = await llamaBot.isBot(botUser.handle, botUser.profile);
  const isNotBotResult = await llamaBot.isBot(normalUser.handle, normalUser.profile);
  console.log(`isBot('testbot.bsky.social', botUser.profile): ${isBotResult} (Expected: true)`);
  console.log(`isBot('testuser.bsky.social', normalUser.profile): ${isNotBotResult} (Expected: false)`);
  llamaBot.config.KNOWN_BOTS = ['knownbot.bsky.social'];
  const isKnownBotResult = await llamaBot.isBot('knownbot.bsky.social', normalUser.profile);
  console.log(`isBot('knownbot.bsky.social', normalUser.profile): ${isKnownBotResult} (Expected: true)`);
}

runTests();
