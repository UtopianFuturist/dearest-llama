import { AtpAgent } from '@atproto/api';
import config from './config.js';
import fetch from 'node-fetch';
import express from 'express';
import path from 'path';
import fs from 'fs';

// Add express to your package.json dependencies
const app = express();
const PORT = process.env.PORT || 3000;

// Add basic health check endpoint
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Start express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Initialize Bluesky client
const agent = new AtpAgent({
  service: 'https://bsky.social',
});

// ===== Utility Functions =====

// Helper for fetch with retries and timeout
async function fetchWithRetries(url, options, maxRetries = 3, initialDelay = 10000, timeout = 30000) { // Increased initialDelay to 10s
  let attempt = 0;
  let currentDelay = initialDelay;

  // Note: 'options.timeout' is a custom parameter for this function, not a standard fetch option.
  // It's used to control the AbortController.
  const effectiveTimeout = options.customTimeout || timeout; // Allow per-call override
  if (options.customTimeout) delete options.customTimeout;


  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[fetchWithRetries] Timeout triggered for ${url} on attempt ${attempt} after ${effectiveTimeout / 1000}s`);
      controller.abort();
    }, effectiveTimeout);

    try {
      console.log(`[fetchWithRetries] Attempt ${attempt}/${maxRetries} to fetch ${url}. Timeout set to ${effectiveTimeout / 1000}s.`);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId); // Clear the timeout if the request completes (successfully or with HTTP error)

      if (response.ok) {
        console.log(`[fetchWithRetries] Successfully fetched ${url} on attempt ${attempt}.`);
        return response;
      }

      // Retry on specific server errors or rate limits
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        console.warn(`[fetchWithRetries] API call to ${url} failed with status ${response.status}. Attempt ${attempt}/${maxRetries}. Retrying in ${currentDelay / 1000}s...`);
        if (attempt >= maxRetries) {
          console.error(`[fetchWithRetries] Maximum retries reached for ${url} after status ${response.status}.`);
          return response; // Return the last error response if max retries reached
        }
        await utils.sleep(currentDelay);
        currentDelay *= 2; // Exponential backoff
      } else {
        // Don't retry on other client errors (e.g., 400, 401, 403)
        console.error(`[fetchWithRetries] API call to ${url} failed with status ${response.status}. Not retrying.`);
        return response; // Return the error response
      }
    } catch (error) {
      clearTimeout(timeoutId); // Clear timeout on any error
      if (error.name === 'AbortError') {
        // This is our timeout
        console.warn(`[fetchWithRetries] API call to ${url} timed out (aborted) on attempt ${attempt}/${maxRetries}.`);
      } else {
        // Other network errors
        console.warn(`[fetchWithRetries] API call to ${url} threw an error: ${error.message}. Attempt ${attempt}/${maxRetries}.`);
      }

      if (attempt >= maxRetries) {
        console.error(`[fetchWithRetries] Maximum retries reached for ${url}. Last error: ${error.message}`);
        throw error; // Re-throw the last error if all attempts fail
      }
      await utils.sleep(currentDelay);
      currentDelay *= 2;
    }
  }
  // This line should ideally not be reached if logic is correct, but as a fallback:
  throw new Error(`[fetchWithRetries] API call to ${url} failed after ${maxRetries} attempts (exhausted retries).`);
}


const utils = {
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  async imageUrlToBase64(imageUrl, timeoutMs = 15000) { // Added 15s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[imageUrlToBase64] Timeout triggered for ${imageUrl} after ${timeoutMs / 1000}s`);
      controller.abort();
    }, timeoutMs);

    try {
      console.log(`[imageUrlToBase64] Fetching image from URL: ${imageUrl} with timeout ${timeoutMs/1000}s`);
      const response = await fetch(imageUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[imageUrlToBase64] Error fetching image from URL: ${response.status} ${response.statusText}. URL: ${imageUrl}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.error(`[imageUrlToBase64] Timeout fetching image from URL: ${imageUrl}`);
      } else {
        console.error(`[imageUrlToBase64] Error converting image to base64 (URL: ${imageUrl}):`, error);
      }
      return null;
    }
  },

  truncateResponse(text, maxLength = 300) {
    if (!text || text.length <= maxLength) return text;
    
    const searchEnd = Math.min(maxLength, text.length);
    const searchStart = Math.max(0, searchEnd - 50);
    const segment = text.substring(searchStart, searchEnd);
    
    const lastSentenceEnd = Math.max(
      segment.lastIndexOf('.'),
      segment.lastIndexOf('?'),
      segment.lastIndexOf('!')
    );
    
    if (lastSentenceEnd !== -1) {
      return text.substring(0, searchStart + lastSentenceEnd + 1).trim();
    }
    
    const lastSpace = text.lastIndexOf(' ', maxLength - 3);
    return lastSpace !== -1 
      ? text.substring(0, lastSpace) + '...'
      : text.substring(0, maxLength - 3) + '...';
  }
};

// ===== Rate Limiting =====
const RateLimit = {
  limits: {
    hourlyRequests: 0,
    dailyRequests: 0,
    lastHourReset: Date.now(),
    lastDayReset: Date.now()
  },

  check() {
    const now = Date.now();
    
    if (now - this.limits.lastHourReset > 3600000) {
      this.limits.hourlyRequests = 0;
      this.limits.lastHourReset = now;
    }
    
    if (now - this.limits.lastDayReset > 86400000) {
      this.limits.dailyRequests = 0;
      this.limits.lastDayReset = now;
    }
    
    this.limits.hourlyRequests++;
    this.limits.dailyRequests++;
    
    if (this.limits.hourlyRequests > 100 || this.limits.dailyRequests > 1000) {
      throw new Error('Rate limit exceeded');
    }
  }
};

let ALLOWED_USERS = new Set();

class BaseBot {
  constructor(config, agent) {
    this.config = config;
    this.agent = agent;
    this.repliedPosts = new Set();
    this.pendingDetailedAnalyses = new Map(); // For storing detailed analysis points
    this.DETAIL_ANALYSIS_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds
    this.adminDid = null; // Will be resolved in authenticate()
    this.botDisplayName = null; // For the bot's own display name
    this.botHandle = null; // For the bot's own handle
    this.followingCache = { dids: [], lastFetched: 0, ttl: 15 * 60 * 1000 }; // Cache for bot's following list

    this.lastProcessedPostUrisFilePath = path.join(process.cwd(), 'last_processed_post_uris.json');
    this.lastProcessedPostUris = this._loadLastProcessedPostUris();

    // New rate limiting properties for proactive engagement
    this.DAILY_PROACTIVE_REPLY_LIMIT = config.DAILY_PROACTIVE_REPLY_LIMIT || 5; // Default to 5 if not set
    this.proactiveReplyTimestampsFilePath = path.join(process.cwd(), 'proactive_reply_timestamps.json');
    this.proactiveReplyTimestamps = this._loadProactiveReplyTimestamps(); // { did: { date: "YYYY-MM-DD", count: N }, ... }
  }

  _loadProactiveReplyTimestamps() {
    try {
      if (fs.existsSync(this.proactiveReplyTimestampsFilePath)) {
        const data = fs.readFileSync(this.proactiveReplyTimestampsFilePath, 'utf-8');
        const timestamps = JSON.parse(data);
        // Optional: Clean up old dates if necessary, but for now, just load as is.
        // Users not replied to in a long time will naturally pass the daily check.
        console.log(`[RateLimit] Loaded proactive reply timestamps for ${Object.keys(timestamps).length} users.`);
        return timestamps;
      }
    } catch (error) {
      console.error('[RateLimit] Error loading proactive reply timestamps:', error);
    }
    console.log('[RateLimit] No existing proactive reply timestamps file found. Starting empty.');
    return {};
  }

  _saveProactiveReplyTimestamps() {
    try {
      fs.writeFileSync(this.proactiveReplyTimestampsFilePath, JSON.stringify(this.proactiveReplyTimestamps, null, 2), 'utf-8');
      // console.log(`[RateLimit] Saved proactive reply timestamps.`);
    } catch (error) {
      console.error('[RateLimit] Error saving proactive reply timestamps:', error);
    }
  }

  _getTodayDateString() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  _canSendProactiveReply(userDid) {
    if (this.adminDid && userDid === this.adminDid) {
      console.log(`[RateLimit] Admin user ${userDid} bypasses proactive reply rate limit.`);
      return true; // Admin bypasses rate limit
    }

    const todayStr = this._getTodayDateString();
    const userData = this.proactiveReplyTimestamps[userDid];

    if (userData && userData.date === todayStr) {
      if (userData.count >= this.DAILY_PROACTIVE_REPLY_LIMIT) {
        console.log(`[RateLimit] Daily proactive reply limit reached for user ${userDid} (count: ${userData.count}, limit: ${this.DAILY_PROACTIVE_REPLY_LIMIT}) on ${todayStr}.`);
        return false;
      }
    }
    // If no data for today, or count is less than limit, they can receive a reply.
    return true;
  }

  _recordProactiveReplyTimestamp(userDid) {
    const todayStr = this._getTodayDateString();
    if (!this.proactiveReplyTimestamps[userDid] || this.proactiveReplyTimestamps[userDid].date !== todayStr) {
      // Reset or initialize for the new day
      this.proactiveReplyTimestamps[userDid] = { date: todayStr, count: 1 };
    } else {
      // Increment count for today
      this.proactiveReplyTimestamps[userDid].count++;
    }
    console.log(`[RateLimit] Recorded proactive reply for user ${userDid}. Today's count: ${this.proactiveReplyTimestamps[userDid].count} on ${todayStr}.`);
    this._saveProactiveReplyTimestamps();
  }

  // Helper to cleanup expired pending analyses
  _loadLastProcessedPostUris() {
    try {
      if (fs.existsSync(this.lastProcessedPostUrisFilePath)) {
        const data = fs.readFileSync(this.lastProcessedPostUrisFilePath, 'utf-8');
        const jsonData = JSON.parse(data);
        console.log(`[PollingManager] Loaded ${Object.keys(jsonData).length} users' last processed post URIs.`);
        return jsonData; // Should be an object like { did: uri, ... }
      }
    } catch (error) {
      console.error('[PollingManager] Error loading last processed post URIs:', error);
    }
    console.log('[PollingManager] No existing last processed post URIs file found. Starting empty.');
    return {};
  }

  _saveLastProcessedPostUris() {
    try {
      fs.writeFileSync(this.lastProcessedPostUrisFilePath, JSON.stringify(this.lastProcessedPostUris, null, 2), 'utf-8');
      // console.log(`[PollingManager] Saved last processed post URIs to ${this.lastProcessedPostUrisFilePath}`);
    } catch (error) {
      console.error('[PollingManager] Error saving last processed post URIs:', error);
    }
  }

  async getBotFollowingDids() {
    const now = Date.now();
    if (this.followingCache && now - this.followingCache.lastFetched < this.followingCache.ttl) {
      // console.log('[FollowList] Using cached following list.');
      return this.followingCache.dids;
    }

    console.log('[FollowList] Fetching bot\'s following list...');
    if (!this.agent || !this.agent.did) { // Ensure agent and agent.did are available
        console.error('[FollowList] Agent DID not available. Cannot fetch follows.');
        this.followingCache = { dids: [], lastFetched: now, ttl: this.followingCache.ttl }; // Update timestamp to prevent rapid retries
        return [];
    }

    let followsDids = [];
    let cursor;
    try {
      do {
        const response = await this.agent.api.app.bsky.graph.getFollows({
          actor: this.agent.did, // Use the bot's own DID
          limit: 100, // Max limit per page
          cursor: cursor
        });
        if (response.success && response.data.follows) {
          followsDids = followsDids.concat(response.data.follows.map(follow => follow.did));
          cursor = response.data.cursor;
        } else {
          console.warn('[FollowList] Failed to fetch a page of follows or no follows data in page.');
          cursor = null; // Stop on error or no more data
        }
      } while (cursor && followsDids.length < 1000); // Safety break for very large follow lists (e.g., max 10 pages)

      this.followingCache = { dids: followsDids, lastFetched: now, ttl: this.followingCache.ttl };
      console.log(`[FollowList] Fetched ${followsDids.length} DIDs from bot's following list.`);
      return followsDids;
    } catch (error) {
      console.error('[FollowList] Error fetching bot\'s following list:', error);
      this.followingCache.lastFetched = now; // Update timestamp even on error to prevent rapid retries on persistent errors
      return this.followingCache.dids; // Return possibly stale cache if available, else empty
    }
  }

  _cleanupExpiredDetailedAnalyses() {
    const now = Date.now();
    for (const [key, value] of this.pendingDetailedAnalyses.entries()) {
      if (now - value.timestamp > this.DETAIL_ANALYSIS_TTL) {
        this.pendingDetailedAnalyses.delete(key);
        console.log(`[CacheCleanup] Removed expired detailed analysis for post URI: ${key}`);
      }
    }
  }

  async getClarificationSuggestion(userQueryText, conversationContext) {
    const cacheKey = `${userQueryText}|${conversationContext || 'nocachekeycontext'}`;
    const now = Date.now();

    if (this.clarificationCache.has(cacheKey)) {
      const cachedEntry = this.clarificationCache.get(cacheKey);
      if (now - cachedEntry.timestamp < this.CLARIFICATION_CACHE_TTL) {
        console.log("[ClarificationHelper] Using cached clarification suggestion.");
        return cachedEntry.suggestion;
      } else {
        this.clarificationCache.delete(cacheKey);
        console.log("[ClarificationHelper] Clarification suggestion cache expired, re-fetching.");
      }
    }

    const systemPrompt = `You are an AI assistant that helps decide if a user's query needs clarification before the main bot attempts a full response or action.
Analyze the USER QUERY provided.
Consider if the query is too vague, ambiguous, could have multiple common interpretations leading to different actions, or is missing key information needed for a specific tool (like image generation, web search, etc.).

Rules:
1. If the query is clear and actionable, or a simple greeting/statement, respond with: {"needs_clarification": false, "clarification_question": null}
2. If the query IS ambiguous or incomplete:
   - Formulate a single, polite, concise clarifying question to ask the user.
   - The question should help the user provide the missing information or specify their intent.
   - Respond with: {"needs_clarification": true, "clarification_question": "Your clarifying question here."}
3. Do not try to answer the user's query itself. Only decide if clarification is needed and provide the question.
4. Focus on ambiguities that prevent the bot from choosing a correct tool or providing a relevant answer.

Examples:
User Query: "Tell me about it."
Your JSON Output: {"needs_clarification": true, "clarification_question": "Could you please tell me what 'it' you're referring to?"}

User Query: "Generate an image."
Your JSON Output: {"needs_clarification": true, "clarification_question": "Sure, I can try to generate an image! What would you like me to generate?"}

User Query: "Search for cats."
Your JSON Output: {"needs_clarification": false, "clarification_question": null} // Actionable by search tool

User Query: "What's up?"
Your JSON Output: {"needs_clarification": false, "clarification_question": null} // Simple greeting

User Query: "Can you help me?"
Your JSON Output: {"needs_clarification": true, "clarification_question": "I can certainly try! What do you need help with?"}

User Query: "The previous thing."
Your JSON Output: {"needs_clarification": true, "clarification_question": "Could you remind me what specific 'previous thing' you're referring to?"}

Respond ONLY with a single JSON object.`;

    const userPromptForClarification = `USER QUERY: "${userQueryText}"\n\nYOUR JSON OUTPUT:`;

    try {
      console.log(`[ClarificationHelper] Calling Llama 3.2 Vision for ambiguity check on query: "${userQueryText}"`);
      const response = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-3.2-90b-vision-instruct',
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPromptForClarification }],
          temperature: 0.2,
          max_tokens: 150,
          stream: false
        }),
        customTimeout: 90000
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ClarificationHelper] API error (${response.status}): ${errorText}`);
        return { needs_clarification: false, clarification_question: null, error: "API error" };
      }

      const data = await response.json();
      if (data.choices && data.choices[0].message && data.choices[0].message.content) {
        let suggestionJson = data.choices[0].message.content.trim();
        const match = suggestionJson.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (match && match[1]) {
          suggestionJson = match[1];
        }
        console.log(`[ClarificationHelper] Raw suggestion JSON: ${suggestionJson}`);
        const suggestion = JSON.parse(suggestionJson);
        if (suggestion && typeof suggestion.needs_clarification === 'boolean') {
          this.clarificationCache.set(cacheKey, { suggestion, timestamp: now });
          return suggestion;
        }
      }
      console.error("[ClarificationHelper] Failed to parse suggestion or unexpected format.");
      return { needs_clarification: false, clarification_question: null, error: "Parsing error" };
    } catch (error) {
      console.error(`[ClarificationHelper] Exception: ${error.message}`);
      return { needs_clarification: false, clarification_question: null, error: error.message };
    }
  }

  async generateResponse(post, context) {
    throw new Error('generateResponse must be implemented by child class');
  }

  async generateImage(prompt) {
    throw new Error('generateImage must be implemented by child class');
  }

  async isTextSafeScout(prompt) {
    throw new Error('isTextSafeScout must be implemented by child class');
  }

  async processImagePromptWithScout(user_prompt_text) {
    throw new Error('processImagePromptWithScout must be implemented by child class');
  }

  async generateImagePrompt(post, response) {
    throw new Error('generateImagePrompt must be implemented by child class');
  }

  async hasAlreadyReplied(post) {
    try {
      if (this.repliedPosts.has(post.uri)) {
        console.log('Found post in local reply history');
        return true;
      }
      console.log(`Checking for existing replies to post: ${post.uri}`);
      const { data: thread } = await this.agent.getPostThread({
        uri: post.uri,
        depth: 1,
        parentHeight: 1
      });
      if (thread.thread.replies && thread.thread.replies.length > 0) {
        const hasReply = thread.thread.replies.some(reply => 
          reply.post.author.handle === this.config.BLUESKY_IDENTIFIER
        );
        if (hasReply) this.repliedPosts.add(post.uri);
        console.log(`Has existing reply: ${hasReply}`);
        return hasReply;
      }
      console.log(`No replies found`);
      return false;
    } catch (error) {
      console.error('Error checking for existing replies:', error);
      return false;
    }
  }

  async handleAdminPostCommand(post, commandContent, commandType) {
    if (await this.hasAlreadyReplied(post)) {
      console.log(`[ADMIN_CMD_SKIP_REPLIED] Post URI ${post.uri} already replied or processed, skipping in handleAdminPostCommand.`);
      return;
    }

    console.log(`[HANDLE_ADMIN_POST_COMMAND_ENTER] Timestamp: ${new Date().toISOString()}, Post URI: ${post.uri}, Command Content: "${commandContent}", Command Type: ${commandType}`);

    try {
      this.repliedPosts.add(post.uri);
      console.log(`[HANDLE_ADMIN_POST_COMMAND_PROCESSED_URI] Timestamp: ${new Date().toISOString()}, Added to repliedPosts: ${post.uri}`);

      const context = await this.getReplyContext(post);
      let textForLLM = "";
      let mediaPrompt = ""; // For art prompt, image search query, or video search query/URL
      let postDetails = {}; // To store various details like imageBase64, altText, externalEmbed

      // Parse commandContent based on commandType
      // Assuming format "[text for LLM to generate post] | [media prompt]" for commands with media
      // And just "[text for LLM to generate post]" for 'text' type.
      // For 'art', 'image', 'video', commandContent is "[text for LLM] | [prompt for media]"
      // or just "[prompt for media]" if no preceding text for LLM.
      // or just "[text for LLM]" if no pipe and media should be auto-derived (not current plan for these commands).

      const parts = commandContent.split('|').map(p => p.trim());
      if (commandType === 'text') {
        textForLLM = commandContent; // Entire content is for LLM
      } else if (parts.length > 1) {
        textForLLM = parts[0];
        mediaPrompt = parts.slice(1).join('|').trim(); // Join back if there were pipes in media prompt
      } else {
        // No pipe: could be only textForLLM or only mediaPrompt depending on command intent.
        // For !post+art, !post+image, !post+video, if no pipe, assume content is mediaPrompt and textForLLM is empty.
        if (commandType === 'art' || commandType === 'image' || commandType === 'video') {
            mediaPrompt = commandContent;
            textForLLM = ""; // No specific text for LLM to generate, might use alt text or default.
        } else { // Should not happen if commandType is validated by monitor
            textForLLM = commandContent;
        }
      }

      console.log(`[ADMIN_CMD_PARSED] textForLLM: "${textForLLM}", mediaPrompt: "${mediaPrompt}" for type: ${commandType}`);


      // Initial text generation (if textForLLM is provided)
      let generatedPostText = "";
      if (textForLLM) {
        generatedPostText = await this.generateStandalonePostFromContext(context, textForLLM);
        if (generatedPostText) {
          console.log(`Admin command: Generated initial post text (first 50 chars): "${generatedPostText.substring(0,50)}..."`);
        } else {
          console.warn(`Admin command: generateStandalonePostFromContext returned no text for LLM prompt: "${textForLLM}"`);
        }
      }

      let finalPostText = generatedPostText; // Start with LLM generated text
      let mediaError = null;

      switch (commandType) {
        case 'art': // Formerly !post+image, uses FLUX
          if (!mediaPrompt) {
            mediaError = "Art generation requested with !post+art, but no art prompt was provided.";
            break;
          }
          console.log(`Admin command type 'art': Generating art with prompt: "${mediaPrompt}"`);
          const scoutResultArt = await this.processImagePromptWithScout(mediaPrompt);
          if (!scoutResultArt.safe) {
            mediaError = scoutResultArt.reply_text || "Art prompt deemed unsafe by Scout.";
          } else {
            postDetails.imageBase64 = await this.generateImage(scoutResultArt.image_prompt);
            if (postDetails.imageBase64) {
              postDetails.altText = await this.describeImageWithScout(postDetails.imageBase64) || `Generated art for: ${mediaPrompt}`;
              if (!finalPostText && postDetails.altText) finalPostText = postDetails.altText; // Use alt as text if no other text
            } else {
              mediaError = "Art generation by Flux failed.";
            }
          }
          break;

        case 'image': // New: Web search for an image
          if (!mediaPrompt) {
            mediaError = "Image search requested with !post+image, but no search query was provided.";
            break;
          }
          console.log(`Admin command type 'image': Searching web for image with query: "${mediaPrompt}"`);
          const imageSearchResults = await this.performGoogleWebSearch(mediaPrompt, null, 'image');
          if (imageSearchResults && imageSearchResults.length > 0) {
            const imageResult = imageSearchResults[0]; // Take the first image
            postDetails.imageBase64 = await utils.imageUrlToBase64(imageResult.imageUrl);
            if (postDetails.imageBase64) {
              postDetails.altText = imageResult.title || `Image related to: ${mediaPrompt}`;
              // Attribution: Append to finalPostText later, after it's fully determined
              postDetails.sourceUrl = imageResult.contextUrl;
              if (!finalPostText && postDetails.altText) {
                finalPostText = postDetails.altText; // Use alt text as main text if no other text provided/generated
              }
            } else {
              mediaError = `Failed to download image found for "${mediaPrompt}" from ${imageResult.imageUrl}.`;
            }
          } else {
            mediaError = `No images found via web search for query: "${mediaPrompt}".`;
          }
          break;

        case 'video': // New: YouTube video
          if (!mediaPrompt) {
            mediaError = "YouTube video requested with !post+video, but no search query or URL was provided.";
            break;
          }
          console.log(`Admin command type 'video': Searching YouTube for: "${mediaPrompt}"`);
          const videoResults = await this.performYouTubeSearch(mediaPrompt, 1);

          if (videoResults && videoResults.length > 0) {
            const video = videoResults[0];
            postDetails.externalEmbed = {
              uri: video.videoUrl,
              title: video.title,
              description: utils.truncateResponse(video.description, 150) // Card description
            };
            // If finalPostText is empty, we might use the video title.
            if (!finalPostText) {
              finalPostText = video.title;
            }
            console.log(`[ADMIN_CMD] Found YouTube video: ${video.title} - ${video.videoUrl}`);
          } else {
            mediaError = `No YouTube videos found for query: "${mediaPrompt}".`;
          }
          break;

        case 'text': // Text-only post
          console.log(`Admin command type 'text': Using generated text.`);
          // finalPostText is already set from generatedPostText
          if (!finalPostText && textForLLM) { // If LLM failed but original instruction was there
            finalPostText = textForLLM; // Fallback to using admin's direct text if LLM provided nothing
            console.log(`[ADMIN_CMD] LLM returned no text, using admin's raw textForLLM for 'text' type post.`);
          } else if (!finalPostText && !textForLLM) {
             mediaError = "Text post requested but no text was provided or generated.";
          }
          break;

        default:
          console.warn(`[ADMIN_CMD] Unknown command type: ${commandType}`);
          mediaError = `Unknown admin command type "${commandType}".`;
      }

      if (mediaError) {
        console.warn(`[ADMIN_CMD] Media error for type ${commandType}: ${mediaError}`);
      }

      // Add attribution for web-searched images if one was successfully processed
      if (commandType === 'image' && postDetails.imageBase64 && postDetails.sourceUrl) {
        if (finalPostText) {
          finalPostText += `\n\n(Image Source: ${postDetails.sourceUrl})`;
        } else {
          // This case should ideally not happen if finalPostText was set to altText,
          // but as a fallback if finalPostText is still empty.
          finalPostText = `(Image Source: ${postDetails.sourceUrl})`;
        }
      }

      // Consolidate posting logic
      if (finalPostText || postDetails.imageBase64 || postDetails.externalEmbed) {
        console.log(`[ADMIN_CMD_POSTING] Attempting post. Final text (50): "${finalPostText ? finalPostText.substring(0,50)+'...' : 'null'}", image: ${!!postDetails.imageBase64}, embed: ${!!postDetails.externalEmbed}`);

        // postToOwnFeed needs to be adapted if it only takes imageBase64 and not externalEmbed yet
        // For now, assuming postToOwnFeed can handle text, imageBase64, altText.
        // If externalEmbed is present, we'd need a different flow or enhanced postToOwnFeed.
        // Let's simplify: if externalEmbed, we expect text and that. If imageBase64, text and that.

        const postSuccess = await this.postToOwnFeed(finalPostText, postDetails.imageBase64, postDetails.altText, postDetails.externalEmbed);

        if (postSuccess) {
          let confirmationMessage = `Admin command type '${commandType}' executed.`;
          if (finalPostText && (postDetails.imageBase64 || postDetails.externalEmbed)) {
            confirmationMessage += ` I've posted text and media to my feed.`;
          } else if (finalPostText) {
            confirmationMessage += ` I've posted text to my feed.`;
          } else if (postDetails.imageBase64 || postDetails.externalEmbed) {
            confirmationMessage += ` I've posted media to my feed.`;
          }
          if (mediaError) confirmationMessage += ` (Media processing note: ${mediaError})`;

          await this.postReply(post, confirmationMessage);
        } else {
          await this.postReply(post, `Admin command type '${commandType}' failed: Could not post to my own feed. ${mediaError ? `(Media error: ${mediaError})` : ""}`);
        }
      } else if (mediaError) { // No text generated/provided AND media processing failed
         await this.postReply(post, `Admin command type '${commandType}' failed: ${mediaError}. No content was posted.`);
      } else { // No text, no media, no error - implies empty command or LLM failure for text-only
         await this.postReply(post, `Admin command type '${commandType}' resulted in no content to post. Please check your command or prompt.`);
      }

    } catch (error) {
      console.error(`FATAL Error handling admin command type ${commandType} for post ${post.uri}:`, error);
      await this.postReply(post, `An unexpected error occurred while handling the admin command: ${error.message}`);
    }
  }

  async generateStandalonePostFromContext(context, adminInstructions) {
    console.log('BaseBot.generateStandalonePostFromContext called. Context (sample):', context ? JSON.stringify(context.slice(0,1)) : "null", 'Instructions:', adminInstructions);
    return 'Placeholder post text generated from context by BaseBot.';
  }

  async postToOwnFeed(text, imageBase64 = null, altText = "Generated image", externalEmbedDetails = null) {
    let postText = text ? utils.truncateResponse(text) : null;

    // If there's media (image or external link) but no text, set text to empty string for the post object.
    if ((imageBase64 || externalEmbedDetails) && postText === null) {
      postText = "";
    }

    if (postText === null && !imageBase64 && !externalEmbedDetails) {
      console.warn(`[postToOwnFeed] Attempted to post with no text and no media. Aborting.`);
      return false;
    }

    console.log(`Attempting to post to own feed. Text: "${postText}"`,
                imageBase64 ? `Image included (Alt: "${altText}")` : "",
                externalEmbedDetails ? `External embed included (URI: "${externalEmbedDetails.uri}")` : "");
    try {
      RateLimit.check();
      const postObject = {};

      if (postText !== null) { // Allows empty string if media is present
        postObject.text = postText;
      }

      // Embed logic: External Link Card takes precedence if both somehow provided (though current admin logic won't do that)
      if (externalEmbedDetails && externalEmbedDetails.uri && externalEmbedDetails.title && externalEmbedDetails.description) {
        postObject.embed = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: externalEmbedDetails.uri,
            title: externalEmbedDetails.title,
            description: externalEmbedDetails.description
          }
        };
        console.log(`[postToOwnFeed] External link card embed created for URI: ${externalEmbedDetails.uri}`);
      } else if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
        console.log(`[postToOwnFeed] imageBase64 received, length: ${imageBase64.length}. Attempting to upload.`);
        try {
          const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
          console.log(`[postToOwnFeed] Converted base64 to Uint8Array, size: ${imageBytes.length} bytes.`);
          if (imageBytes.length === 0) {
            console.error('[postToOwnFeed] Image byte array is empty after conversion. Skipping image upload.');
          } else {
            // Assuming imageMimeType would be 'image/png' or 'image/gif' by default for admin posts if not specified
            // For now, postToOwnFeed defaults to 'image/png' for direct image uploads if not specified otherwise.
            // If this method needs to handle GIFs from admin, it would need mimeType too.
            const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: 'image/png' }); // Defaulting to png for now
            console.log('[postToOwnFeed] Successfully uploaded image to Bluesky:', JSON.stringify(uploadedImage));
            if (uploadedImage && uploadedImage.data && uploadedImage.data.blob) {
              postObject.embed = {
                $type: 'app.bsky.embed.images',
                images: [{ image: uploadedImage.data.blob, alt: altText }]
              };
              console.log(`[postToOwnFeed] Image embed object created with alt text: "${altText}"`);
            } else {
              console.error('[postToOwnFeed] Uploaded image data or blob is missing in Bluesky response. Cannot embed image.');
            }
          }
        } catch (uploadError) { console.error('[postToOwnFeed] Error during image upload or embed creation:', uploadError); }
      } else if (imageBase64) { // imageBase64 present but not a valid string or empty
        console.warn(`[postToOwnFeed] imageBase64 was provided but invalid. Skipping image embed.`);
      }

      // Final check: ensure there's something to post (either text or an embed)
      if (postObject.text === undefined && !postObject.embed) {
          console.warn('[postToOwnFeed] Post object is effectively empty (no text and no image embed). Aborting post.');
          return false;
      }

      console.log(`[POST_TO_OWN_FEED_INVOKED] Timestamp: ${new Date().toISOString()}, PostObject: ${JSON.stringify(postObject)}`);
      const result = await this.agent.post(postObject);
      console.log(`Successfully posted to own feed. New post URI: ${result.uri}`);
      console.log(`[POST_TO_OWN_FEED_SUCCESS] Timestamp: ${new Date().toISOString()}, URI: ${result.uri}, Content: ${JSON.stringify(postObject)}`);
      return true;
    } catch (error) {
      console.error('Error posting to own feed:', error);
      return false;
    }
  }

  async monitor() {
    let consecutiveErrors = 0;
    const MAX_RETRIES = 5;
    const BACKOFF_DELAY = 60000;

    try {
      await this.authenticate();
      console.log('Starting monitoring...');
      // lastCheckedPost logic might need re-evaluation if we process multiple notifications per cycle.
      // For now, we'll rely on repliedPosts set to avoid re-processing actionable items.
      // We will also need to manage fetching notifications with a cursor to avoid missing any over time.
      // This is a simplified loop for now, focusing on processing current batch.
      let lastSeenNotificationTimestamp = null; // Or use cursor from listNotifications

      while (true) {
        try {
          // Fetch notifications (getRecentPosts now returns raw notifications)
          // To avoid missing notifs, ideally use the cursor from listNotifications.
          // For this iteration, getRecentPosts fetches a batch.
          const notifications = await this.getRecentPosts();

          if (!notifications || notifications.length === 0) {
            await utils.sleep(this.config.CHECK_INTERVAL);
            continue;
          }

          // Process notifications, typically newest first if API returns them that way.
          // We might want to reverse or sort them by createdAt if processing order matters strictly.
          // For now, processing in received order.
          for (const notif of notifications.slice().reverse()) { // Process older notifications first in a batch
            if (!notif || !notif.record || !notif.author) { // Basic sanity check
                console.warn("[Monitor] Skipping invalid notification object:", notif);
                continue;
            }

            // Update last seen timestamp (simplified cursor management)
            if (lastSeenNotificationTimestamp && new Date(notif.indexedAt) <= lastSeenNotificationTimestamp) {
                // continue; // Already seen this or older, if listNotifications doesn't use a proper cursor for us
            }
            // lastSeenNotificationTimestamp = new Date(notif.indexedAt);


            if (notif.reason === 'like') {
              if (notif.record.subject && notif.record.subject.uri) {
                const likedPostUri = notif.record.subject.uri;
                const likerHandle = notif.author.handle;
                console.log(`[Notification] Post ${likedPostUri} was liked by @${likerHandle}`);
                // Add to repliedPosts to ensure we don't try to process this 'like' as a mention/reply later
                // if the like notification itself has a URI that might be misconstrued.
                // However, 'like' notifications usually have their own URI, not the post's.
                // The main check is that we don't pass 'like' records to generateResponse.
              }
              continue; // Don't process 'like' notifications further for replies
            }

            // For other actionable types (reply, mention, quote)
            // Ensure the record is a post type we can handle, e.g. app.bsky.feed.post
            if (notif.record.$type !== 'app.bsky.feed.post') {
                console.log(`[Monitor] Skipping notification for non-post record type: ${notif.record.$type} from @${notif.author.handle}`);
                continue;
            }

            // Construct a 'post' object similar to what previous logic expected
            const currentPostObject = {
              uri: notif.uri, // URI of the post that caused the notification (e.g., the reply, the mention)
              cid: notif.cid,
              author: notif.author,
              record: notif.record,
              // For context fetching, we might need the root of the thread if it's a reply.
              // The 'post' object passed to generateResponse needs to be consistent.
              // The existing getReplyContext uses post.uri and post.record.reply.
            };

            let isAdminCmdHandled = false;
            const adminPostText = currentPostObject.record.text || "";

            // Check for Admin Commands first
            if (currentPostObject.author.handle === this.config.ADMIN_BLUESKY_HANDLE && adminPostText.includes('!post')) {
              const commandText = adminPostText;
              let commandContent = "";
              let commandType = null; // 'art', 'image', 'video', or 'text'
              let commandSearchText = commandText;
              const botMention = `@${this.config.BLUESKY_IDENTIFIER}`;

              if (commandText.startsWith(botMention)) {
                  commandSearchText = commandText.substring(botMention.length).trim();
              }

              if (commandSearchText.startsWith("!post+art ")) {
                  commandType = 'art';
                  commandContent = commandSearchText.substring("!post+art ".length).trim();
              } else if (commandSearchText.startsWith("!post+image ")) {
                  commandType = 'image';
                  commandContent = commandSearchText.substring("!post+image ".length).trim();
              } else if (commandSearchText.startsWith("!post+video ")) {
                  commandType = 'video';
                  commandContent = commandSearchText.substring("!post+video ".length).trim();
              } else if (commandSearchText.startsWith("!post ")) { // Text-only post
                  commandType = 'text';
                  commandContent = commandSearchText.substring("!post ".length).trim();
              }

              if (commandType) {
                console.log(`[Monitor] Admin command type "${commandType}" detected: "${commandSearchText}" in post ${currentPostObject.uri}`);
                // Pass currentPostObject, commandContent (which is the part after the command keyword), and commandType
                await this.handleAdminPostCommand(currentPostObject, commandContent, commandType);
                isAdminCmdHandled = true;
              } else if (commandSearchText.includes("!post")) { // It includes !post but not a recognized full command
                console.log(`[Monitor] Admin post ${currentPostObject.uri} included '!post' but not as a recognized command prefix like !post+art, !post+image, !post+video, or !post (for text).`);
              }
            }

            // If not an admin command (like !post+art), then check if the admin is mentioning the BOT'S OWN NAME or HANDLE.
            let adminMentionMatch = false;
            let adminMatchedName = null;
            const adminPostTextLower = adminPostText.toLowerCase();

            if (!isAdminCmdHandled && currentPostObject.author.handle === this.config.ADMIN_BLUESKY_HANDLE) {
                if (this.botDisplayName && this.botDisplayName.trim() !== "") {
                    if (adminPostTextLower.includes(this.botDisplayName.toLowerCase())) {
                        adminMentionMatch = true;
                        adminMatchedName = this.botDisplayName;
                    }
                }
                if (!adminMentionMatch && this.botHandle && this.botHandle.trim() !== "") {
                    const handleBase = this.botHandle.split('.')[0];
                    if (adminPostTextLower.includes(this.botHandle.toLowerCase())) {
                        adminMentionMatch = true;
                        adminMatchedName = this.botHandle;
                    } else if (adminPostTextLower.includes(handleBase.toLowerCase())) {
                        adminMentionMatch = true;
                        adminMatchedName = handleBase;
                    }
                }
            }

            if (adminMentionMatch) {
              console.log(`[Monitor] SUCCESS: Admin mentioned bot's name/handle (matched: "${adminMatchedName}") in post ${currentPostObject.uri}. Admin text: "${adminPostText.substring(0,100)}..."`);
              if (await this.hasAlreadyReplied(currentPostObject)) {
                console.log(`[Monitor] SKIP: Already replied to admin's bot mention post ${currentPostObject.uri}.`);
              } else {
                console.log(`[Monitor] ACTION: Conditions met for replying to admin's mention of bot in ${currentPostObject.uri}.`);
                const context = await this.getReplyContext(currentPostObject);
                const adminMentionBotSystemPrompt = `You are an AI assistant with the persona defined in the main system prompt. The administrator, @${currentPostObject.author.handle}, mentioned you ("${this.botDisplayName}") in their post. Craft a helpful, relevant, and perhaps slightly prioritized reply in your persona, acknowledging it's the admin.`;
                const adminMentionBotUserPrompt = `Full Conversation Context (if any, oldest first):\n${context.map(p => `${p.author}: ${p.text ? p.text.substring(0, 200) + (p.text.length > 200 ? '...' : '') : ''}`).join('\n---\n')}\n\nAdministrator @${currentPostObject.author.handle}'s relevant post (that mentions you, "${this.botDisplayName}"):\n"${adminPostText}"\n\nBased on this, generate a suitable reply in your defined persona.`;

                console.log(`[Monitor] Generating response to admin's mention of bot name in post ${currentPostObject.uri}`);

                const nimResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                    body: JSON.stringify({
                        model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
                        messages: [
                            { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT} ${adminMentionBotSystemPrompt}` }, // Added TEXT_SYSTEM_PROMPT
                            { role: "user", content: adminMentionBotUserPrompt }
                        ],
                        temperature: 0.7, max_tokens: 150, stream: false
                    }),
                    customTimeout: 120000 // 120s
                });

                let responseText = null;
                if (nimResponse.ok) {
                    const nimData = await nimResponse.json();
                    if (nimData.choices && nimData.choices[0].message && nimData.choices[0].message.content) {
                        let rawNimText = nimData.choices[0].message.content.trim();
                        // Filter with Scout/Gemma
                        const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                            body: JSON.stringify({
                                model: 'meta/llama-3.2-90b-vision-instruct',
                                messages: [
                                     { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                                    { role: "user", content: rawNimText }
                                ],
                                temperature: 0.1, max_tokens: 100, stream: false
                            }),
                            customTimeout: 90000 // 90s
                        });
                        if (filterResponse.ok) {
                            const filterData = await filterResponse.json();
                            if (filterData.choices && filterData.choices[0].message) {
                                responseText = filterData.choices[0].message.content.trim();
                            } else {
                                responseText = this.basicFormatFallback(rawNimText);
                            }
                        } else {
                             responseText = this.basicFormatFallback(rawNimText);
                        }
                    }
                } else {
                    console.error(`[Monitor] NIM API error generating response for admin's mention of bot: ${nimResponse.status}`);
                }

                if (responseText) {
                  await this.postReply(currentPostObject, responseText);
                  console.log(`[Monitor] Replied to admin's mention of bot name in post ${currentPostObject.uri}`);
                } else {
                  console.error(`[Monitor] Failed to generate response for admin's mention of bot name.`);
                }
                isAdminCmdHandled = true; // Mark as handled to prevent further default processing
              }
            }


            if (!isAdminCmdHandled) {
              if (await this.hasAlreadyReplied(currentPostObject)) { // Pass the full post object
                console.log(`[Monitor] Already replied to post ${currentPostObject.uri} or it's a like. Skipping.`);
                continue;
              }

              // Standard response generation for mentions, replies, quotes to the BOT
              console.log(`[Monitor] Processing notification for post ${currentPostObject.uri} from @${currentPostObject.author.handle}, reason: ${notif.reason}`);
              const context = await this.getReplyContext(currentPostObject); // Pass the full post object
              const responseText = await this.generateResponse(currentPostObject, context); // Pass the full post object

              if (responseText) { // generateResponse now handles search history internally and might return null
                // Image generation request detection
                const imageRequestKeywords = ["generate image", "create a picture of", "draw a picture of", "make an image of", "draw an image of", "generate a picture of"];
                let isImageRequest = false;
                let imagePrompt = "";
                const originalUserText = (currentPostObject.record.text || "");
                const lowerUserText = originalUserText.toLowerCase();
                const botHandleLower = `@${this.config.BLUESKY_IDENTIFIER.toLowerCase()}`;

                let textToParseForPrompt = lowerUserText;
                if (textToParseForPrompt.startsWith(botHandleLower)) {
                    textToParseForPrompt = textToParseForPrompt.substring(botHandleLower.length).trim();
                }

                for (const keyword of imageRequestKeywords) {
                    const keywordIndex = textToParseForPrompt.indexOf(keyword);
                    if (keywordIndex !== -1) {
                        isImageRequest = true;
                        imagePrompt = textToParseForPrompt.substring(keywordIndex + keyword.length).trim();
                        // Further clean common leading prepositions like "of", "for", "about"
                        const prepositions = ["of ", "for ", "about ", "displaying ", "showing ", "depicting ", "that shows ", "that is ", "that depicts "];
                        for (const prep of prepositions) {
                            if (imagePrompt.startsWith(prep)) {
                                imagePrompt = imagePrompt.substring(prep.length).trim();
                                // No break here, allow stripping multiple if they are chained, e.g. "of for a..."
                            }
                        }
                        if (imagePrompt) { // Ensure prompt is not empty after stripping
                           break; // Found keyword and extracted prompt
                        } else {
                           isImageRequest = false; // Keyword was at the end, no actual prompt
                        }
                    }
                }

                if (isImageRequest && imagePrompt) {
                  console.log(`[Monitor] Image generation request detected. Original user text: "${originalUserText}", Extracted prompt for AI processing: "${imagePrompt}"`);
                  const textResponsePart = responseText ? `${responseText}\n\n` : ""; // Use Nemotron's text if available

                  const scoutResult = await this.processImagePromptWithScout(imagePrompt); // This now uses Llama 3.2 Vision
                  if (!scoutResult.safe) {
                      await this.postReply(currentPostObject, `${textResponsePart}Regarding your image request: ${scoutResult.reply_text}`);
                  } else {
                      const imageBase64 = await this.generateImage(scoutResult.image_prompt); // FLUX call
                      if (imageBase64) {
                          const altText = await this.describeImageWithScout(imageBase64) || `Generated image for: ${scoutResult.image_prompt}`; // Llama 3.2 Vision for alt text
                          await this.postReply(currentPostObject, `${textResponsePart}Here's the image you requested:`, imageBase64, altText);
                      } else {
                          await this.postReply(currentPostObject, `${textResponsePart}I tried to generate an image for "${scoutResult.image_prompt}", but it didn't work out this time.`);
                      }
                  }
                } else {
                  // If not an image request, or prompt extraction failed, just post the text response (if any)
                  if (responseText) { // Only post if there's something to say
                    await this.postReply(currentPostObject, responseText);
                  }
                }
              }
            }
          } // end for...of notifications loop

          consecutiveErrors = 0;
          // Update lastSeenNotificationTimestamp based on the newest processed notification if using timestamp cursor
          if (notifications.length > 0) {
             // lastSeenNotificationTimestamp = new Date(notifications[0].indexedAt); // Assuming notifications are newest first
          }
          await utils.sleep(this.config.CHECK_INTERVAL);
        } catch (error) {
          console.error('Error in monitoring loop:', error);
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_RETRIES) {
            console.error(`Maximum retries (${MAX_RETRIES}) reached, restarting monitor...`);
            break;
          }
          const delay = BACKOFF_DELAY * Math.pow(2, consecutiveErrors - 1);
          console.log(`Retrying in ${delay/1000} seconds...`);
          await utils.sleep(delay);
        }
      }
    } catch (error) {
      console.error('Fatal error in monitor:', error);
      await utils.sleep(BACKOFF_DELAY);
    }
  }

  async authenticate() {
    try {
      await this.agent.login({
        identifier: this.config.BLUESKY_IDENTIFIER,
        password: this.config.BLUESKY_APP_PASSWORD,
      });
      console.log('Successfully authenticated with Bluesky');

      // Resolve Admin Handle to DID if configured
      if (this.config.ADMIN_BLUESKY_HANDLE) {
        if (this.config.ADMIN_BLUESKY_HANDLE.startsWith('did:plc:')) {
          this.adminDid = this.config.ADMIN_BLUESKY_HANDLE;
          console.log(`[AdminDID] Admin DID configured directly: ${this.adminDid}`);
        } else {
          try {
            console.log(`[AdminDID] Resolving admin handle: ${this.config.ADMIN_BLUESKY_HANDLE}`);
            const res = await this.agent.resolveHandle({ handle: this.config.ADMIN_BLUESKY_HANDLE });
            if (res.success && res.data.did) {
              this.adminDid = res.data.did;
              console.log(`[AdminDID] Successfully resolved admin handle ${this.config.ADMIN_BLUESKY_HANDLE} to DID: ${this.adminDid}`);
            } else {
              console.error(`[AdminDID] Failed to resolve admin handle ${this.config.ADMIN_BLUESKY_HANDLE}:`, res.error || 'Unknown error');
            }
          } catch (resolveError) {
            console.error(`[AdminDID] Exception during admin handle resolution for ${this.config.ADMIN_BLUESKY_HANDLE}:`, resolveError);
          }
        }
      } else {
        console.log('[AdminDID] No ADMIN_BLUESKY_HANDLE configured.');
      }

      // Infer Bot's Own Display Name
      if (this.config.BLUESKY_IDENTIFIER) { // BLUESKY_IDENTIFIER is the bot's DID
        console.log(`[BotNameInference] Bot DID configured: ${this.config.BLUESKY_IDENTIFIER}`);
        try {
          // this.agent.did should also be available here and be the same as BLUESKY_IDENTIFIER after login
          const res = await this.agent.api.app.bsky.actor.getProfile({ actor: this.agent.did });
          if (res.success && res.data) {
            this.botDisplayName = res.data.displayName;
            this.botHandle = res.data.handle; // Bot's own handle

            if (this.botHandle) { // Log handle if present
                console.log(`[BotNameInference] Bot Handle: ${this.botHandle}`);
            }

            if (!this.botDisplayName && this.botHandle) {
              // Fallback: parse from handle (e.g., "dearestllama" from "dearest-llama.bsky.social")
              this.botDisplayName = this.botHandle.split('.')[0].split('-').join(''); // Basic split and join, e.g., "dearest-llama" -> "dearestllama"
              console.log(`[BotNameInference] Bot display name was empty, inferred "${this.botDisplayName}" from its handle ${this.botHandle}.`);
            } else if (this.botDisplayName) {
              console.log(`[BotNameInference] Successfully fetched bot's own profile. DisplayName: "${this.botDisplayName}".`);
            } else {
              // This case means displayName is empty AND handle was also empty or not processed for fallback
              console.warn(`[BotNameInference] Bot profile fetched, but displayName is empty and handle could not be used for fallback. Handle: ${this.botHandle || 'not available'}`);
            }
          } else {
            console.error(`[BotNameInference] Failed to fetch profile for bot's own DID ${this.agent.did}:`, res.error || 'Unknown error');
          }
        } catch (profileError) {
          console.error(`[BotNameInference] Exception during bot's own profile fetch for ${this.agent.did}:`, profileError);
        }
      } else {
        // This should not happen if BLUESKY_IDENTIFIER is a required config
        console.warn('[BotNameInference] BLUESKY_IDENTIFIER (bot\'s DID) is not configured. Bot name inference skipped.');
      }

    } catch (error) {
      console.error('Authentication and name inference failed:', error);
      throw error;
    }
  }

  async getRecentPosts() {
    try {
      // Fetch a broader set of notifications, including likes
      const { data: notificationResponse } = await this.agent.listNotifications({ limit: 30 }); // Fetch more to see various types
      if (!notificationResponse || !notificationResponse.notifications) {
        console.warn('[getRecentPosts] No notifications object returned or empty notifications array.');
        return [];
      }
      // We will return the raw notifications and let the monitor loop decide how to process them.
      // Still filter out notifications triggered by the bot itself.
      const allNotifications = notificationResponse.notifications.filter(
        notif => notif.author.handle !== this.config.BLUESKY_IDENTIFIER
      );
      return allNotifications;
    } catch (error) {
      console.error('Error in getRecentPosts:', error);
      return [];
    }
  }

  async getReplyContext(post) {
    try {
      const conversation = [];

      // Helper to extract image details from a record's embed
      // Now accepts authorDid to construct URLs if necessary
      const extractImages = (record, authorDid) => {
        const images = record?.embed?.images || record?.embed?.media?.images || [];
        // New Log 1: Initial call and raw images found
        console.log(`[extractImages] Called. Author DID: ${authorDid}. Raw images found in embed: ${images.length}`);
        if (images.length > 0) {
          // New Log 2: Details of the first raw image object (if any) for inspection
          console.log(`[extractImages] Details of first raw image object: ${JSON.stringify(images[0], null, 2)}`);
        }

        return images.map((img, idx) => {
          let imageUrl = img.fullsize || img.thumb;
          let cidString = null;

          // Log initial state for this image
          console.log(`[extractImages DEBUG] Processing image ${idx}: Direct fullsize/thumb: ${imageUrl}, Author DID: ${authorDid}`);
          console.log(`[extractImages DEBUG] Image ${idx} object: ${JSON.stringify(img, null, 2)}`);


          // Attempt to get CID string from the .ref object (which might be a CID instance)
          if (img.image && img.image.ref && typeof img.image.ref.toString === 'function') {
            cidString = img.image.ref.toString();
            console.log(`[extractImages] Image ${idx}: Extracted CID via img.image.ref.toString(): ${cidString}`);
          }

          // Fallback: Check for a direct $link property on img.image.ref (as seen in some LiteRecord contexts)
          // This is less likely for the direct notification embed based on recent logs, but kept for robustness.
          if (!cidString && img.image && img.image.ref && typeof img.image.ref.$link === 'string') {
            cidString = img.image.ref.$link;
            console.log(`[extractImages] Image ${idx}: Extracted CID via img.image.ref.$link: ${cidString}`);
          }

          // Fallback: Check for a direct cid string on img.image (less common for blobs, but good to have)
          if (!cidString && img.image && typeof img.image.cid === 'string') {
            cidString = img.image.cid;
            console.log(`[extractImages] Image ${idx}: Extracted CID via img.image.cid: ${cidString}`);
          }

          // If we have a CID string and an author DID, construct the URL
          if (!imageUrl && authorDid && cidString) {
            console.log(`[extractImages] Image ${idx}: Constructing URL. Author DID: ${authorDid}, CID: ${cidString}`);
            imageUrl = `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${authorDid}&cid=${cidString}`;
          } else if (!imageUrl) {
            // This log helps if no URL was formed via direct properties or CID methods.
            console.log(`[extractImages] Image ${idx}: Could not determine imageUrl. authorDid: ${authorDid}, cidString: ${cidString}, Raw img.image: ${JSON.stringify(img.image, null, 2)}`);
          }

          console.log(`[extractImages] Image ${idx}: Final imageUrl for this image: ${imageUrl}, Alt: ${img.alt || ''}`);
          return { alt: img.alt || '', url: imageUrl };

        }).filter(imgObject => { // Changed variable name to avoid confusion with 'img' in map
          const shouldRetain = !!imgObject.url;
          if (!shouldRetain) {
            // New Log 8: Image being filtered out
            console.log(`[extractImages] Filtering out image due to missing/falsy URL. Image object details: ${JSON.stringify(imgObject, null, 2)}`);
          }
          return shouldRetain;
        });
      };

      // Add current post details
      conversation.push({
        uri: post.uri,
        author: post.author.handle,
        text: post.record.text,
        createdAt: post.record.createdAt,
        images: extractImages(post.record, post.author.did) // Pass current post's author DID
      });

      // Handle quoted post
      if (post.record.embed?.$type === 'app.bsky.embed.record' && post.record.embed.record) {
        const quotedPostRef = post.record.embed.record; // This is a LiteRecord, might not have .record.text directly
        const quotedPostUri = quotedPostRef.uri;
        console.log(`[getReplyContext] Quoted post detected: ${quotedPostUri}`);
        try {
          // Fetch the full quoted post to get its record and author DID for image URL construction
          const { data: quotedPostThread } = await this.agent.getPostThread({ uri: quotedPostUri, depth: 0 });
          const fullQuotedPost = quotedPostThread?.thread?.post;

          if (fullQuotedPost && fullQuotedPost.record && fullQuotedPost.author) {
            console.log(`[getReplyContext] Successfully fetched full quoted post by ${fullQuotedPost.author.handle}`);
            const quotedImages = extractImages(fullQuotedPost.record, fullQuotedPost.author.did);

            conversation.unshift({ // Add quoted post to the beginning
              uri: fullQuotedPost.uri,
              author: fullQuotedPost.author.handle,
              text: fullQuotedPost.record.text, // Text from the full record
              createdAt: fullQuotedPost.record.createdAt,
              images: quotedImages
            });
          } else {
            console.warn(`[getReplyContext] Could not fetch full details for quoted post ${quotedPostUri}. Attempting to use LiteRecord info.`);
            // Fallback: Try to use info from the LiteRecord if available
            // Note: LiteRecord value might be a postRecord or just a basic view.
            // Author DID might not be present on LiteRecord directly, so image URLs from CID might fail.
            const liteRecordValue = quotedPostRef.value || {}; // .value should be the actual record content
            const liteRecordAuthorDid = quotedPostRef.author?.did; // Attempt to get author DID from the reference
            const quotedImages = extractImages({ embed: liteRecordValue.embed }, liteRecordAuthorDid); // Pass a compatible structure
             conversation.unshift({
              uri: quotedPostUri,
              author: quotedPostRef.author?.handle || 'unknown author',
              text: liteRecordValue?.text,
              createdAt: liteRecordValue?.createdAt, // This might be undefined if not on LiteRecord
              images: quotedImages
            });
          }
        } catch (error) {
            console.error(`[getReplyContext] Error fetching or processing quoted post ${quotedPostUri}:`, error);
        }
      }

      // Handle reply thread (parents)
      if (post.record?.reply) {
        let currentUri = post.record.reply.parent?.uri;
        let safetyCount = 0;

        while (currentUri && safetyCount < 5) {
          safetyCount++;
          try {
            const { data: thread } = await this.agent.getPostThread({ uri: currentUri, depth: 0, parentHeight: 0 });
            const parentPostInThread = thread?.thread?.post;

            if (!parentPostInThread) break;

            if (!parentPostInThread.record || !parentPostInThread.author) {
                console.warn(`[getReplyContext] Parent post ${currentUri} missing record or author data. Skipping.`);
                currentUri = parentPostInThread.record?.reply?.parent?.uri;
                continue;
            }

            // Use extractImages with the parent post's author DID
            const parentImages = extractImages(parentPostInThread.record, parentPostInThread.author.did);

            conversation.unshift({
              uri: parentPostInThread.uri,
              author: parentPostInThread.author.handle,
              text: parentPostInThread.record.text,
              createdAt: parentPostInThread.record.createdAt,
              images: parentImages
            });

            currentUri = parentPostInThread.record?.reply?.parent?.uri;
          } catch (fetchParentError) {
            console.error(`[getReplyContext] Error fetching parent post ${currentUri}:`, fetchParentError);
            break;
          }
        }
      }

      console.log('[getReplyContext] Final conversation context structure (oldest to newest):');
      conversation.forEach((item, index) => {
        console.log(`[getReplyContext] Context[${index}]: PostURI: ${item.uri}, Author: ${item.author}, Text: "${item.text?.substring(0,70)}...", Images: ${item.images?.length || 0}`);
        if (item.images?.length > 0) {
          item.images.forEach((img, imgIdx) => {
            console.log(`[getReplyContext] Context[${index}] Image[${imgIdx}]: URL: ${img.url}, Alt: ${img.alt}`);
          });
        }
      });
      return conversation;
    } catch (error) {
      console.error('[getReplyContext] Fatal error in getReplyContext:', error);
      // Fallback with current post only
      const extractImagesFallback = (record, authorDid) => { // Basic version for fallback
        const images = record?.embed?.images || record?.embed?.media?.images || [];
        return images.map(img => ({ alt: img.alt || '', url: img.fullsize || img.thumb })).filter(img => img.url);
      };
      return [{
        uri: post.uri,
        author: post.author.handle,
        text: post.record.text,
        createdAt: post.record.createdAt, // Also add here for fallback
        images: extractImagesFallback(post.record, post.author.did)
      }];
    }
  }

  async postReply(post, response, imageBase64 = null, altText = "Generated image", embedRecordDetails = null, externalEmbedDetails = null, imageMimeType = 'image/png') {
    try {
      RateLimit.check();
      RateLimit.check();
      RateLimit.check();
      const CHAR_LIMIT_PER_POST = 300; // Bluesky's actual limit
      const PAGE_SUFFIX_MAX_LENGTH = " ... [X/Y]".length; // Approx length of " ... [1/4]" (length is same)
      const MAX_PARTS = 4; // Changed from 3 to 4
      let textParts = [];
      let postedPartUris = []; // Initialize array to store URIs of posted parts
      let lastSuccessfulCid = null; // Added to store the CID of the last successfully posted part

      let currentReplyTo = {
          root: post.record?.reply?.root || { uri: post.uri, cid: post.cid },
          parent: { uri: post.uri, cid: post.cid }
      };

      // Helper function for smart splitting
      const splitTextIntoParts = (text, limitPerPartWithoutSuffix) => {
          const parts = [];
          let remainingText = text.trim();

          while (remainingText.length > 0 && parts.length < MAX_PARTS) {
              if (remainingText.length <= limitPerPartWithoutSuffix) {
                  parts.push(remainingText);
                  break;
              }

              let splitAt = limitPerPartWithoutSuffix;
              let foundSplit = false;
              // Try to find a sentence boundary or space to split at, looking backwards
              for (let i = Math.min(limitPerPartWithoutSuffix, remainingText.length -1) ; i > limitPerPartWithoutSuffix / 2 && i > 0; i--) {
                  if (['.', '!', '?'].includes(remainingText[i])) {
                      splitAt = i + 1;
                      foundSplit = true;
                      break;
                  }
              }
              if (!foundSplit) {
                for (let i = Math.min(limitPerPartWithoutSuffix, remainingText.length -1); i > limitPerPartWithoutSuffix / 2 && i > 0; i--) {
                    if (remainingText[i] === ' ') {
                        splitAt = i;
                        foundSplit = true;
                        break;
                    }
                }
              }

              parts.push(remainingText.substring(0, splitAt).trim());
              remainingText = remainingText.substring(splitAt).trim();
          }

          // If text still remains after MAX_PARTS, the last part needs truncation with "..."
          if (remainingText.length > 0 && parts.length >= MAX_PARTS) {
            let lastPart = parts[MAX_PARTS - 1];
            // Ensure "..." fits even after page suffix is added later
            const availableSpaceForTextInLastPart = limitPerPartWithoutSuffix - "...".length;
            if (lastPart.length > availableSpaceForTextInLastPart) {
                 lastPart = lastPart.substring(0, availableSpaceForTextInLastPart);
            }
            parts[MAX_PARTS - 1] = lastPart + "...";
          }
          return parts;
      };

      // Determine if splitting is needed and prepare text parts
      if (response && response.trim().length > 0) {
          // Tentatively assume single part, check length with potential suffix
          const singlePartSuffix = " ... [1/1]".length; // Longest possible suffix for single part
          if (response.length + (response.length > CHAR_LIMIT_PER_POST - singlePartSuffix ? PAGE_SUFFIX_MAX_LENGTH : 0) > CHAR_LIMIT_PER_POST) {
              // If it's too long even for one part with suffix, or just too long in general, then split.
              const effectiveLimitPerPost = CHAR_LIMIT_PER_POST - PAGE_SUFFIX_MAX_LENGTH;
              textParts = splitTextIntoParts(response, effectiveLimitPerPost);
          } else {
              textParts.push(response.trim());
          }
      } else if (!imageBase64) {
          // No text and no image
          console.warn("[postReply] No text and no image to post. Aborting.");
          return;
      }
      // If only an image, textParts will be empty initially, handled below.

      const totalParts = textParts.length > 0 ? textParts.length : (imageBase64 ? 1 : 0);
      if (totalParts === 0) {
          console.warn("[postReply] Calculated 0 parts (no text, no image). Nothing to post.");
          return;
      }
      if (textParts.length > MAX_PARTS) { // Should be handled by splitTextIntoParts, but as safeguard
          textParts = textParts.slice(0, MAX_PARTS);
      }


      for (let i = 0; i < totalParts; i++) {
          const isLastPart = (i === totalParts - 1);
          let partText = textParts[i] || ""; // Use empty string if only image on last part and textParts is empty

          if (totalParts > 1) {
              partText = `${partText.trim()} ... [${i + 1}/${totalParts}]`;
          }

          // Final safeguard, though previous logic should prevent exceeding this.
          // utils.truncateResponse might not be ideal here if it adds its own "..."
          if (partText.length > CHAR_LIMIT_PER_POST) {
             console.warn(`[postReply] Part ${i+1}/${totalParts} text still too long (${partText.length}) after suffix. Truncating hard.`);
             partText = partText.substring(0, CHAR_LIMIT_PER_POST - 3) + "...";
          }

          const replyObject = {
              text: partText.trim(), // Trim whitespace that might have been added
              reply: currentReplyTo
          };

          // Embed logic: Precedence: Record > External Link Card > Image
          // Embeds are typically only on the last part of a multi-part reply.
          if (isLastPart) {
            if (embedRecordDetails && embedRecordDetails.uri && embedRecordDetails.cid) {
              replyObject.embed = {
                $type: 'app.bsky.embed.record',
                record: {
                  uri: embedRecordDetails.uri,
                  cid: embedRecordDetails.cid
                }
              };
              console.log(`[postReply] Record embed for part ${i+1}/${totalParts} created for URI: ${embedRecordDetails.uri}`);
            } else if (externalEmbedDetails && externalEmbedDetails.uri && externalEmbedDetails.title && externalEmbedDetails.description) {
              replyObject.embed = {
                $type: 'app.bsky.embed.external',
                external: {
                  uri: externalEmbedDetails.uri,
                  title: externalEmbedDetails.title,
                  description: externalEmbedDetails.description
                  // Bluesky proxy will attempt to fetch a thumbnail from the URI
                }
              };
              console.log(`[postReply] External link card embed for part ${i+1}/${totalParts} created for URI: ${externalEmbedDetails.uri}`);
            } else if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
                try {
                    const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
                    if (imageBytes.length === 0) {
                        console.error('[postReply] Image byte array is empty for last part. Skipping image upload.');
                    } else {
                        const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: imageMimeType });
                        if (uploadedImage && uploadedImage.data && uploadedImage.data.blob) {
                            replyObject.embed = { $type: 'app.bsky.embed.images', images: [{ image: uploadedImage.data.blob, alt: altText }] };
                            console.log(`[postReply] Image embed for part ${i+1}/${totalParts} created with alt text: "${altText}" and mimeType: ${imageMimeType}`);
                        } else {
                            console.error('[postReply] Uploaded image data or blob is missing. Cannot embed image for last part.');
                        }
                    }
                } catch (uploadError) { console.error(`[postReply] Error during image upload for part ${i+1}/${totalParts}:`, uploadError); }
            } else if (imageBase64) { // imageBase64 present but invalid
                console.warn(`[postReply] imageBase64 was present for last part but invalid. Skipping image embed.`);
            }
          }

          // If only an embed is being posted (no text parts initially, e.g. just an image or card)
          if (totalParts === 1 && textParts.length === 0 && (imageBase64 || embedRecordDetails || externalEmbedDetails)) {
            replyObject.text = replyObject.text || ""; // Ensure text is at least an empty string if there's an embed and no other text.
          }

          // If there's an embed (any type), and the text is completely empty, Bluesky might require text to be explicitly null or not present.
          // However, the current logic sets text to "" if it was going to be empty with an embed.
          // For now, an empty string `text: ""` with an embed is generally acceptable.

          console.log(`[postReply] Attempting to post part ${i + 1}/${totalParts}. Text: "${replyObject.text.substring(0,50)}..." Embed type: ${replyObject.embed ? replyObject.embed.$type : 'none'}`);
          const result = await this.agent.post(replyObject);
          console.log(`Successfully posted part ${i + 1}/${totalParts}: ${result.uri}, CID: ${result.cid}`);
          postedPartUris.push(result.uri); // Add successfully posted URI
          lastSuccessfulCid = result.cid; // Store the CID of the successfully posted part

          if (!isLastPart) { // For the next part, reply to the part just posted
              currentReplyTo = {
                  root: currentReplyTo.root, // Root stays the same
                  parent: { uri: result.uri, cid: result.cid }
              };
          }
      }
      this.repliedPosts.add(post.uri); // Add original post URI to replied set after all parts are sent
      return { uris: postedPartUris, lastCid: lastSuccessfulCid }; // Return object with URIs and lastCid
    } catch (error) {
      console.error('Error posting multi-part reply:', error);
      this.repliedPosts.add(post.uri); // Still mark as replied to avoid loops on error
      // Return any URIs that were successfully posted before the error, and the lastCid obtained
      return { uris: postedPartUris, lastCid: lastSuccessfulCid };
    }
  }

  getModelName() {
    return 'Unknown Model';
  }

  async getLikers(postUri) {
    if (!postUri) return [];
    try {
      let likers = [];
      let cursor;
      console.log(`[getLikers] Fetching likes for post URI: ${postUri}`);
      do {
        // Making sure to await the call to the agent's method
        const response = await this.agent.api.app.bsky.feed.getLikes({ uri: postUri, limit: 100, cursor });
        if (response.success && response.data.likes && response.data.likes.length > 0) {
          likers = likers.concat(response.data.likes.map(like => like.actor.did));
          cursor = response.data.cursor;
          console.log(`[getLikers] Fetched a page of ${response.data.likes.length} likes. Total likers so far: ${likers.length}. Cursor: ${cursor}`);
        } else {
          if (!response.success) {
            console.warn(`[getLikers] API call to getLikes was not successful for ${postUri}. Response:`, response);
          } else if (!response.data.likes || response.data.likes.length === 0) {
            console.log(`[getLikers] No more likes found for ${postUri} on this page or empty likes array.`);
          }
          cursor = null; // Stop if no success or no likes data or empty likes array
        }
      } while (cursor);
      console.log(`[getLikers] Total likers found for ${postUri}: ${likers.length}`);
      return likers;
    } catch (error) {
      console.error(`[getLikers] Error fetching likes for URI ${postUri}:`, error);
      return []; // Return empty array on error
    }
  }
}

// Llama-specific implementation
class LlamaBot extends BaseBot {
  // NOTE FOR FUTURE DEVELOPMENT on popularity sorting:
  // When implementing features to sort posts by popularity (e.g., "most liked posts"),
  // prioritize using the `likeCount` property directly available on `app.bsky.feed.defs#postView` objects.
  // These objects are returned by feed-generating endpoints like `getAuthorFeed` and `getPostThread`.
  // This is more API-efficient than calling `app.bsky.feed.getLikes` for every post just to get its count.
  // `getLikes` should primarily be used if the actual list of likers is needed for a specific post.
  constructor(config, agent) {
    super(config, agent);
    this.readmeCache = {
      content: null,
      lastFetched: 0,
      ttl: 60 * 60 * 1000 // 1 hour in milliseconds
    };
    this.visualEnhancementCache = new Map(); // Cache for visual enhancement suggestions
    this.VISUAL_ENHANCEMENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.clarificationCache = new Map();
    this.CLARIFICATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  }

  async getVisualEnhancementSuggestion(userQueryText, botDraftText) {
    const cacheKey = `${userQueryText}|${botDraftText}`;
    const now = Date.now();

    if (this.visualEnhancementCache.has(cacheKey)) {
      const cachedEntry = this.visualEnhancementCache.get(cacheKey);
      if (now - cachedEntry.timestamp < this.VISUAL_ENHANCEMENT_CACHE_TTL) {
        console.log("[ResponseEnhancer] Using cached visual enhancement suggestion.");
        return cachedEntry.suggestion;
      } else {
        this.visualEnhancementCache.delete(cacheKey); // Expired
      }
    }

    const systemPrompt = `You are an AI Response Enhancer. Your goal is to decide if adding a visual element would make the bot's draft response significantly more engaging, clearer, or contextually appropriate, given the user's query.

Consider the following:
- User's Query: "${userQueryText}"
- Bot's Draft Text Response: "${botDraftText}"

Rules:
1. If the bot's draft text already explicitly states it will provide an image or visual (e.g., "I'll draw that for you!", "Here's an image:"), then no additional visual is needed. Output: {"action": "none"}
2. If the user's query is a direct command to generate an image (e.g., "draw a cat", "generate a picture of space") AND the bot's draft text is a simple acknowledgment (e.g., "Okay!", "Sure thing!"), this implies the main image generation flow will handle it. Output: {"action": "none"}
3. Only suggest a visual if it genuinely adds value and is highly relevant. Avoid overuse.
4. If a visual is appropriate:
    - If the context is lighthearted, emotional, or could be expressed well with a short animation, suggest a GIF. Output: {"action": "gif_search", "query": "<concise Giphy search term>"}
    - If the context requires a specific scene, object, or concept to be visualized, and a generated image would be best, suggest image generation. Output: {"action": "generate", "query": "<concise prompt for FLUX model>"}
    - If the context refers to a real-world entity, object, or scene that can be found via web image search, suggest that. Output: {"action": "image_search", "query": "<concise Google Image search term>"}
5. Keep search queries and generation prompts very concise (2-5 words typically).
6. If multiple visual types could fit, prefer in this order: gif_search (for common reactions/emotions), image_search (for real-world things), generate (for novel/creative concepts).
7. If unsure, or if the text response is sufficient, output: {"action": "none"}

Respond ONLY with a single JSON object based on these rules.

Examples:
User Query: "I'm so happy today!"
Bot's Draft Text Response: "That's wonderful to hear! Spreading the joy!"
Your JSON Output: {"action": "gif_search", "query": "happy celebration"}

User Query: "What did the first car look like?"
Bot's Draft Text Response: "The Benz Patent-Motorwagen, built in 1885, is widely regarded as the world's first production automobile."
Your JSON Output: {"action": "image_search", "query": "Benz Patent-Motorwagen 1885"}

User Query: "Can you imagine a futuristic city on Mars?"
Bot's Draft Text Response: "A futuristic city on Mars... towering biodomes, sleek transit tubes, and the reddish landscape stretching out under a terraformed sky. It sounds amazing!"
Your JSON Output: {"action": "generate", "query": "futuristic city on Mars biodomes"}

User Query: "Draw a dragon."
Bot's Draft Text Response: "Okay, I'll get right on that dragon drawing for you!"
Your JSON Output: {"action": "none"}

User Query: "What's 2+2?"
Bot's Draft Text Response: "2+2 equals 4!"
Your JSON Output: {"action": "none"}`;

    try {
      console.log(`[ResponseEnhancer] Calling Llama 3.2 Vision to get visual enhancement suggestion.`);
      const response = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-3.2-90b-vision-instruct',
          messages: [{ role: "system", content: systemPrompt }, {role: "user", content: `User Query: "${userQueryText}"\nBot's Draft Text Response: "${botDraftText}"\n\nYour JSON Output:`}],
          temperature: 0.3, // Lower temperature for more deterministic JSON output
          max_tokens: 100,
          stream: false
        }),
        customTimeout: 90000 // 90s, as it's a decision task
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ResponseEnhancer] API error (${response.status}): ${errorText}`);
        return { action: "none", error: "API error" };
      }

      const data = await response.json();
      if (data.choices && data.choices[0].message && data.choices[0].message.content) {
        let suggestionJson = data.choices[0].message.content.trim();
        // Extract JSON from potential markdown code block
        const match = suggestionJson.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (match && match[1]) {
          suggestionJson = match[1];
        }

        console.log(`[ResponseEnhancer] Raw suggestion JSON: ${suggestionJson}`);
        const suggestion = JSON.parse(suggestionJson);
        if (suggestion && suggestion.action) {
          this.visualEnhancementCache.set(cacheKey, { suggestion, timestamp: now });
          return suggestion;
        }
      }
      console.error("[ResponseEnhancer] Failed to parse suggestion or unexpected format.");
      return { action: "none", error: "Parsing error" };
    } catch (error) {
      console.error(`[ResponseEnhancer] Exception: ${error.message}`);
      return { action: "none", error: error.message };
    }
  }

  async _getReadmeContent() {
    const now = Date.now();
    if (this.readmeCache.content && (now - this.readmeCache.lastFetched < this.readmeCache.ttl)) {
      console.log("[ReadmeSelfHelp] Using cached README content.");
      return this.readmeCache.content;
    }

    try {
      console.log("[ReadmeSelfHelp] Fetching README.md from GitHub...");
      const readmeUrl = "https://raw.githubusercontent.com/UtopianFuturist/dearest-llama/main/README.md";
      // Using direct fetch as this is internal bot logic.
      const response = await fetch(readmeUrl);
      if (!response.ok) {
        console.error(`[ReadmeSelfHelp] Error fetching README: ${response.status} ${response.statusText}`);
        this.readmeCache.content = null; // Invalidate cache on error
        this.readmeCache.lastFetched = 0;
        return null;
      }
      const rawReadme = await response.text();
      this.readmeCache.content = rawReadme;
      this.readmeCache.lastFetched = now;
      console.log("[ReadmeSelfHelp] README fetched and cached successfully.");
      return rawReadme;
    } catch (error) {
      console.error("[ReadmeSelfHelp] Exception fetching README:", error);
      this.readmeCache.content = null;
      this.readmeCache.lastFetched = 0;
      return null;
    }
  }

  async generateStandalonePostFromContext(context, adminInstructions) {
    console.log('LlamaBot.generateStandalonePostFromContext called. Context (sample):', context ? JSON.stringify(context.slice(0,1)) : "null", 'Instructions:', adminInstructions);
    let nemotronResponseText; // <<<< ENSURE THIS IS THE ONLY DECLARATION IN THIS FUNCTION SCOPE
    try {
      const trimmedAdminInstructions = adminInstructions ? adminInstructions.trim() : '';
      const isContextMinimal = !context || context.length === 0 ||
                               (context.length === 1 && context[0] && typeof context[0].text === 'string' && context[0].text.startsWith('!post'));
      let userPrompt;

      if (trimmedAdminInstructions === "" && (!context || context.length === 0)) {
        console.warn('LlamaBot.generateStandalonePostFromContext: Both context and admin instructions are effectively empty. Cannot generate post content.');
        return null;
      } else if (isContextMinimal && trimmedAdminInstructions) {
        userPrompt = `The administrator has provided specific instructions to generate a new Bluesky post. Please create a post based directly on the following instructions. Ensure the post adheres to the bot's persona (as defined in the system prompt: "${this.config.TEXT_SYSTEM_PROMPT}") and is under 300 characters.\n\nAdmin Instructions: "${trimmedAdminInstructions}"\n\n(Do not attempt to summarize a prior conversation; generate directly from the instructions.)`;
        console.log('LlamaBot.generateStandalonePostFromContext: Using admin instructions-focused prompt due to minimal context.');
      } else {
        let conversationHistory = '';
        if (context && context.length > 0) {
          for (const msg of context) {
            conversationHistory += `${msg.author}: ${msg.text}\n`;
            if (msg.images && msg.images.length > 0) {
              msg.images.forEach(image => { if (image.alt) conversationHistory += `[Image description: ${image.alt}]\n`; });
            }
          }
        } else if (!trimmedAdminInstructions) {
            console.warn('LlamaBot.generateStandalonePostFromContext: Context is empty and no admin instructions to act on.');
            return null;
        }
        userPrompt = `Based on the following conversation:\n\n${conversationHistory}\n\nGenerate a new, standalone Bluesky post. This post should reflect the persona described as: "${this.config.TEXT_SYSTEM_PROMPT}". The post must be suitable for the bot's own feed, inspired by the conversation but NOT a direct reply to it. Keep the post concise and under 300 characters.`;
        if (trimmedAdminInstructions) {
          userPrompt += `\n\nImportant specific instructions from the admin for this post: "${trimmedAdminInstructions}". Please ensure the generated post carefully follows these instructions while also drawing from the conversation themes where appropriate.`;
        }
        console.log('LlamaBot.generateStandalonePostFromContext: Using context-focused prompt.');
      }

      console.log(`NIM CALL START: generateStandalonePostFromContext for model nvidia/llama-3.3-nemotron-super-49b-v1 with prompt length: ${userPrompt.length}`);
      const response = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [ { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}` }, { role: "user", content: userPrompt } ],
          temperature: 0.90, max_tokens: 100, stream: false
        }),
        customTimeout: 120000 // 120s timeout
      });
      console.log(`NIM CALL END: generateStandalonePostFromContext for model nvidia/llama-3.3-nemotron-super-49b-v1 - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) for generateStandalonePostFromContext - Text: ${errorText}`);
        return null;
      }
      const data = await response.json();
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
        console.error('Unexpected response format from Nvidia NIM for generateStandalonePostFromContext:', JSON.stringify(data));
        return null;
      }
      // The problematic line was here. Ensure it's an assignment.
      nemotronResponseText = data.choices[0].message.content.trim();
      console.log(`[LlamaBot.generateStandalonePostFromContext] Initial response from nvidia/llama-3.3-nemotron-super-49b-v1: "${nemotronResponseText}"`);

      // Now, filter this response using Gemma
      const filterModelId = 'meta/llama-3.2-90b-vision-instruct'; // Changed to Gemma
      const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
      const filterSystemPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (`**`) used for emphasis, as they do not render correctly. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it.";

      try {
        console.log(`NIM CALL START: filterResponse (using ${filterModelId}) in generateStandalonePostFromContext`);
        const filterResponse = await fetchWithRetries(endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: filterModelId,
            messages: [
              { role: "system", content: filterSystemPrompt },
              { role: "user", content: nemotronResponseText } // textToFilter is nemotronResponseText
            ],
            temperature: 0.1, max_tokens: 100, stream: false
          }),
          customTimeout: 90000 // 90s timeout
        });
        console.log(`NIM CALL END: filterResponse (using ${filterModelId}) in generateStandalonePostFromContext - Status: ${filterResponse.status}`);
        if (!filterResponse.ok) {
          const errorText = await filterResponse.text();
          console.error(`NIM CALL ERROR: API error ${filterResponse.status} for filter model ${filterModelId} in generateStandalonePostFromContext: ${errorText}. Returning Nemotron's direct response (basic formatted).`);
          return this.basicFormatFallback(nemotronResponseText);
        }
        const filterData = await filterResponse.json();
        if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message && filterData.choices[0].message.content) {
          const finalResponse = filterData.choices[0].message.content.trim();
          console.log(`[LlamaBot.generateStandalonePostFromContext] Filtered response from ${filterModelId}: "${finalResponse}"`);
          return finalResponse;
        }
        console.error(`NIM CALL ERROR: Unexpected response format from filter model ${filterModelId} in generateStandalonePostFromContext: ${JSON.stringify(filterData)}. Returning Nemotron's direct response (basic formatted).`);
        return this.basicFormatFallback(nemotronResponseText);
      } catch (error) {
        console.error(`NIM CALL EXCEPTION: Error in filtering step of generateStandalonePostFromContext with model ${filterModelId}: ${error.message}. Returning Nemotron's direct response (basic formatted).`);
        return this.basicFormatFallback(nemotronResponseText);
      }
    } catch (error) { // This outer catch is for the Nemotron call itself
      console.error('Error in LlamaBot.generateStandalonePostFromContext (Nemotron call):', error);
      return null;
    }
  }

  basicFormatFallback(text, maxLength = 290) {
    let formattedText = text;
    if (!formattedText) return "";

    // Remove common AI prefixes
    const prefixes = ["Bot:", "Nemotron says:", "Assistant:", "User:", "Llama:", "Scout:"];
    for (const prefix of prefixes) {
        if (formattedText.toLowerCase().startsWith(prefix.toLowerCase())) {
            formattedText = formattedText.substring(prefix.length).trim();
            break;
        }
    }

    // Remove surrounding quotes if the whole thing is a quote
    if ((formattedText.startsWith('"') && formattedText.endsWith('"')) ||
        (formattedText.startsWith("'") && formattedText.endsWith("'"))) {
        formattedText = formattedText.substring(1, formattedText.length - 1);
    }

    // Truncate if necessary (do this *before* final asterisk removal to avoid cutting in middle of a sequence)
    if (formattedText.length > maxLength) {
        let truncated = formattedText.substring(0, maxLength - 3); // Reserve space for "..."
        const lastSpace = truncated.lastIndexOf(' ');
        // Only truncate at space if it's reasonably far in and makes sense
        if (lastSpace > maxLength / 2 && lastSpace > 0) {
            truncated = truncated.substring(0, lastSpace);
        }
        formattedText = truncated + "...";
    }

    // Remove double asterisks *after* potential truncation and other cleaning
    formattedText = formattedText.replace(/\*\*/g, "");

    return formattedText.trim();
  }

  async extractTextFromImageWithScout(imageBase64) { // Renaming to extractTextFromImage
    const modelId = 'meta/llama-3.2-90b-vision-instruct'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      console.error('[OCR] extractTextFromImage: imageBase64 data is invalid or empty.');
      return null;
    }
    console.log(`[OCR] Image base64 length: ${imageBase64.length}`);
    if (imageBase64.length > 2 * 1024 * 1024 * (4/3)) {
        if (imageBase64.length > 4 * 1024 * 1024) {
            console.error(`[OCR] Image base64 data is excessively large (${imageBase64.length} chars / ~3MB+). Aborting OCR.`);
            return null;
        }
        console.warn(`[OCR] Image base64 data is very large (${imageBase64.length} chars), potentially problematic.`);
    }

    let mimeType = 'image/jpeg';
    if (imageBase64.startsWith('iVBORw0KGgo=')) mimeType = 'image/png';
    else if (imageBase64.startsWith('/9j/')) mimeType = 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;

    const systemPromptContent = "You are an Optical Character Recognition (OCR) AI. Your task is to extract all visible text from the provided image. Output ONLY the extracted text. If no text is visible, output an empty string. Do not add any commentary or explanation. Be as accurate as possible.";
    const userPromptText = "Extract all text from this image.";
    // Caveat: Gemma's multimodal capabilities for image_url via NIM need confirmation.

    try {
      console.log(`[OCR] NIM CALL START: extractTextFromImage (using ${modelId})`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPromptContent },
            { role: "user", content: [ { type: "text", text: userPromptText }, { type: "image_url", image_url: { url: dataUrl } } ] }
          ],
          temperature: 0.1, max_tokens: 1024, stream: false
        }),
        customTimeout: 120000 // 120s
      });
      console.log(`[OCR] NIM CALL END: extractTextFromImage (using ${modelId}) - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[OCR] NIM CALL ERROR: API error ${response.status} for model ${modelId} in extractTextFromImage: ${errorText}`);
        return null;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const extractedText = data.choices[0].message.content.trim();
        console.log(`[OCR] NIM CALL RESPONSE: extractTextFromImage (model ${modelId}) - Extracted Text (first 100 chars): "${extractedText.substring(0,100)}"`);
        return extractedText;
      }
      console.error(`[OCR] NIM CALL ERROR: Unexpected response format from ${modelId} in extractTextFromImage: ${JSON.stringify(data)}`);
      return null;
    } catch (error) {
      console.error(`[OCR] NIM CALL EXCEPTION: Error in extractTextFromImage with model ${modelId}: ${error.message}`);
      return null;
    }
  }

  async generateResponse(post, context) {
    // At the very start of LlamaBot.generateResponse, before any other logic
    console.log(`[EmbedCheck] Post URI: ${post.uri} - Full Embed Object:`, JSON.stringify(post.record?.embed, null, 2));

    const userQueryText = post.record.text || ""; // Ensure userQueryText is defined early

    // New: Check for clarification before any other processing
    // For context, we could pass a summary of `context`, but for now, focusing on userQueryText
    const clarificationSuggestion = await this.getClarificationSuggestion(userQueryText, null /* Pass context summary here if developed */);
    if (clarificationSuggestion.needs_clarification && clarificationSuggestion.clarification_question) {
      console.log(`[ClarificationHelper] Query needs clarification. Asking: "${clarificationSuggestion.clarification_question}"`);
      await this.postReply(post, clarificationSuggestion.clarification_question);
      return null; // Stop further processing, wait for user's response
    }

    if (post.record?.embed) {
      console.log(`[EmbedCheck] Embed type: ${post.record.embed.$type}`);
      if (post.record.embed.images) {
        console.log(`[EmbedCheck] Embed images count: ${post.record.embed.images.length}`);
        if (post.record.embed.images.length > 0) {
          console.log(`[EmbedCheck] First image object:`, JSON.stringify(post.record.embed.images[0], null, 2));
        }
      } else {
        console.log(`[EmbedCheck] post.record.embed.images is undefined or null.`);
      }
    } else {
      console.log(`[EmbedCheck] post.record.embed is undefined or null.`);
    }

    this._cleanupExpiredDetailedAnalyses(); // Cleanup cache at the start of processing a new response

    // Check if this interaction is a follow-up to a summary invitation
    if (post.record?.reply && post.record.reply.parent?.uri && post.record.reply.parent?.author?.did === this.agent.did) {
      const summaryPostUriUserIsReplyingTo = post.record.reply.parent.uri;
      const originalUserQueryUri = post.record.reply.root?.uri || post.uri; // The root of the thread, usually the user's first message.

      // Iterate over pending analyses to find if the parentPostUri matches a stored summaryPostUri
      let storedDataForFollowUp = null;
      let keyForDeletion = null;

      for (const [key, value] of this.pendingDetailedAnalyses.entries()) {
        if (value.summaryPostUri === summaryPostUriUserIsReplyingTo) {
          storedDataForFollowUp = value;
          keyForDeletion = key; // This 'key' is the URI of the user's original post that triggered the summary
          break;
        }
      }

      if (storedDataForFollowUp) {
        console.log(`[FollowUp] Detected reply to bot's summary post ${summaryPostUriUserIsReplyingTo}. Original trigger: ${keyForDeletion}`);
        const wantsDetails = await this.isRequestingDetails(post.record.text);
        if (wantsDetails) {
          if (storedDataForFollowUp.points && storedDataForFollowUp.points.length > 0) {
            console.log(`[FollowUp] User requested details for original post ${keyForDeletion}. Posting ${storedDataForFollowUp.points.length} points.`);

            // Removed currentDetailReplyTarget initialization as it was unused.

            const detailImageBase64 = storedDataForFollowUp.imageBase64;
            const detailAltText = storedDataForFollowUp.altText;

            // The 'post' object here is the user's message like "yes, tell me more".
            // We need to reply to the bot's summary message (parent),
            // which is storedDataForFollowUp.summaryPostUri and summaryPostCid.
            // The root of the thread is storedDataForFollowUp.replyToRootUri.

            let replyTargetForThisSequence = {
                root: { uri: storedDataForFollowUp.replyToRootUri, cid: post.record?.reply?.root?.cid }, // Use original root's CID if available
                parent: { uri: storedDataForFollowUp.summaryPostUri, cid: storedDataForFollowUp.summaryPostCid } // Reply to the bot's summary post using its URI and CID
            };

            // The `post` object that `this.postReply` needs should be a mock or minimal representation
            // of the post we are replying to, for constructing the replyRef.
            // For the first detailed point, it's the summary post.
            // This is already captured in replyTargetForThisSequence.parent.

            for (let i = 0; i < storedDataForFollowUp.points.length; i++) {
              const pointText = storedDataForFollowUp.points[i]; // Already cleaned
              const isLastConceptualPoint = i === storedDataForFollowUp.points.length - 1;

              console.log(`[FollowUp] Preparing to post conceptual detail point ${i+1}/${storedDataForFollowUp.points.length}`);

              // Each `pointText` will be posted. If it's long, `this.postReply` will split it.
              // The image is only attached to the very last segment of the very last conceptual point.
              const imageToSendWithThisPoint = isLastConceptualPoint ? detailImageBase64 : null;
              const altTextForThisPoint = isLastConceptualPoint ? detailAltText : "Generated image";

              // We need to pass a 'post' object to this.postReply that represents the post we are replying to.
              // For the first detailed point, it's parentPostForReply (the summary).
              // For subsequent points, it's the last part of the previous point.
              const currentParentPostForReply = {
                uri: replyTargetForThisSequence.parent.uri,
                cid: replyTargetForThisSequence.parent.cid, // May be null if not easily available
                author: { did: this.agent.did }, // Assuming replying to bot's own chain
                record: { reply: { root: replyTargetForThisSequence.root }} // Ensure root is threaded correctly
              };

              const postedPartsUris = await this.postReply(
                currentParentPostForReply, // The post this point is replying to
                pointText,
                imageToSendWithThisPoint,
                altTextForThisPoint
              );

              if (postedPartsUris && postedPartsUris.uris.length > 0 && postedPartsUris.lastCid) {
                // Update replyTargetForThisSequence for the *next* conceptual point
                // It should reply to the *last part* of the current conceptual point.
                replyTargetForThisSequence.parent = {
                    uri: postedPartsUris.uris[postedPartsUris.uris.length - 1],
                    cid: postedPartsUris.lastCid // Use the CID of the last posted part
                };
                console.log(`[FollowUp] Conceptual point ${i+1} posted. Next reply parent URI: ${replyTargetForThisSequence.parent.uri}, CID: ${replyTargetForThisSequence.parent.cid}`);
              } else {
                console.error(`[FollowUp] Failed to post conceptual detail point ${i+1} or missing CID. Aborting further details.`);
                break;
              }

              if (storedDataForFollowUp.points.length > 1 && !isLastConceptualPoint) {
                 await utils.sleep(1500); // Slightly longer delay between conceptual points
              }
            }
            this.pendingDetailedAnalyses.delete(keyForDeletion);
            console.log(`[FollowUp] Cleared pending details for ${keyForDeletion}.`);
            return null;
          }
        } else {
            console.log(`[FollowUp] User reply to summary for ${keyForDeletion} was not a clear YES for details. Text: "${post.record.text}". Treating as new query.`);
        }
      }
    }

    // If not a follow-up or follow-up not actioned, proceed with normal response generation
    try { // START OF MAIN TRY BLOCK
      console.log(`[LlamaBot.generateResponse] Entering try block for post URI: ${post.uri}, Text: "${post.record.text ? post.record.text.substring(0, 50) + '...' : 'N/A'}"`);
      const userQueryText = post.record.text || ""; // The current user's message text, ensure it's a string

      // Keywords for image-based article search
      const imageArticleSearchKeywords = [
        'is this true', 'find this article', 'verify this', 'source for this',
        'article for this', 'what is this from', 'screenshot', 'image above',
        'this image', 'this picture', 'this photo', 'the image', 'the picture', 'the photo',
        'the screenshot'
      ];
      const lowerUserQueryText = userQueryText.toLowerCase();
      // More robust check: look for article/truth query + image reference
      const hasTruthQuery = imageArticleSearchKeywords.some(kw => ['true', 'article', 'verify', 'source', 'what is this from'].includes(kw) && lowerUserQueryText.includes(kw));
      const hasImageReference = imageArticleSearchKeywords.some(kw => ['screenshot', 'image', 'picture', 'photo'].includes(kw) && lowerUserQueryText.includes(kw));

      console.log(`[ImageCheck] For query "${lowerUserQueryText.substring(0,70)}...": hasTruthQuery=${hasTruthQuery}, hasImageReference=${hasImageReference}`);
      let isImageArticleQuery = false;
      if (lowerUserQueryText.includes('is this true') ||
          lowerUserQueryText.includes('find this article') ||
          lowerUserQueryText.includes('verify this') ||
          lowerUserQueryText.includes('source for this') ||
          lowerUserQueryText.includes('article for this') ||
          lowerUserQueryText.includes('what is this from')) {
        isImageArticleQuery = true;
      } else if (hasTruthQuery && hasImageReference) {
        // Catches phrases like "Is the claim in this screenshot true?"
        // or "Can you find the article for the image above?"
        // This is a basic combination, could be more NLP-driven if needed
        isImageArticleQuery = true;
      }
      // Ensure the final state of isImageArticleQuery is logged after all conditions
      console.log(`[ImageCheck] Final isImageArticleQuery state: ${isImageArticleQuery}`);

      let imageToProcess = null;
      let sourcePostForImage = post; // Default to current post

      if (post.record?.embed && (post.record.embed.$type === 'app.bsky.embed.images' || post.record.embed.$type === 'app.bsky.embed.images#view')) {
        if (post.record.embed.images && post.record.embed.images.length > 0) {
          imageToProcess = post.record.embed.images[0];
          console.log(`[ImageArticleSearch] Image found directly in current post ${post.uri}`);
        }
      }

      // If no image in current post AND query implies looking for one (e.g. "above screenshot")
      // AND there's a reply context indicating a parent post
      if (!imageToProcess && isImageArticleQuery && post.record?.reply?.parent && context && context.length > 1) {
        // The `context` is built by getReplyContext. It's an array of {author, text, images}.
        // `images` in context items are {alt, url}. `url` here is `fullsize` or `thumb`.
        // The last item in `context` is the current post. The one before it is the parent.
        const parentContextPost = context[context.length - 2];
        if (parentContextPost && parentContextPost.images && parentContextPost.images.length > 0) {
          const parentImage = parentContextPost.images[0]; // Take first image from parent
          if (parentImage.url) { // parentImage.url should be the fullsize or thumb from getReplyContext
            imageToProcess = { fullsize: parentImage.url, alt: parentImage.alt || "" }; // Construct an object similar to what imageEmbed expects
            // We need the original parent post's URI for context if we reply about it.
            // `getReplyContext` currently doesn't return the full parent post object, just parts.
            // For now, we'll use the current `post` for replies, but acknowledge the image source.
            console.log(`[ImageArticleSearch] Image not in current post. Found image in parent post (via context) to process: ${parentImage.url}`);
            // We don't have the original parent post's URI easily here to change `sourcePostForImage`
            // This might be a limitation if we need to reply directly to the parent image post.
            // For now, all replies go to the current `post` that triggered the bot.
          }
        }
      }

      // In LlamaBot.generateResponse, before the image processing block:
      console.log(`[ImageCheck] Current post URI: ${post.uri}, Text: "${userQueryText.substring(0,100)}"`);
      console.log(`[ImageCheck] isImageArticleQuery: ${isImageArticleQuery}`);
      if (post.record?.embed?.images?.length > 0) {
        console.log(`[ImageCheck] Current post has ${post.record.embed.images.length} image(s). Fullsize of first: ${post.record.embed.images[0]?.fullsize}`);
      } else {
        console.log(`[ImageCheck] Current post has no direct image embeds.`);
      }

      if (!imageToProcess && isImageArticleQuery && post.record?.reply?.parent && context && context.length > 1) {
        const parentContextPost = context[context.length - 2]; // Direct parent from context
        console.log(`[ImageCheck] Attempting to find image in parent post. Parent context text (first 50): "${parentContextPost?.text?.substring(0,50)}..."`);
        if (parentContextPost && parentContextPost.images && parentContextPost.images.length > 0) {
          const parentImage = parentContextPost.images[0];
          console.log(`[ImageCheck] Parent context has image. URL: ${parentImage?.url}, Alt: ${parentImage?.alt}`);
          if (parentImage?.url) { // Check if URL exists
            imageToProcess = { fullsize: parentImage.url, alt: parentImage.alt || "" };
            console.log(`[ImageCheck] Set imageToProcess from parent context's image URL: ${parentImage.url}`);
          } else {
            console.log(`[ImageCheck] Parent context image found, but URL is missing.`);
          }
        } else {
          console.log(`[ImageCheck] Parent context post or its images not found or empty.`);
        }
      } else if (!imageToProcess && isImageArticleQuery) {
        console.log(`[ImageCheck] Image query, no image in current post, and no suitable parent context to check (or already checked).`);
      } else if (imageToProcess) {
        console.log(`[ImageCheck] Image to process was already identified from current post.`);
      } else {
        console.log(`[ImageCheck] No image to process based on current logic paths.`);
      }

      // ===== Image-based Article Search Flow =====
      // Check direct parent first
      if (!imageToProcess && isImageArticleQuery && post.record?.reply?.parent && context && context.length > 1) {
        const parentContextPost = context[context.length - 2]; // Direct parent from context
        console.log(`[ImageCheck] (Parent Check) Attempting to find image in parent post. Parent context text (first 50): "${parentContextPost?.text?.substring(0,50)}..."`);
        if (parentContextPost && parentContextPost.images && parentContextPost.images.length > 0) {
          const parentImage = parentContextPost.images[0];
          console.log(`[ImageCheck] (Parent Check) Parent context has image. URL: ${parentImage?.url}, Alt: ${parentImage?.alt}`);
          if (parentImage?.url) {
            imageToProcess = { fullsize: parentImage.url, alt: parentImage.alt || "" };
            console.log(`[ImageCheck] (Parent Check) Set imageToProcess from parent context's image URL: ${parentImage.url}`);
          } else {
            console.log(`[ImageCheck] (Parent Check) Parent context image found, but URL is missing.`);
          }
        } else {
          console.log(`[ImageCheck] (Parent Check) Parent context post or its images not found or empty.`);
        }
      }

      // If still no image, and it's an image query, check grandparent if context allows
      if (!imageToProcess && isImageArticleQuery && post.record?.reply?.parent && context && context.length > 2) {
        // Check if the parent itself was a reply to find the grandparent
        const parentPostRecord = context[context.length - 2]; // This is the representation of the parent post in our context array
        // We need to ensure this parentPostRecord itself implies it's a reply to the grandparent we want to check.
        // The structure of `context` is [oldest, ..., grandparent, parent, current].
        // So, context[context.length - 3] is the grandparent.
        const grandParentContextPost = context[context.length - 3];
        console.log(`[ImageCheck] (Grandparent Check) Attempting to find image in grandparent post. Grandparent context text (first 50): "${grandParentContextPost?.text?.substring(0,50)}..."`);
        if (grandParentContextPost && grandParentContextPost.images && grandParentContextPost.images.length > 0) {
          const grandParentImage = grandParentContextPost.images[0];
          console.log(`[ImageCheck] (Grandparent Check) Grandparent context has image. URL: ${grandParentImage?.url}, Alt: ${grandParentImage?.alt}`);
          if (grandParentImage?.url) {
            imageToProcess = { fullsize: grandParentImage.url, alt: grandParentImage.alt || "" };
            console.log(`[ImageCheck] (Grandparent Check) Set imageToProcess from grandparent context's image URL: ${grandParentImage.url}`);
          } else {
            console.log(`[ImageCheck] (Grandparent Check) Grandparent context image found, but URL is missing.`);
          }
        } else {
          console.log(`[ImageCheck] (Grandparent Check) Grandparent context post or its images not found or empty.`);
        }
      }


      if (imageToProcess && imageToProcess.fullsize && isImageArticleQuery) {
        console.log(`[ImageArticleSearch] ENTERING FLOW. Image URL: ${imageToProcess.fullsize} for post ${post.uri} with query "${userQueryText}".`);

        // It's better to reply to the post that *asked* the question, which is `post`.
        // The "I see an image..." message should also be a reply to `post`.
        await this.postReply(post, "I see you're asking about an article related to an image. Let me try to read the image and search for it...");


        const imageBase64 = await utils.imageUrlToBase64(imageToProcess.fullsize);
        if (!imageBase64) {
          console.error(`[ImageArticleSearch] Failed to download image ${imageToProcess.fullsize} for OCR.`);
          await this.postReply(post, "I couldn't download the image to analyze it. Sorry about that!");
          return null;
        }

        const extractedText = await this.extractTextFromImageWithScout(imageBase64);
        if (!extractedText || extractedText.trim().length < 5) { // Require some minimal text
          console.log(`[ImageArticleSearch] OCR extracted no significant text from image in post ${post.uri}. Extracted: "${extractedText}"`);
          await this.postReply(post, "I tried to read the text from the image, but I couldn't find much there. If there's a headline, maybe try typing it out for me?");
          return null;
        }

        console.log(`[ImageArticleSearch] OCR successful. Extracted text (first 100): "${extractedText.substring(0,100)}". Proceeding to web search.`);

        // Now, use this extractedText for a web search (similar to 'web_search' intent type 'webpage')
        const searchResults = await this.performGoogleWebSearch(extractedText, null, 'webpage');
        let nemotronWebServicePrompt = "";
        const webSearchSystemPrompt = `You are an AI assistant. The user posted an image (likely a news headline screenshot) and asked a question like "${userQueryText}". Text was extracted from the image using OCR: "${extractedText.substring(0, 200)}...". You have performed a web search based on this extracted text.
Use the provided search results (title, URL, snippet) to formulate a concise and helpful answer to the user's original question about the image content.
Synthesize the information from the results. If appropriate, you can cite the source URL(s) by including them in your answer (e.g., "According to [URL], ...").
If the search results confirm the headline, state that. If they debunk it, state that. If they are inconclusive, say so.
Do not make up information not present in the search results. Keep the response suitable for a social media post.`;

        if (searchResults && searchResults.length > 0) {
          const resultsText = searchResults.map((res, idx) =>
            `Result ${idx + 1}:\nTitle: ${res.title}\nURL: ${res.url}\nSnippet: ${res.snippet}`
          ).join("\n\n---\n");
          nemotronWebServicePrompt = `User's original question about image: "${userQueryText}"\nOCR'd text from image: "${extractedText.substring(0, 200)}..."\n\nWeb Search Results based on OCR'd text:\n${resultsText}\n\nBased on these results, please answer the user's original question about the image.`;
        } else {
          nemotronWebServicePrompt = `User's original question about image: "${userQueryText}"\nOCR'd text from image: "${extractedText.substring(0, 200)}..."\n\nNo clear results were found from the web search using the OCR'd text. Please inform the user politely that you couldn't find information based on the image text and perhaps suggest the text might be too generic or to try other keywords if they know them.`;
        }

        console.log(`[ImageArticleSearch] Nemotron prompt for web search synthesis: "${nemotronWebServicePrompt.substring(0, 300)}..."`);
        const nimWebResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
            messages: [
              { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${webSearchSystemPrompt}` },
              { role: "user", content: nemotronWebServicePrompt }
            ],
            temperature: 0.6, max_tokens: 250, stream: false
          }),
          customTimeout: 120000 // 120s
        });

        if (nimWebResponse.ok) {
          const nimWebData = await nimWebResponse.json();
          if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
            const synthesizedResponse = nimWebData.choices[0].message.content.trim();
            // Filter this response
            const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
              body: JSON.stringify({
                  model: 'meta/llama-3.2-90b-vision-instruct',
                messages: [
                  { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                  { role: "user", content: synthesizedResponse }
                ],
                temperature: 0.1, max_tokens: 100, stream: false
              }),
                customTimeout: 90000 // 90s
            });
            if (filterResponse.ok) {
              const filterData = await filterResponse.json();
              if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                await this.postReply(post, filterData.choices[0].message.content.trim());
              } else {
                await this.postReply(post, synthesizedResponse); // Fallback to unfiltered
              }
            } else {
              await this.postReply(post, synthesizedResponse); // Fallback to unfiltered
            }
          } else {
            await this.postReply(post, "I searched the web based on the image text but had a little trouble putting together an answer. You could try rephrasing your question or typing out the headline if you see one!");
          }
        } else {
          const errorText = await nimWebResponse.text();
          console.error(`[ImageArticleSearch] Nvidia NIM API error for web synthesis (${nimWebResponse.status}) - Text: ${errorText}`);
          await this.postReply(post, "I encountered an issue while trying to process information from the web based on the image. Please try again later.");
        }
        return null; // End of image-based article search flow
      }
      // ===== Image-based Article Search Flow (Revised: OCR is primary if image found) =====
      // This entire block needs to be before the like check, or the like check needs to be careful not to run if this block runs and returns null.
      // For now, let's assume this block runs and might return null, stopping further processing.

      // New Like Check Logic - Placed before major processing branches like ImageArticleFlow or SearchHistoryIntent
      // but after clarification check.
      let userLikedBotsPreviousReply = false;
      // botsPreviousReplyUri is not strictly needed outside this block for now
      // let botsPreviousReplyUri = null;

      if (context && context.length >= 2) {
        const currentUserPost = context[context.length - 1]; // This is 'post'
        const potentialBotsReply = context[context.length - 2];

        if (potentialBotsReply.author === this.config.BLUESKY_IDENTIFIER &&
            post.record?.reply?.parent?.uri === potentialBotsReply.uri &&
            currentUserPost.author !== this.config.BLUESKY_IDENTIFIER && // Current post is from user
            post.author.did) { // Ensure we have the current user's DID

          // botsPreviousReplyUri = potentialBotsReply.uri; // Store if needed later
          console.log(`[LikeCheck] User ${post.author.handle} (DID: ${post.author.did}) replied to bot's message ${potentialBotsReply.uri}. Checking if user liked it.`);
          try {
            const likers = await this.getLikers(potentialBotsReply.uri);
            if (likers.includes(post.author.did)) {
              userLikedBotsPreviousReply = true;
              console.log(`[LikeCheck] User ${post.author.handle} liked the bot's previous message ${potentialBotsReply.uri}.`);
            } else {
              console.log(`[LikeCheck] User ${post.author.handle} did NOT like the bot's previous message ${potentialBotsReply.uri}. Likers: ${likers.join(', ')}`);
            }
          } catch (e) {
            console.error(`[LikeCheck] Error calling getLikers for ${potentialBotsReply.uri}:`, e);
          }
        }
      }
      // End of New Like Check Logic


      if (isImageArticleQuery) {
        console.log(`[ImageArticleFlow] 'isImageArticleQuery' is true. Attempting to find and OCR image.`);
        let textForSearch = null;
        let ocrAttempted = false;
        let imageUriForContext = null; // For logging/prompting if OCR fails but image was found
        let sourcePostTextForContext = null; // Text of the post where image was found, for context

        // imageToProcess should have { fullsize, alt, sourcePostUri } if an image was found by prior logic
        if (imageToProcess && imageToProcess.fullsize) {
          imageUriForContext = imageToProcess.fullsize;
          const imageSourcePostInContext = context.find(p => p.uri === imageToProcess.sourcePostUri);
          if (imageSourcePostInContext) {
            sourcePostTextForContext = imageSourcePostInContext.text;
          }

          await this.postReply(post, "I see an image you might be asking about. Let me try to read its content and search for an article...");
          ocrAttempted = true;
          const imageBase64 = await utils.imageUrlToBase64(imageToProcess.fullsize);

          if (imageBase64) {
            textForSearch = await this.extractTextFromImageWithScout(imageBase64);
            if (!textForSearch || textForSearch.trim().length < 5) {
              console.log(`[ImageArticleFlow] OCR extracted no significant text from ${imageToProcess.fullsize}.`);
              await this.postReply(post, "I found an image but couldn't read enough text from it to search. If there's a headline, could you type it out for me?");
              return null; // Stop this flow
            }
            console.log(`[ImageArticleFlow] OCR successful for ${imageToProcess.fullsize}. Extracted text: "${textForSearch.substring(0,100)}"`);
          } else {
            console.error(`[ImageArticleFlow] Failed to download image ${imageToProcess.fullsize} for OCR.`);
            await this.postReply(post, "I found an image but couldn't download it to analyze. Sorry about that!");
            return null; // Stop this flow
          }
        } else {
          // No image context found by imageToProcess logic, but isImageArticleQuery is true.
          // This implies the user might have typed the headline or is referring to an image the bot can't see.
          console.log(`[ImageArticleFlow] 'isImageArticleQuery' is true, but no specific image was identified in context. Using user's query text for search.`);
          textForSearch = userQueryText.replace(`@${this.config.BLUESKY_IDENTIFIER}`, "").trim();
          if (!textForSearch.trim()) {
             await this.postReply(post, "I understand you're asking about an article, but I need some text to search for (either from an image or your message).");
             return null;
          }
        }

        // If we have text (either from OCR or user's query directly because no image was processed for OCR)
        if (textForSearch && textForSearch.trim()) {
          console.log(`[ImageArticleFlow] Proceeding to web search with text: "${textForSearch.substring(0,100)}"`);

          const searchResults = await this.performGoogleWebSearch(textForSearch, null, 'webpage');
          let nemotronWebServicePrompt = "";
          let systemPromptContext = `The user asked a question like "${userQueryText}"`;
          if (ocrAttempted && imageUriForContext) {
            systemPromptContext += ` related to an image (source: ${imageUriForContext}). Text was extracted from this image via OCR: "${textForSearch.substring(0, 200)}...".`;
            if (sourcePostTextForContext) {
                systemPromptContext += ` The post containing the image had text: "${sourcePostTextForContext.substring(0,100)}..."`;
            }
          } else {
            systemPromptContext += `. The key information to verify or find, based on their query, is: "${textForSearch.substring(0, 200)}...".`;
          }
          systemPromptContext += "\nYou have performed a web search based on this key information. Use the provided search results (title, URL, snippet) to formulate a concise and helpful answer. Synthesize the information. If appropriate, cite source URL(s) (e.g., \"According to [URL], ...\"). If results confirm the information, state that. If they debunk it, state that. If inconclusive, say so. Keep the response suitable for a social media post.";

          const webSearchSystemPrompt = `You are an AI assistant. ${systemPromptContext}`;

          if (searchResults && searchResults.length > 0) {
            const resultsText = searchResults.map((res, idx) => `Result ${idx + 1}:\nTitle: ${res.title}\nURL: ${res.url}\nSnippet: ${res.snippet}`).join("\n\n---\n");
            nemotronWebServicePrompt = `User's original question: "${userQueryText}"\nEffective search query used: "${textForSearch.substring(0,200)}..."\n\nWeb Search Results:\n${resultsText}\n\nBased on these results, please answer the user's original question.`;
          } else {
            nemotronWebServicePrompt = `User's original question: "${userQueryText}"\nEffective search query used: "${textForSearch.substring(0,200)}..."\n\nNo clear results were found from the web search. Please inform the user politely that you couldn't find specific information and suggest they rephrase or try a search engine directly.`;
          }

          console.log(`[ImageArticleFlow] Nemotron prompt for web search synthesis: "${nemotronWebServicePrompt.substring(0, 300)}..."`);
          const nimWebResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
              messages: [
                { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${webSearchSystemPrompt}` },
                { role: "user", content: nemotronWebServicePrompt }
              ],
              temperature: 0.6, max_tokens: 250, stream: false
            }),
          customTimeout: 120000 // 120s
          });

          if (nimWebResponse.ok) {
            const nimWebData = await nimWebResponse.json();
            if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
              const synthesizedResponse = nimWebData.choices[0].message.content.trim();
              const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-3.2-90b-vision-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: synthesizedResponse }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                }),
                customTimeout: 90000 // 90s
              });
              if (filterResponse.ok) {
                const filterData = await filterResponse.json();
                if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                  await this.postReply(post, filterData.choices[0].message.content.trim());
                } else {
                  await this.postReply(post, this.basicFormatFallback(synthesizedResponse));
                }
              } else {
                await this.postReply(post, this.basicFormatFallback(synthesizedResponse));
              }
            } else {
              await this.postReply(post, "I searched the web based on the information but had trouble formulating an answer. You could try rephrasing!");
            }
          } else {
            const errorText = await nimWebResponse.text();
            console.error(`[ImageArticleLogic] Nvidia NIM API error for web synthesis (${nimWebResponse.status}) - Text: ${errorText}`);
            await this.postReply(post, "I encountered an issue while trying to process information from the web. Please try again later.");
          }
        } else {
          console.log(`[ImageArticleLogic] No textForSearch could be determined after image/text evaluation. Replying to user.`);
          await this.postReply(post, "I'm having trouble understanding what to search for, even after looking at the context. Could you please provide the headline or key details, or make sure the image is clear?");
        }
        return null; // End of image-based article search flow
      }
      // ===== End of Image-based Article Search Flow =====


      // 1. Check for search history intent first (original logic continues if not image article search)
      const searchIntent = await this.getSearchHistoryIntent(userQueryText);

      if (searchIntent.intent === "read_readme_for_self_help" && searchIntent.user_query_about_bot) {
        console.log(`[ReadmeSelfHelp] Detected intent to read README for query: "${searchIntent.user_query_about_bot}"`);
        const readmeContent = await this._getReadmeContent();

        if (readmeContent) {
          const readmeSystemPrompt = `You are a helpful assistant. The user is asking about your (the bot's) capabilities or how to use you. Use the following content from your README.md file to answer their question. Provide a concise and helpful response. If the README doesn't directly answer the specific question, explain what you can based on the README or suggest how the user might find the information.`;
          const readmeUserPrompt = `README.md Content:\n\`\`\`\n${readmeContent}\n\`\`\`\n\nUser's question: "${searchIntent.user_query_about_bot}"\n\nPlease answer the user's question based on the README.`;

          console.log(`[ReadmeSelfHelp] Calling Nemotron for README-based answer.`);
          const nimReadmeResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
              messages: [
                { role: "system", content: readmeSystemPrompt },
                { role: "user", content: readmeUserPrompt }
              ],
              temperature: 0.5,
              max_tokens: 300,
              stream: false
            }),
            customTimeout: 120000 // 120s for Nemotron
          });

          if (nimReadmeResponse.ok) {
            const nimReadmeData = await nimReadmeResponse.json();
            if (nimReadmeData.choices && nimReadmeData.choices.length > 0 && nimReadmeData.choices[0].message && nimReadmeData.choices[0].message.content) {
              const answer = nimReadmeData.choices[0].message.content.trim();
              const filteredAnswer = this.basicFormatFallback(answer, 870); // Allow longer for multi-part
              await this.postReply(post, filteredAnswer);
            } else {
              console.error('[ReadmeSelfHelp] Nvidia NIM API response for README was ok, but no content found:', JSON.stringify(nimReadmeData));
              await this.postReply(post, "I looked at my README, but had a little trouble formulating an answer. You can try asking differently!");
            }
          } else {
            const errorTextNim = await nimReadmeResponse.text();
            console.error(`[ReadmeSelfHelp] Nvidia NIM API error for README synthesis (${nimReadmeResponse.status}) - Text: ${errorTextNim}`);
            await this.postReply(post, "I tried to consult my README, but there was an issue connecting to the AI to understand it. Please try again later.");
          }
          return null;
        } else {
          await this.postReply(post, "I'm having trouble accessing my own help file (README) right now. Sorry about that!");
          return null;
        }
      } else if (searchIntent.intent === "search_history") {
        console.log(`[SearchHistory] Intent detected. Criteria:`, searchIntent);
        let matches = [];
        let searchPerformed = ""; // To describe which search was done

        // Priority 1: Bot gallery search for images by the bot
        if (searchIntent.target_type === "image" && searchIntent.author_filter === "bot" && searchIntent.search_scope === "bot_gallery") {
          console.log("[SearchHistory] Performing bot media gallery search.");
          matches = await this.searchBotMediaGallery(searchIntent.keywords, 1); // Get top 1
          searchPerformed = "in my own image gallery";
        }

        // Priority 2 (or fallback): Conversation history search
        // This will run if it's not a bot_gallery search, or if bot_gallery search yielded no results (and we decide to fallback)
        if (matches.length === 0 && searchIntent.search_scope !== "bot_gallery_only") { // Added a hypothetical scope to prevent fallback if desired, default is to fallback
          console.log("[SearchHistory] Performing conversation history search.");
          const conversationHistoryItems = await this.getBotUserConversationHistory(post.author.did, this.agent.did, 50);
          searchPerformed = "in our recent conversation history";
          if (conversationHistoryItems && conversationHistoryItems.length > 0) {
            matches = conversationHistoryItems.filter(item => {
              let authorMatch = false;
              if (searchIntent.author_filter === "user" && item.authorDid === post.author.did) authorMatch = true;
              else if (searchIntent.author_filter === "bot" && item.authorDid === this.agent.did) authorMatch = true;
              else if (searchIntent.author_filter === "any") authorMatch = true;
              if (!authorMatch) return false;

              let typeMatch = false;
              if (searchIntent.target_type === "image") {
                if ((item.embedDetails?.type === 'images' && item.embedDetails.images?.length > 0) ||
                    (item.embedDetails?.type === 'recordWithMedia' && item.embedDetails.media?.type === 'images' && item.embedDetails.media.images?.length > 0)) {
                  typeMatch = true;
                }
              } else if (searchIntent.target_type === "link") {
                if ((item.embedDetails?.type === 'external') ||
                    (item.embedDetails?.type === 'recordWithMedia' && item.embedDetails.media?.type === 'external')) {
                  typeMatch = true;
                }
              } else if (searchIntent.target_type === "post" || searchIntent.target_type === "message" || searchIntent.target_type === "unknown") {
                typeMatch = true;
              }
              if (!typeMatch) return false;

              if (searchIntent.keywords && searchIntent.keywords.length > 0) {
                const itemTextLower = (item.text || "").toLowerCase();
                let embedTextLower = "";
                if (item.embedDetails?.type === 'images' && item.embedDetails.images) {
                  embedTextLower += item.embedDetails.images.map(img => img.alt || "").join(" ").toLowerCase();
                } else if (item.embedDetails?.type === 'external' && item.embedDetails.external) {
                  embedTextLower += (item.embedDetails.external.title || "").toLowerCase() + " " + (item.embedDetails.external.description || "").toLowerCase();
                } else if (item.embedDetails?.type === 'record' && item.embedDetails.record) {
                  embedTextLower += (item.embedDetails.record.textSnippet || "").toLowerCase();
                } else if (item.embedDetails?.type === 'recordWithMedia') {
                  if (item.embedDetails.record) embedTextLower += (item.embedDetails.record.textSnippet || "").toLowerCase() + " ";
                  if (item.embedDetails.media?.type === 'images' && item.embedDetails.media.images) {
                     embedTextLower += item.embedDetails.media.images.map(img => img.alt || "").join(" ").toLowerCase();
                  } else if (item.embedDetails.media?.type === 'external' && item.embedDetails.media.external) {
                     embedTextLower += (item.embedDetails.media.external.title || "").toLowerCase() + " " + (item.embedDetails.media.external.description || "").toLowerCase();
                  }
                }
                const combinedTextForKeywordSearch = itemTextLower + " " + embedTextLower;
                if (!searchIntent.keywords.every(kw => combinedTextForKeywordSearch.includes(kw.toLowerCase()))) {
                  return false;
                }
              }
              return true;
            });
          }
        }

        let nemotronSearchPrompt = "";
        if (matches.length > 0) {
          const topMatch = matches[0]; // Get the single best match
          // const postUrl = `https://bsky.app/profile/${topMatch.authorHandle}/post/${topMatch.uri.split('/').pop()}`; // URL will be part of the embed

          let userQueryContextForNemotron = `The user asked: "${userQueryText}".`;
          if (searchIntent.recency_cue) {
            userQueryContextForNemotron += ` (They mentioned it was from "${searchIntent.recency_cue}").`;
          }
          userQueryContextForNemotron += ` I searched ${searchPerformed} and found a relevant post.`;

          nemotronSearchPrompt = `${userQueryContextForNemotron}\n\nPlease formulate a brief confirmation message to the user, like "I found this post from ${searchIntent.recency_cue || 'our history'} ${searchPerformed}:" or "This might be what you're looking for:". The actual post will be embedded in the reply.`;

          // Prepare details for embedding the found post
          const foundPostToEmbed = {
            uri: topMatch.uri,
            cid: topMatch.cid
          };

          if (!foundPostToEmbed.uri || !foundPostToEmbed.cid) {
            console.error('[SearchHistory] Found post is missing URI or CID, cannot embed. Match details:', topMatch);
            // Fallback to old behavior if critical embed info is missing
            const postUrl = `https://bsky.app/profile/${topMatch.authorHandle}/post/${topMatch.uri.split('/').pop()}`;
            nemotronSearchPrompt = `The user asked: "${userQueryText}". (Recency: ${searchIntent.recency_cue}). I searched ${searchPerformed}.\n\nI found this specific post URL: ${postUrl}\n\nPlease formulate a brief response to the user that directly provides this URL. For example: "Regarding your query about something from ${searchIntent.recency_cue || 'our history'}, I found this ${searchPerformed}: ${postUrl}". The response should primarily be the confirmation and the URL itself.`;
          }


        } else { // NO MATCHES FOUND
          let userQueryContextForNemotron = `The user asked: "${userQueryText}".`;
          if (searchIntent.recency_cue) {
            userQueryContextForNemotron += ` (They mentioned it was from "${searchIntent.recency_cue}").`;
          }
          userQueryContextForNemotron += ` I searched ${searchPerformed}.`;

          nemotronSearchPrompt = `${userQueryContextForNemotron}\n\nI searched ${searchPerformed} but couldn't find any posts that specifically matched your description (using keywords: ${JSON.stringify(searchIntent.keywords)}). Please formulate a polite response to the user stating this, for example: "Sorry, I looked for something matching that description ${searchPerformed} from ${searchIntent.recency_cue || 'recently'} but couldn't find it. Could you try different keywords?"`;
        }

        console.log(`[SearchHistory] Nemotron prompt for search result: "${nemotronSearchPrompt.substring(0,300)}..."`);

        const searchSystemPrompt = matches.length > 0 && matches[0].uri && matches[0].cid
          ? "You are a helpful AI assistant. The user asked you to find something. You have been provided with the user's original query and confirmation that a relevant post was found. Formulate a brief, natural confirmation message (e.g., 'I found this post for you:', 'This might be what you were looking for:'). The actual post will be embedded by the system, so DO NOT include the URL or any details of the post in your text response. Just a short introductory phrase."
          : "You are a helpful AI assistant. The user asked you to find something. You have been provided with the user's original query and the result of your search. If nothing was found, state that clearly and politely. If a post URL was found (but cannot be embedded), your response to the user MUST consist of a brief confirmation phrase and then the Post URL itself.";

        console.log(`NIM CALL START: Search History Response for model nvidia/llama-3.3-nemotron-super-49b-v1`);
        const nimSearchResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
            messages: [
              { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${searchSystemPrompt}` },
              { role: "user", content: nemotronSearchPrompt }
            ],
            temperature: 0.5,
            max_tokens: 100,
            stream: false
          }),
          customTimeout: 120000 // 120s
        });
        console.log(`NIM CALL END: Search History Response - Status: ${nimSearchResponse.status}`);

        if (nimSearchResponse.ok) {
          const nimSearchData = await nimSearchResponse.json();
          if (nimSearchData.choices && nimSearchData.choices.length > 0 && nimSearchData.choices[0].message && nimSearchData.choices[0].message.content) {
            const baseResponseText = nimSearchData.choices[0].message.content.trim();

            const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-3.2-90b-vision-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: baseResponseText }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                }),
                customTimeout: 90000 // 90s
            });

            let finalResponseText = baseResponseText;
            if (filterResponse.ok) {
                const filterData = await filterResponse.json();
                if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                    finalResponseText = filterData.choices[0].message.content.trim();
                }
            }

            // Now, decide whether to embed based on `topMatch` having URI and CID
            if (matches.length > 0 && matches[0].uri && matches[0].cid) {
                const foundPostToEmbed = { uri: matches[0].uri, cid: matches[0].cid };
                await this.postReply(post, finalResponseText, null, null, foundPostToEmbed);
            } else {
                // This branch is for when no match was found, or match was missing uri/cid (fallback to text URL)
                await this.postReply(post, finalResponseText);
            }

          } else {
            console.error('[SearchHistory] Nvidia NIM API response for search was ok, but no content found:', JSON.stringify(nimSearchData));
            await this.postReply(post, "I found some information, but had a slight hiccup displaying it. You might want to try asking again!");
          }
        } else {
          const errorText = await nimSearchResponse.text();
          console.error(`[SearchHistory] Nvidia NIM API error for search response (${nimSearchResponse.status}) - Text: ${errorText}`);
          await this.postReply(post, "I had a little trouble formulating a response for your search query. Please try again!");
        }
        return null; // End processing for this interaction
      } // Closes if (searchIntent.intent === "search_history")
      else if (searchIntent.intent === "nasa_apod") {
        console.log(`[NasaApodFlow] NASA APOD intent detected. Date: ${searchIntent.date}`);
        const apodData = await this.getNasaApod(searchIntent.date);

        if (apodData) {
          let responseText = `NASA Picture of the Day for ${apodData.date}:\n**${apodData.title}**\n\n`;
          responseText += utils.truncateResponse(apodData.explanation, 800); // Allow longer explanation for APOD

          if (apodData.copyright) {
            responseText += `\n\n(Copyright: ${apodData.copyright})`;
          }
          if (apodData.url) { // Add source URL
            responseText += `\n(Source: ${apodData.url})`;
          }

          let imageToPostBase64 = null;
          let altText = apodData.title;
          let externalEmbed = null;
          const BLUESKY_IMAGE_SIZE_LIMIT_BYTES = 976.56 * 1024; // 976.56KB

          if (apodData.media_type === 'image') {
            const imageUrlToFetch = apodData.hdurl || apodData.url;
            console.log(`[NasaApodFlow] Fetching image from ${imageUrlToFetch}`);
            const downloadedImageBase64 = await utils.imageUrlToBase64(imageUrlToFetch);
            if (downloadedImageBase64) {
              const imageSizeBytes = downloadedImageBase64.length * 0.75;
              if (imageSizeBytes > BLUESKY_IMAGE_SIZE_LIMIT_BYTES) {
                console.warn(`[NasaApodFlow] APOD image is too large. Creating link card instead.`);
                responseText = `Today's APOD: ${apodData.title}.\nThe image is too large to post directly, but you can view it here:`; // Shorter text for card
                externalEmbed = {
                  uri: apodData.url, // Link to the APOD page or image if page isn't distinct
                  title: apodData.title,
                  description: utils.truncateResponse(apodData.explanation, 140) + ` (Source: ${apodData.url})` // Shorter desc for card, add source
                };
              } else {
                imageToPostBase64 = downloadedImageBase64;
                // responseText already contains title and full explanation from above
              }
            } else { // Download failed
              console.warn(`[NasaApodFlow] Failed to download APOD image. Creating link card.`);
              responseText = `Today's APOD: ${apodData.title}.\nI couldn't download the image, but you can view it here:`;
              externalEmbed = {
                uri: apodData.url,
                title: apodData.title,
                description: utils.truncateResponse(apodData.explanation, 150)
              };
            }
          } else if (apodData.media_type === 'video') {
            console.log(`[NasaApodFlow] APOD is a video. Creating link card for ${apodData.url}`);
            // For videos, always use an external link card.
            // The main responseText already includes title, explanation. We add a lead-in for the card.
            responseText = `Today's APOD is a video: ${apodData.title}.\n${utils.truncateResponse(apodData.explanation, 200)}\nWatch here:`;
            if (apodData.copyright) responseText += `\n(Copyright: ${apodData.copyright})`;
            externalEmbed = {
              uri: apodData.url, // This should be the video URL (e.g., YouTube)
              title: apodData.title,
              description: `Video: ${utils.truncateResponse(apodData.explanation, 140)} (Source: ${apodData.url})`
            };
            // We won't try to download and attach the video thumbnail if using a card,
            // as Bluesky's card service will try to generate one from the video page.
          } else { // Unknown media type
             console.log(`[NasaApodFlow] APOD is unknown media type. Creating link card for ${apodData.url}`);
             responseText = `Today's APOD: ${apodData.title}.\nType: ${apodData.media_type}.\nView media here:`;
             externalEmbed = {
                uri: apodData.url,
                title: apodData.title,
                description: utils.truncateResponse(apodData.explanation, 140) + ` (Source: ${apodData.url})`
             };
          }

          await this.postReply(post, responseText, imageToPostBase64, altText, null, externalEmbed);
        } else {
          await this.postReply(post, "Sorry, I couldn't fetch the NASA Picture of the Day. Please check the date or try again later.");
        }
        return null; // APOD handling complete
      }
      else if (searchIntent.intent === "create_meme") {
        console.log(`[MemeFlow] Create Meme intent detected:`, searchIntent);

        if (searchIntent.template_query && searchIntent.template_query.toLowerCase() === 'list') {
          const templates = await this.getImgflipTemplates();
          if (templates && templates.length > 0) {
            const topTemplates = templates.slice(0, 10); // Show top 10 or so
            let replyText = "Here are some popular Imgflip meme templates you can use:\n";
            topTemplates.forEach(t => {
              replyText += `\n- ${t.name} (ID: ${t.id}, Boxes: ${t.box_count})`;
            });
            replyText += "\n\nTo use one, say something like: !meme [ID or Name] | [Text for Box 1] | [Text for Box 2]";
            await this.postReply(post, replyText);
          } else {
            await this.postReply(post, "Sorry, I couldn't fetch the list of meme templates right now.");
          }
          return null;
        }

        if (!searchIntent.template_query) {
          await this.postReply(post, "You need to specify a meme template name or ID. Try asking me to 'list meme templates' first!");
          return null;
        }

        // Find template ID
        const allTemplates = await this.getImgflipTemplates(); // TODO: Cache this
        if (!allTemplates || allTemplates.length === 0) {
            await this.postReply(post, "Sorry, I couldn't load any meme templates to choose from.");
            return null;
        }
        const foundTemplate = allTemplates.find(t =>
            t.id === searchIntent.template_query ||
            (t.name && t.name.toLowerCase() === searchIntent.template_query.toLowerCase())
        );

        if (!foundTemplate) {
          await this.postReply(post, `Sorry, I couldn't find the meme template "${searchIntent.template_query}". Try 'list meme templates'.`);
          return null;
        }

        let captions = searchIntent.captions || [];

        if (searchIntent.generate_captions) {
          if (captions.length > 0) { // User provided topic/context in caption field for generation
            const topic = captions.join(" ");
            console.log(`[MemeFlow] Generating captions for template "${foundTemplate.name}" on topic: "${topic}"`);
            // Simplified prompt for caption generation
            const captionGenPrompt = `Generate ${foundTemplate.box_count} short, witty meme captions for the "${foundTemplate.name}" template, related to: "${topic}". Respond with each caption on a new line.`;
            const nemotronSystemPrompt = "You are a creative and funny meme caption generator."; // Different persona for this

            const nimResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'nvidia/llama-3.3-nemotron-super-49b-v1', // Or a model good for creative short text
                  messages: [ { role: "system", content: nemotronSystemPrompt }, { role: "user", content: captionGenPrompt } ],
                  temperature: 0.8, max_tokens: 50 * foundTemplate.box_count, stream: false
                }),
                customTimeout: 120000 // 120s
            });
            if (nimResponse.ok) {
                const nimData = await nimResponse.json();
                if (nimData.choices && nimData.choices[0].message && nimData.choices[0].message.content) {
                    captions = nimData.choices[0].message.content.split('\n').map(c => c.trim()).filter(c => c.length > 0).slice(0, foundTemplate.box_count);
                    console.log(`[MemeFlow] Generated captions:`, captions);
                } else {
                     await this.postReply(post, "I had trouble thinking of captions for that. Please provide your own!"); return null;
                }
            } else {
                 await this.postReply(post, "My caption generator seems to be down. Please provide your own captions!"); return null;
            }
          } else {
             await this.postReply(post, "If you want me to generate captions, please provide a topic or theme in the caption fields."); return null;
          }
        }

        if (captions.length === 0 || captions.length > foundTemplate.box_count) {
             await this.postReply(post, `This meme template ("${foundTemplate.name}") needs ${foundTemplate.box_count} caption(s). You provided ${captions.length}. Please try again.`);
             return null;
        }

        // Text safety check for user-provided or LLM-generated captions
        for (const caption of captions) {
            if (!await this.isTextSafeScout(caption)) {
                await this.postReply(post, "One of the captions seems unsafe. I can't create this meme.");
                return null;
            }
        }

        const memeData = await this.captionImgflipMeme(foundTemplate.id, captions);
        if (!memeData || !memeData.imageUrl) {
          await this.postReply(post, "Sorry, I couldn't create the meme with Imgflip. There might have been an issue with the template or captions.");
          return null;
        }

        console.log(`[MemeFlow] Meme created by Imgflip: ${memeData.imageUrl}. Now downloading for safety check & posting.`);
        const finalMemeBase64 = await utils.imageUrlToBase64(memeData.imageUrl);

        if (!finalMemeBase64) {
          await this.postReply(post, `I created the meme, but had trouble downloading it. You can see it here: ${memeData.pageUrl}`);
          return null;
        }

        let isVisuallySafe = false;
        if (post.author.handle === this.config.ADMIN_BLUESKY_HANDLE) {
          console.log(`[MemeFlow] Admin user ${post.author.handle} initiated meme generation. Bypassing visual safety check for the final meme.`);
          isVisuallySafe = true;
        } else {
          isVisuallySafe = await this.isImageSafeScout(finalMemeBase64);
        }

        if (!isVisuallySafe) {
          // For non-admins, this message is appropriate.
          // For admins, this path should not be hit if override sets isVisuallySafe = true.
          // However, if an admin *wanted* to test the safety check, this logic doesn't currently allow it.
          // For now, sticking to direct override.
          await this.postReply(post, `I created a meme, but it didn't pass the final visual safety check. I cannot post it. You can try viewing it on Imgflip if you wish: ${memeData.pageUrl}`);
          return null;
        }

        const altText = `${foundTemplate.name} meme. Captions: ${captions.join(" - ")}`;
        let memeResponseText = `Here's your "${foundTemplate.name}" meme:`;
        if (memeData.pageUrl) {
          memeResponseText += `\n(Source: ${memeData.pageUrl})`;
        }
        await this.postReply(post, memeResponseText, finalMemeBase64, utils.truncateResponse(altText, 280));
        return null;
      }
      else if (searchIntent.intent === "youtube_search" && searchIntent.search_query) {
        console.log(`[YouTubeSearchFlow] YouTube search intent detected. Query: "${searchIntent.search_query}"`);
        const videoResults = await this.performYouTubeSearch(searchIntent.search_query, 1); // Get top 1 result

        if (videoResults && videoResults.length > 0) {
          const video = videoResults[0];
          let responseText = `I found this YouTube video for "${searchIntent.search_query}":\n${video.title}`;

          const externalEmbed = {
            uri: video.videoUrl,
            title: video.title,
            description: utils.truncateResponse(video.description, 150) // Keep description concise for the card
          };
          if (video.thumbnailUrl) {
            // Note: Bluesky's link card fetcher will try to get a thumbnail.
            // Explicitly providing `thumb` is not directly supported in app.bsky.embed.external.
            // We could download it and try to attach as an image alongside the card, but that's more complex.
            // For now, rely on Bluesky's card service.
            console.log(`[YouTubeSearchFlow] Video thumbnail available: ${video.thumbnailUrl} (will be fetched by Bluesky card service)`);
          }

          await this.postReply(post, responseText, null, null, null, externalEmbed);
        } else {
          const noResultsText = `Sorry, I couldn't find any YouTube videos for "${searchIntent.search_query}".`;
          await this.postReply(post, noResultsText);
        }
        return null; // YouTube search handling complete
      }
      else if (searchIntent.intent === "giphy_search" && searchIntent.search_query) {
        console.log(`[GiphySearchFlow] Giphy search intent detected. Query: "${searchIntent.search_query}"`);
        const giphyResults = await this.searchGiphy(searchIntent.search_query, 1);

        if (giphyResults && giphyResults.length > 0) {
          const gif = giphyResults[0];
          // Instead of downloading, create a link card to the Giphy page.

          let responseText = `Here's a GIPHY GIF for "${searchIntent.search_query}":`;
          // The card itself will show a preview. Attribution will be in the card description.

          const cardDescription = `${gif.title || 'View on GIPHY'}. Powered by GIPHY.`;

          const externalEmbed = {
            uri: gif.pageUrl, // Use the Giphy page URL for the card
            title: gif.title || `GIPHY GIF for ${searchIntent.search_query}`,
            description: utils.truncateResponse(cardDescription, 200) // Keep card description concise
          };

          // Post the text and the link card
          await this.postReply(post, responseText, null, null, null, externalEmbed);

        } else {
          const noResultsText = `Sorry, I couldn't find any GIPHY GIFs for "${searchIntent.search_query}".`;
          await this.postReply(post, noResultsText);
        }
        return null; // Giphy search handling complete
      }
      // If not a search history or other specific intent, proceed with web search or original logic
      else if (searchIntent.intent === "web_search" && searchIntent.search_query) {
        console.log(`[WebSearchFlow] Consolidated web search intent detected. Query: "${searchIntent.search_query}", Type: "${searchIntent.search_type}"`);

        const isQuerySafe = await this.isTextSafeScout(searchIntent.search_query);
        if (!isQuerySafe) {
          console.warn(`[WebSearchFlow] Web search query "${searchIntent.search_query}" deemed unsafe.`);
          const unsafeQueryResponse = "I'm sorry, but I cannot search for that topic due to safety guidelines. Please try a different query.";
          const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: 'meta/llama-4-scout-17b-16e-instruct',
              messages: [
                { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                { role: "user", content: unsafeQueryResponse }
              ],
              temperature: 0.1, max_tokens: 100, stream: false
            }),
            customTimeout: 30000 // 30s
          });
          if (filterResponse.ok) {
            const filterData = await filterResponse.json();
            if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
              await this.postReply(post, filterData.choices[0].message.content.trim());
            } else {
              await this.postReply(post, unsafeQueryResponse);
            }
          } else {
            await this.postReply(post, unsafeQueryResponse);
          }
          return null;
        }

        const searchResults = await this.performGoogleWebSearch(searchIntent.search_query, searchIntent.freshness_suggestion || null, searchIntent.search_type || 'webpage');

        if (searchIntent.search_type === 'image') {
          const MAX_IMAGES_TO_POST = 4;
          let postedImageCount = 0;
          // Removed fluxImagesPostedInLoop as FLUX logic is removed.
          let replyToForNextPost = {
            root: { uri: post.record?.reply?.root?.uri || post.uri, cid: post.record?.reply?.root?.cid || post.cid },
            parent: { uri: post.uri, cid: post.cid }
          };

          // Attempt to post images from Google Search first
          if (searchResults && searchResults.length > 0 && searchResults.every(r => r.type === 'image')) {
            for (let i = 0; i < searchResults.length && postedImageCount < MAX_IMAGES_TO_POST; i++) {
              const imageResult = searchResults[i];
              console.log(`[WebSearchFlow] Processing Google image ${i + 1}/${searchResults.length}: ${imageResult.imageUrl}`);
              try {
                const imageBase64 = await utils.imageUrlToBase64(imageResult.imageUrl);
                if (imageBase64) {
                  let responseText = `Image [${postedImageCount + 1}/${MAX_IMAGES_TO_POST}] for "${searchIntent.search_query}":`;
                  if (imageResult.title && imageResult.title !== "No title") {
                    responseText += `\n${imageResult.title}`;
                  }
                  if (imageResult.contextUrl) {
                    responseText += `\n(Source: ${imageResult.contextUrl})`;
                  }
                  const altText = utils.truncateResponse(imageResult.title || imageResult.snippet || searchIntent.search_query, 280);

                  const parentPostForReply = {
                    uri: replyToForNextPost.parent.uri,
                    cid: replyToForNextPost.parent.cid,
                    author: { did: (postedImageCount === 0 ? post.author.did : this.agent.did) },
                    record: { reply: { root: replyToForNextPost.root } }
                  };

                  const postReplyResult = await this.postReply(parentPostForReply, responseText, imageBase64, altText);
                  if (postReplyResult && postReplyResult.uris.length > 0 && postReplyResult.lastCid) {
                    replyToForNextPost.parent = { uri: postReplyResult.uris[postReplyResult.uris.length - 1], cid: postReplyResult.lastCid };
                    postedImageCount++;
                    if (postedImageCount < MAX_IMAGES_TO_POST) await utils.sleep(2000);
                  } else {
                    console.warn(`[WebSearchFlow] Failed to post Google image ${i + 1} (${imageResult.imageUrl}) or missing CID. Skipping.`);
                  }
                } else {
                  console.warn(`[WebSearchFlow] Could not download/convert Google image ${i + 1}: ${imageResult.imageUrl}. Skipping.`);
                }
              } catch (error) {
                console.error(`[WebSearchFlow] Error processing Google image ${i + 1} (${imageResult.imageUrl}):`, error);
              }
            }
          }

          // If fewer than MAX_IMAGES_TO_POST were posted from web search, generate the rest with FLUX
          const imagesNeededFromFlux = MAX_IMAGES_TO_POST - postedImageCount;
          if (imagesNeededFromFlux > 0) {
            console.log(`[WebSearchFlow] Google images posted: ${postedImageCount}. Attempting to generate ${imagesNeededFromFlux} more with FLUX.`);
            const fluxPrompt = searchIntent.search_query;

            for (let j = 0; j < imagesNeededFromFlux; j++) {
              console.log(`[WebSearchFlow] Generating FLUX image ${j + 1}/${imagesNeededFromFlux} for prompt: "${fluxPrompt}"`);
              const scoutResult = await this.processImagePromptWithScout(fluxPrompt);
              if (scoutResult.safe) {
                const imageBase64 = await this.generateImage(scoutResult.image_prompt);
                if (imageBase64) {
                  const altText = await this.describeImageWithScout(imageBase64) || `Generated image for: ${fluxPrompt}`;
                  let responseText = `Image [${postedImageCount + 1}/${MAX_IMAGES_TO_POST}] for "${fluxPrompt}" (generated with FLUX):`;

                  const parentPostForReply = {
                    uri: replyToForNextPost.parent.uri,
                    cid: replyToForNextPost.parent.cid,
                    author: { did: (postedImageCount === 0 ? post.author.did : this.agent.did) },
                    record: { reply: { root: replyToForNextPost.root } }
                  };

                  const postReplyResult = await this.postReply(parentPostForReply, responseText, imageBase64, altText);
                  if (postReplyResult && postReplyResult.uris.length > 0 && postReplyResult.lastCid) {
                    replyToForNextPost.parent = { uri: postReplyResult.uris[postReplyResult.uris.length - 1], cid: postReplyResult.lastCid };
                    postedImageCount++; // Increment total images posted
                    fluxImagesPostedInLoop++; // Increment FLUX images posted in this loop
                    if (postedImageCount < MAX_IMAGES_TO_POST) await utils.sleep(2000);
                  } else {
                     console.warn(`[WebSearchFlow] Failed to post FLUX generated image ${j + 1} or missing CID.`);
                  }
                } else {
                  console.warn(`[WebSearchFlow] FLUX image generation failed for prompt: "${scoutResult.image_prompt}". Posting text reply.`);
                  const fluxFailText = `I tried to generate an additional image for "${fluxPrompt}", but it didn't work out this time. (${postedImageCount + 1}/${MAX_IMAGES_TO_POST} attempt)`;
                   const parentPostForReplyFail = {
                    uri: replyToForNextPost.parent.uri,
                    cid: replyToForNextPost.parent.cid,
                    author: { did: (postedImageCount === 0 ? post.author.did : this.agent.did) },
                    record: { reply: { root: replyToForNextPost.root } }
                  };
                  const postedFailUris = await this.postReply(parentPostForReplyFail, fluxFailText);
                  if (postedFailUris && postedFailUris.length > 0) {
                    replyToForNextPost.parent = { uri: postedFailUris[postedFailUris.length - 1], cid: null };
                  }
                  if (postedImageCount < MAX_IMAGES_TO_POST && (j + 1) < imagesNeededFromFlux) await utils.sleep(1000);
                }
              } else {
                console.warn(`[WebSearchFlow] FLUX image prompt "${fluxPrompt}" deemed unsafe by Scout. Posting text reply. Reason: ${scoutResult.reply_text}`);
                const unsafeFluxReply = scoutResult.reply_text || `I couldn't generate an additional image for "${fluxPrompt}" due to safety guidelines. (${postedImageCount + 1}/${MAX_IMAGES_TO_POST} attempt)`;
                const parentPostForReplyUnsafe = {
                    uri: replyToForNextPost.parent.uri,
                    cid: replyToForNextPost.parent.cid,
                    author: { did: (postedImageCount === 0 ? post.author.did : this.agent.did) },
                    record: { reply: { root: replyToForNextPost.root } }
                };
                const postedUnsafeUris = await this.postReply(parentPostForReplyUnsafe, unsafeFluxReply);
                if (postedUnsafeUris && postedUnsafeUris.length > 0) {
                    replyToForNextPost.parent = { uri: postedUnsafeUris[postedUnsafeUris.length - 1], cid: null };
                }
                if (postedImageCount < MAX_IMAGES_TO_POST && (j + 1) < imagesNeededFromFlux) await utils.sleep(1000);
              }
              if (postedImageCount >= MAX_IMAGES_TO_POST) break; // Break if we've posted enough
            }
          }

          if (postedImageCount > 0) { // If any image (web or FLUX) was posted
             return null;
          } else {
            // This case implies: Google search returned no usable images AND all FLUX attempts also failed or were unsafe.
            console.log(`[WebSearchFlow] All attempts to find or generate images for "${searchIntent.search_query}" failed.`);
            const allFailedText = `I couldn't find any images for "${searchIntent.search_query}" with a web search, and I also had trouble generating any for you right now.`;
            await this.postReply(post, allFailedText); // Send a final message about the failure
            return null; // Still return null as we've "handled" the request by informing the user
          }
        } else { // Standard text/webpage search logic (previously the second web_search block)
          let nemotronWebServicePrompt = "";
          const webSearchSystemPrompt = `You are an AI assistant. The user asked a question: "${userQueryText}". You have performed a web search for "${searchIntent.search_query}" (freshness: ${searchIntent.freshness_suggestion || 'not specified'}).
Use the provided search results (title, URL, snippet) to formulate a concise and helpful answer to the user's original question.
Synthesize the information from the results. If appropriate, you can cite the source URL(s) by including them in your answer (e.g., "According to [URL], ...").
If the search results do not provide a clear answer, state that you couldn't find specific information from the web for their query.
Do not make up information not present in the search results. Keep the response suitable for a social media post.`;

          if (searchResults && searchResults.length > 0) {
            const topResults = searchResults.slice(0, 2); // Take top 2 results
            const resultsText = topResults.map((res, idx) => {
              const truncatedSnippet = res.snippet ? res.snippet.substring(0, 500) : "No snippet available.";
              return `Result ${idx + 1}:\nTitle: ${res.title}\nURL: ${res.url}\nSnippet: ${truncatedSnippet}${res.snippet && res.snippet.length > 500 ? "..." : ""}`;
            }).join("\n\n---\n");
            nemotronWebServicePrompt = `User's original question: "${userQueryText}"\nSearch query sent to web: "${searchIntent.search_query}"\n\nWeb Search Results (Top ${topResults.length}):\n${resultsText}\n\nBased on these results, please answer the user's original question.`;
            console.log(`[WebSearchFlow] Nemotron prompt for web search synthesis (using top ${topResults.length} results, snippets truncated to 500 chars): "${nemotronWebServicePrompt.substring(0, 400)}..."`);
          } else {
            nemotronWebServicePrompt = `User's original question: "${userQueryText}"\nSearch query sent to web: "${searchIntent.search_query}"\n\nNo clear results were found from the web search. Please inform the user politely that you couldn't find information for their query via web search and suggest they rephrase or try a search engine directly.`;
            console.log(`[WebSearchFlow] Nemotron prompt for web search synthesis (no results found): "${nemotronWebServicePrompt.substring(0, 300)}..."`);
          }

          const nimWebResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
              messages: [
                { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${webSearchSystemPrompt}` },
                { role: "user", content: nemotronWebServicePrompt }
              ],
              temperature: 0.6, max_tokens: 250, stream: false
            }),
          customTimeout: 120000 // 120s
          });

          if (nimWebResponse.ok) {
            const nimWebData = await nimWebResponse.json();
            if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
              const synthesizedResponse = nimWebData.choices[0].message.content.trim();
              const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-3.2-90b-vision-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: synthesizedResponse }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                }),
                customTimeout: 90000 // 90s
              });
              if (filterResponse.ok) {
                const filterData = await filterResponse.json();
                if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                  await this.postReply(post, filterData.choices[0].message.content.trim());
                } else {
                  await this.postReply(post, synthesizedResponse);
                }
              } else {
                await this.postReply(post, synthesizedResponse);
              }
            } else {
              await this.postReply(post, "I searched the web but had a little trouble putting together an answer. You could try rephrasing your question!");
            }
          } else {
            const errorText = await nimWebResponse.text();
            console.error(`[WebSearchFlow] Nvidia NIM API error for web synthesis (${nimWebResponse.status}) - Text: ${errorText}`);
            await this.postReply(post, "I encountered an issue while trying to process information from the web. Please try again later.");
          }
          return null;
        }
      } else { // Neither search_history nor web_search: proceed with original logic (profile analysis / standard reply)
        let conversationHistory = '';
        if (context && context.length > 0) {
          for (const msg of context) {
            const authorRole = (msg.author === this.config.BLUESKY_IDENTIFIER) ? "Bot" : "User";
            let timestampStr = "";
            if (msg.createdAt) {
              try {
                // Format: (Short Month Day, Year, HH:MM AM/PM) e.g. (Dec 25, 2023, 05:30 PM)
                timestampStr = ` (${new Date(msg.createdAt).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })})`;
              } catch (e) {
                console.warn(`[TimestampFormat] Error formatting date: ${msg.createdAt}`, e);
                // Keep timestampStr empty or add a generic error placeholder if preferred
                timestampStr = " (timestamp unavailable)";
              }
            }
            conversationHistory += `${authorRole}${timestampStr}: ${msg.text}\n`;
            if (msg.images && msg.images.length > 0) {
              msg.images.forEach(image => {
                if (image.alt) {
                  conversationHistory += `[${authorRole} sent an image with description: ${image.alt}]\n`;
                } else {
                  conversationHistory += `[${authorRole} sent an image]\n`;
                }
              });
            }
          }
        }

        let userBlueskyPostsContext = "";
        const fetchContextDecision = await this.shouldFetchProfileContext(userQueryText);

        if (fetchContextDecision) {
          console.log(`[Context] Scout determined conversation history should be fetched for user DID: ${post.author.did} and bot DID: ${this.agent.did}. Query: "${userQueryText}"`);
        try {
          const conversationHistoryItems = await this.getBotUserConversationHistory(post.author.did, this.agent.did, 50);
          if (conversationHistoryItems.length > 0) {
            userBlueskyPostsContext = "\n\nRecent conversation history between you and the user (" + post.author.handle + "):\n" + conversationHistoryItems.map(item => `${item.authorHandle}: ${item.text}`).join("\n---\n") + "\n\n";
            console.log(`[Context] Added ${conversationHistoryItems.length} conversation messages to Nemotron context.`);
          } else {
            console.log(`[Context] No direct conversation history found between user ${post.author.did} and bot ${this.agent.did}.`);
            // Optionally, you could fall back to the old general user feed fetching here, or decide that no context is better.
            // For now, we'll proceed without this specific context if it's empty.
          }
        } catch (error) {
          console.error(`[Context] Error fetching conversation history between user ${post.author.did} and bot ${this.agent.did}:`, error);
        }
      }

      let nemotronUserPrompt = "";
      const currentDateTime = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'full' });
      const baseInstruction = `Your response will be posted to BlueSky as a reply to the most recent message mentioning you by a bot. For detailed topics, you can generate a response up to about 870 characters; it will be split into multiple posts if needed.`;

      const dateTimePreamble = `Current date and time is ${currentDateTime}.\n\n`;

      let likeAcknowledgementPreamble = "";
      if (userLikedBotsPreviousReply) {
        // This preamble provides context to the LLM. The system prompt (to be updated later)
        // will instruct the LLM on how to use this information subtly.
        likeAcknowledgementPreamble = "USER FEEDBACK: The user you are replying to recently liked your previous message in this thread. You can acknowledge this positively and subtly if it feels natural (e.g., 'Thanks for the feedback on my last message!' or 'Glad you liked my last response!'), before addressing their current query. This is just context; don't make it the main focus unless the user's current query is about the like itself.\n\n";
      }

      if (userBlueskyPostsContext && userBlueskyPostsContext.trim() !== "") {
        // Profile analysis prompt
        nemotronUserPrompt = `${dateTimePreamble}${likeAcknowledgementPreamble}The user's question is: "${post.record.text}"

Activate your "User Profile Analyzer" capability. Based on the "USER'S RECENT BLUESKY ACTIVITY" provided below, generate your response in two parts:

PART 1: SUMMARY AND INVITATION
Format this part starting with the exact marker "[SUMMARY FINDING WITH INVITATION]".
Provide a concise summary (approx. 250-280 characters, in your persona) of your analysis of the user's activity.
This summary **must end with a clear question inviting the user to ask for more details** (e.g., "I found some interesting patterns. Would you like a more detailed breakdown of these points?").

PART 2: DETAILED ANALYSIS POINTS
Immediately following Part 1, and on new lines, provide 1 to 3 detailed analysis points.
Each point MUST start with the exact marker: "[DETAILED ANALYSIS POINT 1]", then "[DETAILED ANALYSIS POINT 2]", etc. NO OTHER TEXT BEFORE THE MARKER ON THAT LINE.
For each point, write a short paragraph (around 2-4 sentences, keeping total under 290 characters for a Bluesky post) that flows naturally as if you are explaining your insights one by one.
Your tone should be insightful, friendly, and engaging, reflecting your persona: "${this.config.TEXT_SYSTEM_PROMPT}".
Avoid starting the *content* of a point with "1.", "a)", or other list markers unless it's a very natural way to present a list *within* your flowing explanation. Focus on conversational delivery of each distinct insight.
Analyze themes, common topics, or aspects of their interaction as reflected in the provided context (conversation history or user's general activity).

USER'S RECENT BLUESKY ACTIVITY (or CONVERSATION HISTORY):
${userBlueskyPostsContext}
---
${conversationHistory ? `\nBrief current thread context (less critical than the main context above for this specific analysis):\n${conversationHistory}\n---` : ''}
Your structured response (Summary with Invitation, then Detailed Points):
${baseInstruction}`;
      } else {
        // Standard prompt (no specific profile context fetched)
        nemotronUserPrompt = `${dateTimePreamble}${likeAcknowledgementPreamble}Here's the conversation context:\n\n${conversationHistory}\nThe most recent message mentioning you is: "${post.record.text}"\nPlease respond to the request in the most recent message. ${baseInstruction}`;
      }

      console.log(`NIM CALL START: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1. Prompt type: ${userBlueskyPostsContext && userBlueskyPostsContext.trim() !== "" ? "Profile Analysis" : "Standard"}. Like Preamble: ${!!likeAcknowledgementPreamble}`);
      const response = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [
            { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}` },
            { role: "user", content: nemotronUserPrompt }
          ],
          temperature: 0.7, max_tokens: 350,
          stream: false
        }),
          customTimeout: 120000 // 120s for main generation
      });
      console.log(`NIM CALL END: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1 - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) - Text: ${errorText}`);
        // No automatic retry here by calling this.generateResponse; fetchWithRetries handles retries.
        // If it still fails, throw or return null.
        throw new Error(`Nvidia NIM API error after retries: ${response.status} ${response.statusText || errorText}`);
      }
      const data = await response.json();
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM:', JSON.stringify(data));
        throw new Error('Invalid response format from Nvidia NIM chat completions API');
      }
      let initialResponse = data.choices[0].message.content;
      console.log(`[LlamaBot.generateResponse] Initial response from nvidia/llama-3.3-nemotron-super-49b-v1: "${initialResponse}"`);

      console.log(`NIM CALL START: filterResponse for model meta/llama-4-scout-17b-16e-instruct`);
      const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-3.2-90b-vision-instruct', // This was already changed in a previous step by mistake, ensuring it's correct
          messages: [
            { role: "system", content: "ATTENTION: The input text from another AI may be structured with special bracketed labels like \"[SUMMARY FINDING WITH INVITATION]\" and \"[DETAILED ANALYSIS POINT N]\". PRESERVE THESE BRACKETED LABELS EXACTLY AS THEY APPEAR.\n\nYour task is to perform MINIMAL formatting on the text *within each section defined by these labels*, as if each section were a separate piece of text. For each section:\n1. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY.\n2. Ensure any text content is clean and suitable for a Bluesky post (e.g., under 290 characters per logical section if possible, though final splitting is handled later).\n3. Remove any surrounding quotation marks that make an entire section appear as a direct quote.\n4. Remove any sender attributions like 'Bot:' or 'Nemotron says:'.\n5. Remove any double asterisks (`**`) used for emphasis.\n6. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear.\n7. Ensure any internal numbered or bulleted lists within a \"[DETAILED ANALYSIS POINT N]\" section are well-formatted and would not be awkwardly split if that section became a single post.\n\nDO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change the overall structure or the bracketed labels. Output the entire processed text, including the preserved labels. This is an internal formatting step; do not mention it. The input text you receive might be long (up to ~870 characters or ~350 tokens)." },
            { role: "user", content: initialResponse }
          ],
          temperature: 0.1,
          max_tokens: 450,
          stream: false
        }),
        customTimeout: 90000 // 90s for filtering
      });
      console.log(`NIM CALL END: filterResponse for model meta/llama-3.2-90b-vision-instruct - Status: ${filterResponse.status}`);
      if (!filterResponse.ok) {
        const errorText = await filterResponse.text();
        console.error(`Nvidia NIM API error (filter model) (${filterResponse.status}) - Text: ${errorText}. Falling back to basic formatter.`);
        initialResponse = this.basicFormatFallback(initialResponse); // Apply basic formatting on fallback
        // Continue with initialResponse now that it's basic formatted
      } else {
        const filterData = await filterResponse.json();
        if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message && filterData.choices[0].message.content) {
          initialResponse = filterData.choices[0].message.content; // Use Scout's formatted response
        } else {
          console.error('Unexpected response format from Nvidia NIM (filter model):', JSON.stringify(filterData), '. Falling back to basic formatter.');
          initialResponse = this.basicFormatFallback(initialResponse); // Apply basic formatting on fallback
        }
      }
      // At this point, initialResponse holds Nemotron's direct output.
      // Filter it with Gemma.
      const filterModelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
      const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
      const filterSystemPromptForGenerateResponse = `ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are:
1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. If you must truncate, end with '...'.
2. Remove any surrounding quotation marks that make the entire text appear as a direct quote (unless the quote is very short and clearly intended as such).
3. Remove any sender attributions like 'Bot:', 'AI:', 'Nemotron says:', 'Llama says:', 'Assistant:', etc.
4. Remove ALL double asterisks (\`**\`) unconditionally.
5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text.
6. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications.
7. DO NOT add any structural markers like [SUMMARY FINDING WITH INVITATION] or [DETAILED ANALYSIS POINT N] unless they were explicitly part of the input text and seem intended for the user. If they seem like processing instructions, remove them.
Output only the processed text. This is an internal formatting step; do not mention it.`;

      let gemmaFormattedText; // Changed variable name
      try {
        console.log(`NIM CALL START: filterResponse (using ${filterModelId}) in generateResponse`);
        const filterResponse = await fetchWithRetries(endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: filterModelId,
            messages: [
              { role: "system", content: filterSystemPromptForGenerateResponse },
              { role: "user", content: initialResponse } // initialResponse is Nemotron's output
            ],
            temperature: 0.1, max_tokens: 450, stream: false
          }),
          customTimeout: 90000 // 90s
        });
        console.log(`NIM CALL END: filterResponse (using ${filterModelId}) in generateResponse - Status: ${filterResponse.status}`);
        if (!filterResponse.ok) {
          const errorText = await filterResponse.text();
          console.error(`NIM CALL ERROR: API error ${filterResponse.status} for filter model ${filterModelId} in generateResponse: ${errorText}. Applying basic formatting.`);
          gemmaFormattedText = this.basicFormatFallback(initialResponse, 870);
        } else {
          const filterData = await filterResponse.json();
          if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message && filterData.choices[0].message.content) {
            gemmaFormattedText = filterData.choices[0].message.content;
            console.log(`[LlamaBot.generateResponse] Filtered response from ${filterModelId}: "${gemmaFormattedText.substring(0,200)}..."`);
          } else {
            console.error(`NIM CALL ERROR: Unexpected response format from filter model ${filterModelId} in generateResponse: ${JSON.stringify(filterData)}. Applying basic formatting.`);
            gemmaFormattedText = this.basicFormatFallback(initialResponse, 870);
          }
        }
      } catch (error) {
        console.error(`NIM CALL EXCEPTION: Error in filtering step of generateResponse with model ${filterModelId}: ${error.message}. Applying basic formatting.`);
        gemmaFormattedText = this.basicFormatFallback(initialResponse, 870); // Allow longer for multi-part
      }
      // Now gemmaFormattedText holds the result of filtering by Gemma, or basicFormatFallback.
      const scoutFormattedText = gemmaFormattedText; // Keep variable name for subsequent logic for minimal diff
      console.log(`[LlamaBot.generateResponse] Final formatted text for processing: "${scoutFormattedText.substring(0,200)}..."`);

      // Attempt to parse structured response if profile analysis was done
      // Note: an image generated for the *initial* query that leads to a summary/details flow.
      // This image should be passed if details are later requested.
      // We need to receive potential imageBase64 & altText if they were generated for the initial query.
      // Let's assume `post.generatedImageForThisInteraction = { imageBase64, altText }` if available.
      // This is a placeholder; actual passing of this data needs to be handled from the monitor call.

      if (fetchContextDecision) {
        const summaryMarker = "[SUMMARY FINDING WITH INVITATION]";
        const detailMarkerBase = "[DETAILED ANALYSIS POINT "; // e.g., "[DETAILED ANALYSIS POINT 1]"

        let summaryText = "";
        const detailedPoints = [];

        const summaryStartIndex = scoutFormattedText.indexOf(summaryMarker);

        if (summaryStartIndex !== -1) {
          let textAfterSummaryMarker = scoutFormattedText.substring(summaryStartIndex + summaryMarker.length);

          let nextDetailPointIndex = textAfterSummaryMarker.indexOf(detailMarkerBase + "1]");
          if (nextDetailPointIndex === -1) {
            summaryText = textAfterSummaryMarker.trim();
          } else {
            summaryText = textAfterSummaryMarker.substring(0, nextDetailPointIndex).trim();
            textAfterSummaryMarker = textAfterSummaryMarker.substring(nextDetailPointIndex);
          }

          // Extract detailed points
          let currentPointNum = 1;
          while (detailedPoints.length < 3) { // Max 3 detailed points
            const currentDetailMarker = `${detailMarkerBase}${currentPointNum}]`;
            const nextDetailMarker = `${detailMarkerBase}${currentPointNum + 1}]`;

            const startOfCurrentPoint = textAfterSummaryMarker.indexOf(currentDetailMarker);
            if (startOfCurrentPoint === -1) break;

            let endOfCurrentPoint = textAfterSummaryMarker.indexOf(nextDetailMarker, startOfCurrentPoint + currentDetailMarker.length);
            let pointTextContent;

            if (endOfCurrentPoint === -1) {
              pointTextContent = textAfterSummaryMarker.substring(startOfCurrentPoint + currentDetailMarker.length).trim();
            } else {
              pointTextContent = textAfterSummaryMarker.substring(startOfCurrentPoint + currentDetailMarker.length, endOfCurrentPoint).trim();
            }

            // Clean any leading list-like markers from Nemotron/Scout
    // Clean known tags from pointTextContent
    let cleanPointText = pointTextContent
        .replace(/\s*\[SUMMARY FINDING WITH INVITATION\]\s*/gi, "") // More robust regex
        .replace(/\s*\[DETAILED ANALYSIS POINT \d+\]\s*/gi, "") // More robust regex
        .trim();
    // Also keep existing list marker cleaning
    cleanPointText = cleanPointText.replace(/^(\s*(\d+\.|\d+\)|\*|-)\s*)+/, '').trim();

    if (cleanPointText) {
        detailedPoints.push(cleanPointText);
            }

            if (endOfCurrentPoint === -1) break; // Last point processed
            textAfterSummaryMarker = textAfterSummaryMarker.substring(endOfCurrentPoint); // Move to the start of the next potential marker
            currentPointNum++;
          }

          console.log(`[LlamaBot.generateResponse] Parsed Summary: "${summaryText}"`);
          detailedPoints.forEach((p, idx) => console.log(`[LlamaBot.generateResponse] Parsed Detail Point ${idx + 1} (already cleaned of tags): "${p.substring(0,100)}..."`));

          // Defensively clean summaryText again, though initial parsing should handle it.
          const cleanSummaryText = summaryText
            .replace(/\s*\[SUMMARY FINDING WITH INVITATION\]\s*/gi, "") // More robust regex
            .replace(/\s*\[DETAILED ANALYSIS POINT \d+\]\s*/gi, "") // More robust regex, also for safety
            .trim();

          if (cleanSummaryText) {
            // Store detailed points if any, then return only summary for initial post
            // Post the summary first. No image on summary.
            // detailedPoints array already contains cleaned points.
            const summaryPostReplyResult = await this.postReply(post, cleanSummaryText, null, null);

            if (summaryPostReplyResult && summaryPostReplyResult.uris.length > 0 && summaryPostReplyResult.lastCid) {
              const summaryPostUri = summaryPostReplyResult.uris[summaryPostReplyResult.uris.length - 1]; // Get the last part's URI
              const summaryPostCid = summaryPostReplyResult.lastCid; // Get the last part's CID
              console.log(`[LlamaBot.generateResponse] Summary posted successfully. Last part URI: ${summaryPostUri}, CID: ${summaryPostCid}. Total parts: ${summaryPostReplyResult.uris.length}`);
              if (detailedPoints.length > 0) {
                this.pendingDetailedAnalyses.set(post.uri, { // Keyed by original user post URI
                  points: detailedPoints,
                  timestamp: Date.now(),
                  summaryPostUri: summaryPostUri, // URI of the bot's summary post
                  summaryPostCid: summaryPostCid, // CID of the bot's summary post
                  replyToRootUri: post.record?.reply?.root?.uri || post.uri, // Root for threading details
                  // imageBase64 and altText from the initial query, if any.
                  // These need to be passed into generateResponse if they existed.
                  // For now, assuming they might be on `post.generatedImageForThisInteraction`
                  imageBase64: post.generatedImageForThisInteraction?.imageBase64 || null,
                  altText: post.generatedImageForThisInteraction?.altText || "Generated image for detail",
                });
                console.log(`[LlamaBot.generateResponse] Stored ${detailedPoints.length} detailed points, pending for original post URI: ${post.uri}, summary URI: ${summaryPostUri}`);
              }
              return null; // Successfully posted summary and cached details
            } else {
              console.error("[LlamaBot.generateResponse] Failed to post summary. Replying with error and returning null.");
              await this.postReply(post, "I had a little trouble putting my thoughts together for that summary. Could you try asking again?");
              return null;
            }
          } else {
            console.warn("[LlamaBot.generateResponse] Profile analysis: Summary text was empty after parsing. Replying with error and returning null.");
            await this.postReply(post, "I analyzed the context but couldn't form a summary. Maybe try rephrasing?");
            return null;
          }
        } else {
          console.warn("[LlamaBot.generateResponse] Profile analysis: [SUMMARY FINDING WITH INVITATION] marker not found. Replying with error and returning null.");
          await this.postReply(post, "I tried to analyze the context but had trouble structuring my response. Could you try a different approach?");
          return null;
        }
      } else {
        // This path is taken if fetchContextDecision is false (standard response path)
        // or if profile analysis was attempted but markers weren't found (fallback to treating as standard response).
        // `scoutFormattedText` here is the result of Nemotron + two filters.

        // Call for visual enhancement suggestion
        const visualSuggestion = await this.getVisualEnhancementSuggestion(userQueryText, scoutFormattedText);

        if (visualSuggestion && visualSuggestion.action !== "none") {
          console.log(`[ResponseEnhancer] Suggestion received: ${JSON.stringify(visualSuggestion)}`);
          // For now, we will just log the suggestion.
          // Actual tool execution (generate, gif_search, image_search) and combining with scoutFormattedText
          // will be handled in the next plan step and might require returning more structured data
          // or handling posting directly here and then returning null.
          // For this step, let's just get the suggestion. The next step will use it.
          // We will still return scoutFormattedText for now, and monitor will post it.
          // The monitor will then need to be adjusted to handle these suggestions.
          //
          // OR, simpler for now: if a visual is suggested, this function posts text + visual and returns null.
          // This avoids major refactor of monitor immediately.

          let imageBase64 = null;
          let altText = null;
          let externalEmbed = null;
          let finalResponseText = scoutFormattedText; // Start with the original text

          try {
            if (visualSuggestion.action === "generate" && visualSuggestion.query) {
              const genPromptScoutResult = await this.processImagePromptWithScout(visualSuggestion.query);
              if (genPromptScoutResult.safe) {
                imageBase64 = await this.generateImage(genPromptScoutResult.image_prompt);
                if (imageBase64) {
                  altText = await this.describeImageWithScout(imageBase64) || `Generated image for: ${visualSuggestion.query}`;
                  // Prepend a note about the image to the text response, or modify as needed
                  // finalResponseText = `${scoutFormattedText}\n\nHere's an image I thought you might like:`;
                } else { console.warn("[ResponseEnhancer] Image generation failed for suggested prompt."); }
              } else { console.warn("[ResponseEnhancer] Suggested image generation prompt deemed unsafe."); }
            } else if (visualSuggestion.action === "gif_search" && visualSuggestion.query) {
              const gifs = await this.searchGiphy(visualSuggestion.query, 1);
              if (gifs && gifs.length > 0 && gifs[0].pageUrl) {
                externalEmbed = { uri: gifs[0].pageUrl, title: gifs[0].title || "GIF", description: `Via GIPHY for: ${visualSuggestion.query}` };
                // finalResponseText = `${scoutFormattedText}\n\nI found a GIF for that:`;
              } else { console.warn("[ResponseEnhancer] Giphy search failed for suggested query."); }
            } else if (visualSuggestion.action === "image_search" && visualSuggestion.query) {
              const images = await this.performGoogleWebSearch(visualSuggestion.query, null, 'image');
              if (images && images.length > 0 && images[0].imageUrl) {
                imageBase64 = await utils.imageUrlToBase64(images[0].imageUrl);
                if (imageBase64) {
                  altText = images[0].title || `Image related to: ${visualSuggestion.query}`;
                  // finalResponseText = `${scoutFormattedText}\n\nHere's an image I found:`;
                } else { console.warn("[ResponseEnhancer] Web image download failed for suggested query."); }
              } else { console.warn("[ResponseEnhancer] Web image search failed for suggested query."); }
            }

            // If any visual was successfully prepared, post it with the text and return null
            if (imageBase64 || externalEmbed) {
              console.log(`[ResponseEnhancer] Posting original text with proactive visual. Image: ${!!imageBase64}, Embed: ${!!externalEmbed}`);
              await this.postReply(post, finalResponseText, imageBase64, altText, null, externalEmbed);
              return null; // Response fully handled
            }
          } catch (toolError) {
            console.error(`[ResponseEnhancer] Error during proactive tool execution:`, toolError);
            // Fall through to just returning the original text if tool use fails
          }
        }
        // If no visual suggestion or tool use failed, return the original text
        return scoutFormattedText;
      }
    } // Closes the main 'else' block (this comment might be slightly off if structure changed)
    } catch (error) {
      console.error(`[LlamaBot.generateResponse] Caught error for post URI: ${post.uri}. Error:`, error);
      return null; // Ensure null is returned on error so monitor doesn't try to post it.
    } // Closes the catch block of generateResponse
  } // Closes the generateResponse method async generateResponse(post, context) {

  getModelName() {
    return 'nvidia/llama-3.3-nemotron-super-49b-v1 (filtered by meta/llama-4-scout-17b-16e-instruct)'.split('/').pop();
  }

  async getImgflipTemplates() {
    console.log('[Imgflip] Fetching meme templates from Imgflip...');
    try {
      const response = await fetch('https://api.imgflip.com/get_memes');
      if (!response.ok) {
        console.error(`[Imgflip] API error fetching templates: ${response.status} ${response.statusText}`);
        return [];
      }
      const data = await response.json();
      if (data.success && data.data && data.data.memes) {
        console.log(`[Imgflip] Successfully fetched ${data.data.memes.length} meme templates.`);
        return data.data.memes.map(meme => ({
          id: meme.id,
          name: meme.name,
          url: meme.url,
          box_count: meme.box_count,
          width: meme.width,
          height: meme.height
        }));
      } else {
        console.error('[Imgflip] API call successful but response format incorrect or no memes found:', data.error_message || 'No error message');
        return [];
      }
    } catch (error) {
      console.error('[Imgflip] Exception fetching meme templates:', error);
      return [];
    }
  }

  async captionImgflipMeme(templateId, texts = [], font = null, maxFontSize = null) {
    console.log(`[Imgflip] Captioning meme template ID: ${templateId} with ${texts.length} texts.`);
    if (!this.config.IMGFLIP_USERNAME || !this.config.IMGFLIP_PASSWORD) {
      console.error('[Imgflip] Imgflip username or password not configured.');
      return null;
    }

    const params = new URLSearchParams();
    params.append('template_id', templateId);
    params.append('username', this.config.IMGFLIP_USERNAME);
    params.append('password', this.config.IMGFLIP_PASSWORD);

    // For V1, using text0 and text1 for simplicity for 2-box memes.
    // The API docs state: "If boxes is specified, text0 and text1 will be ignored"
    // "you may leave the first box completely empty, so that the second box will automatically be used for the bottom text."
    // This implies text0 is top, text1 is bottom if box_count is 2.
    if (texts.length > 0) {
      params.append('text0', texts[0]);
    }
    if (texts.length > 1) {
      params.append('text1', texts[1]);
    }
    // For more than 2 texts, the `boxes` parameter would be needed. We'll omit for V1 simplicity.

    if (font) {
      params.append('font', font);
    }
    if (maxFontSize) {
      params.append('max_font_size', maxFontSize.toString());
    }

    try {
      const response = await fetch('https://api.imgflip.com/caption_image', {
        method: 'POST',
        body: params // URLSearchParams will be sent as application/x-www-form-urlencoded
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        console.error(`[Imgflip] API error captioning image: ${response.status} - ${data.error_message || 'Unknown error'}`);
        return null;
      }

      console.log(`[Imgflip] Successfully captioned meme. URL: ${data.data.url}, Page URL: ${data.data.page_url}`);
      return {
        imageUrl: data.data.url,
        pageUrl: data.data.page_url
      };
    } catch (error) {
      console.error('[Imgflip] Exception captioning meme:', error);
      return null;
    }
  }

  async getNasaApod(requestedDate = null) {
    console.log(`[NasaApod] Fetching APOD. Requested date: ${requestedDate}`);
    const apiKey = "DEMO_KEY"; // Using DEMO_KEY as specified
    let apiUrl = `https://api.nasa.gov/planetary/apod?api_key=${apiKey}&thumbs=true`;

    if (requestedDate && requestedDate !== "today" && requestedDate !== "yesterday") {
      // Basic validation for YYYY-MM-DD format, more robust validation could be added
      if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        apiUrl += `&date=${requestedDate}`;
      } else {
        // Handle relative dates like "yesterday" - NASA API doesn't directly support this.
        // We need to calculate it.
        // For now, if it's not YYYY-MM-DD or "today", we might just let it default to today or log a warning.
        // Let's try to calculate "yesterday".
        if (requestedDate.toLowerCase() === 'yesterday') {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yyyy = yesterday.getFullYear();
            const mm = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
            const dd = String(yesterday.getDate()).padStart(2, '0');
            apiUrl += `&date=${yyyy}-${mm}-${dd}`;
            console.log(`[NasaApod] Calculated 'yesterday' as ${yyyy}-${mm}-${dd}`);
        } else {
            console.warn(`[NasaApod] Invalid or unhandled date format for APOD: ${requestedDate}. Defaulting to today.`);
            // No date parameter added, API defaults to today's APOD
        }
      }
    }
    // If requestedDate is "today" or null, no date parameter is added, API defaults to today.

    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        const errorText = await response.text();
        let detail = errorText;
        try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.msg) detail = errorJson.msg;
            else if (errorJson.error && errorJson.error.message) detail = errorJson.error.message;
        } catch(e) { /* ignore */ }
        console.error(`[NasaApod] NASA APOD API error: ${response.status} - ${detail}`);
        return null;
      }
      const data = await response.json();
      // Ensure essential fields are present, especially URL, title, explanation, media_type
      if (!data.url || !data.title || !data.explanation || !data.media_type) {
          console.error('[NasaApod] NASA APOD API response missing essential fields:', data);
          return null;
      }
      console.log(`[NasaApod] Successfully fetched APOD for date: ${data.date}, Title: ${data.title}`);
      return {
        title: data.title,
        explanation: data.explanation,
        url: data.url,
        hdurl: data.hdurl || null,
        media_type: data.media_type, // "image" or "video"
        thumbnail_url: data.thumbnail_url || null, // Only if media_type is video and thumbs=true
        copyright: data.copyright || null,
        date: data.date, // The actual date of the APOD returned
      };
    } catch (error) {
      console.error(`[NasaApod] Exception during NASA APOD API call:`, error);
      return null;
    }
  }

  async performGoogleWebSearch(searchQuery, freshness = null, searchType = 'webpage') {
    console.log(`[GoogleSearch] Performing Google search. Type: ${searchType}, Query: "${searchQuery}", Freshness: ${freshness}`);
    if (!this.config.GOOGLE_CUSTOM_SEARCH_API_KEY || !this.config.GOOGLE_CUSTOM_SEARCH_CX_ID) {
      console.error("[GoogleSearch] GOOGLE_CUSTOM_SEARCH_API_KEY or GOOGLE_CUSTOM_SEARCH_CX_ID is not set. Cannot perform web search.");
      return [];
    }

    const apiKey = this.config.GOOGLE_CUSTOM_SEARCH_API_KEY;
    const cxId = this.config.GOOGLE_CUSTOM_SEARCH_CX_ID;
    let url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cxId}&q=${encodeURIComponent(searchQuery)}&safe=active`; // Added safe=active

    if (searchType === 'image') {
      url += `&searchType=image`;
    }

    if (freshness) {
      let dateRestrict;
      if (freshness === "oneDay") dateRestrict = "d1";
      else if (freshness === "oneWeek") dateRestrict = "w1";
      else if (freshness === "oneMonth") dateRestrict = "m1";
      if (dateRestrict) {
        url += `&dateRestrict=${dateRestrict}`;
      }
    }

    url += `&num=4`; // Request up to 4 results (applies to both web and image searches)

    try {
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) {
        const errorText = await response.text();
        let detail = "";
        try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.error && errorJson.error.message) {
                detail = errorJson.error.message;
            }
        } catch (e) { /* ignore parsing error if not json */ }
        console.error(`[GoogleSearch] API error: ${response.status} - ${detail || errorText}`);
        return [];
      }

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        let results;
        if (searchType === 'image') {
          results = data.items.map(item => ({
            type: 'image',
            title: item.title || "No title",
            imageUrl: item.link, // For images, item.link is the direct link to the image
            contextUrl: item.image?.contextLink || '',
            snippet: item.snippet || "No snippet available.", // Snippet might describe the image or its context page
            // Other image-specific fields like item.mime, item.image.thumbnailLink could be added if needed
          }));
          console.log(`[GoogleSearch] Found ${results.length} image results for query "${searchQuery}". Total results: ${data.searchInformation?.totalResults || 'N/A'}`);
        } else { // webpage
          results = data.items.map(item => ({
            type: 'webpage',
            title: item.title || "No title",
            url: item.link,
            displayUrl: item.displayLink || item.link,
            snippet: item.snippet || "No snippet available.",
            summary: item.snippet || null,
            datePublished: item.pagemap?.cse_metatags?.[0]?.['article:published_time'] || item.pagemap?.metatags?.[0]?.['article:published_time'] || null,
            dateLastCrawled: null,
          }));
          console.log(`[GoogleSearch] Found ${results.length} web page results for query "${searchQuery}". Total results: ${data.searchInformation?.totalResults || 'N/A'}`);
        }
        return results;
      } else {
        console.log(`[GoogleSearch] No results found (type: ${searchType}) for query "${searchQuery}"`);
        return [];
      }
    } catch (error) {
      console.error(`[GoogleSearch] Exception during web search (type: ${searchType}) for query "${searchQuery}":`, error);
      return [];
    }
  }

  // Old performWebSearch for LangSearch has been removed.

  /**
   * Fetches and constructs a chronological conversation history between a specific user and the bot.
   *
   * Test Cases for getBotUserConversationHistory:
   * 1.  Empty Feeds: Both user and bot feeds return no posts. Expected: Empty history.
   * 2.  Only User Posts, No Interaction: User has posts, but none are replies to or mentions of the bot. Bot has no relevant posts. Expected: Empty history.
   * 3.  Only Bot Posts, No Interaction: Bot has posts, but none are replies to or mentions of the user. User has no relevant posts. Expected: Empty history.
   * 4.  User Replies to Bot: User's feed contains replies to the bot. Bot's feed is empty/irrelevant. Expected: History contains user's replies.
   * 5.  Bot Replies to User: Bot's feed contains replies to the user. User's feed is empty/irrelevant. Expected: History contains bot's replies.
   * 6.  User Mentions Bot: User's feed contains posts mentioning the bot (via DID in facet). Expected: History contains user's mentions.
   * 7.  Bot Mentions User: Bot's feed contains posts mentioning the user (via DID in facet). Expected: History contains bot's mentions.
   * 8.  Mixed Interaction: Both user and bot have replies and mentions involving each other. Expected: Combined, sorted history.
   * 9.  Pagination and Limit: Interaction history is longer than `fetchLimitPerActor` but shorter than `maxAttempts * fetchLimitPerActor`.
   *     Expected: History is correctly fetched across pages and limited by `historyLimit`.
   * 10. Deduplication: Ensure posts fetched from both user and bot feeds (if one references the other directly) appear only once.
   * 11. Sorting: Posts from different feeds and different timestamps are correctly interleaved and sorted chronologically (newest first).
   * 12. `historyLimit` Enforcement: More than `historyLimit` relevant posts exist. Expected: Only the `historyLimit` most recent posts are returned.
   * 13. Invalid DIDs/Handles: How it behaves if `getProfile` fails for user handle (should log warning, filtering from bot to user may be less effective).
   * 14. Facet Variations: Test with different facet structures for mentions, ensuring DID-based matching is robust.
   *
   * @param {string} userDid - The DID of the user.
   * @param {string} botDid - The DID of the bot.
   * @param {number} historyLimit - The maximum number of conversation items to return.
   * @returns {Promise<Array<Object>>} A promise that resolves to an array of post objects.
   */
  async getBotUserConversationHistory(userDid, botDid, historyLimit) {
    console.log(`[ConvHistory] Fetching conversation history between user ${userDid} and bot ${botDid}, limit ${historyLimit}`);
    const allRelevantPosts = [];
    // Fetch slightly more posts than needed to account for filtering
    const fetchLimitPerActor = Math.min(100, historyLimit + 25);

    const botHandle = this.config.BLUESKY_IDENTIFIER; // Assuming this is the bot's handle

    // Helper to fetch and filter one actor's feed
    const fetchAndFilterActorFeed = async (actorToFetchDid, otherActorDid, otherActorHandleToMatch) => {
      let cursor;
      const actorPosts = [];
      let fetchedCount = 0;
      const maxAttempts = 3; // Max pages to fetch to avoid long loops if history is sparse
      let attempts = 0;

      while (fetchedCount < fetchLimitPerActor && attempts < maxAttempts) {
        attempts++;
        try {
          console.log(`[ConvHistory] Fetching feed for ${actorToFetchDid}, limit: ${fetchLimitPerActor}, attempt: ${attempts}, cursor: ${cursor}`);
          const response = await this.agent.api.app.bsky.feed.getAuthorFeed({
            actor: actorToFetchDid,
            limit: fetchLimitPerActor, // Request a decent number each time
            cursor: cursor,
            filter: 'posts_with_replies'
          });

          if (!response.success || !response.data.feed) {
            console.warn(`[ConvHistory] Failed to fetch feed or empty feed for ${actorToFetchDid}`);
            break;
          }

          for (const item of response.data.feed) {
            if (!item.post || !item.post.record) continue;

            const postRecord = item.post.record;
            const postAuthorDid = item.post.author.did;
            const postAuthorHandle = item.post.author.handle;
            const postText = postRecord.text || "";
            const createdAt = postRecord.createdAt;
            const postUri = item.post.uri;

            let isRelevant = false;

            // 1. Check for direct replies
            if (postRecord.reply) {
              const parentPostUri = postRecord.reply.parent?.uri;
              if (parentPostUri) {
                // We need to check if the parent post was authored by the otherActorDid
                // The `item.reply.parent.author.did` might not always be populated directly in getAuthorFeed.
                // A more robust check might involve fetching the parent post, but that's expensive.
                // Let's assume if `reply.parent.author.did` is available, we use it.
                // Otherwise, we might rely on mentions if the reply structure is not fully detailed.
                // For now, we'll be optimistic or rely on mentions as a fallback.
                // A common pattern is that the reply object in the feed item *does* contain parent author info.
                if (item.reply?.parent?.author?.did === otherActorDid) {
                  isRelevant = true;
                  console.log(`[ConvHistory] Relevant reply found: ${postUri} from ${postAuthorHandle} to ${otherActorHandleToMatch}`);
                }
              }
            }

            // 2. Check for mentions (if not already marked as a relevant reply)
            if (!isRelevant && postRecord.facets) {
              for (const facet of postRecord.facets) {
                if (facet.features) {
                  for (const feature of facet.features) {
                    if (feature.$type === 'app.bsky.richtext.facet#mention') {
                      // feature.did should be the DID of the mentioned user
                      if (feature.did === otherActorDid) {
                        isRelevant = true;
                        console.log(`[ConvHistory] Relevant mention found: ${postUri} from ${postAuthorHandle} mentions ${otherActorHandleToMatch}`);
                        break;
                      }
                    }
                  }
                }
                if (isRelevant) break;
              }
            }

            // 3. Alternative check for mentions if DID isn't in facet (less reliable but a fallback)
            // This is more of a heuristic if the DID isn't available in the facet.
            if (!isRelevant && postText.includes(`@${otherActorHandleToMatch}`)) {
                 // This could lead to false positives if the handle is mentioned but not as a user mention facet.
                 // Only use this if other checks fail and you accept potential inaccuracies.
                 // For now, let's be conservative and rely on facet DIDs or reply structures.
                 // console.log(`[ConvHistory] Potential relevant text mention: ${postUri} from ${postAuthorHandle} includes @${otherActorHandleToMatch}`);
                 // isRelevant = true; // Uncomment with caution
            }


            if (isRelevant) {
              const postToAdd = { // Changed variable name to avoid conflict if currentPost is used elsewhere
                uri: postUri,
                cid: item.post.cid, // <<< Ensure CID is captured here
                text: postText,
                authorDid: postAuthorDid,
                authorHandle: postAuthorHandle,
                createdAt: createdAt,
                embedDetails: null, // Initialize embedDetails
              };

              // Temporarily commenting out complex embed processing to isolate syntax error
              // Removed /*
              if (item.post.embed) {
                const embed = item.post.embed;
                if (embed.$type === 'app.bsky.embed.images#view' || embed.$type === 'app.bsky.embed.images') {
                  postToAdd.embedDetails = {
                    type: 'images',
                    images: embed.images?.map(img => ({
                      alt: img.alt || '',
                      cid: img.image?.cid || img.cid || null,
                      thumb: img.thumb || null,
                      fullsize: img.fullsize || null
                    })) || []
                  };
                } else if (embed.$type === 'app.bsky.embed.external#view' || embed.$type === 'app.bsky.embed.external') {
                  postToAdd.embedDetails = {
                    type: 'external',
                    external: {
                      uri: embed.external?.uri || embed.uri || '',
                      title: embed.external?.title || embed.title || '',
                      description: embed.external?.description || embed.description || ''
                    }
                  };
                } else if (embed.$type === 'app.bsky.embed.record#view' || embed.$type === 'app.bsky.embed.record') {
                  const embeddedRec = embed.record;
                  if (embeddedRec) {
                     postToAdd.embedDetails = {
                        type: 'record',
                        record: {
                          uri: embeddedRec.uri || '',
                          cid: embeddedRec.cid || '',
                          authorHandle: embeddedRec.author?.handle || '',
                          textSnippet: (embeddedRec.value?.text && typeof embeddedRec.value.text === 'string' ? embeddedRec.value.text.substring(0,100) : (typeof embeddedRec.value === 'string' ? embeddedRec.value.substring(0,100) : ''))
                        }
                     };
                  }
                } else if (embed.$type === 'app.bsky.embed.recordWithMedia#view' || embed.$type === 'app.bsky.embed.recordWithMedia') {
                  postToAdd.embedDetails = { type: 'recordWithMedia', record: null, media: null };
                  if (embed.record && (embed.record.$type === 'app.bsky.embed.record#view' || embed.record.$type === 'app.bsky.embed.record')) {
                     const embeddedRec = embed.record.record;
                     if (embeddedRec) {
                        postToAdd.embedDetails.record = {
                           uri: embeddedRec.uri || '',
                           cid: embeddedRec.cid || '',
                           authorHandle: embeddedRec.author?.handle || '',
                           textSnippet: (embeddedRec.value?.text && typeof embeddedRec.value.text === 'string' ? embeddedRec.value.text.substring(0,100) : (typeof embeddedRec.value === 'string' ? embeddedRec.value.substring(0,100) : ''))
                        };
                     }
                  }
                  if (embed.media) {
                    if (embed.media.$type === 'app.bsky.embed.images#view' || embed.media.$type === 'app.bsky.embed.images') {
                      postToAdd.embedDetails.media = {
                        type: 'images',
                        images: embed.media.images?.map(img => ({
                          alt: img.alt || '',
                          cid: img.image?.cid || img.cid || null,
                          thumb: img.thumb || null,
                          fullsize: img.fullsize || null
                        })) || []
                      };
                    } else if (embed.media.$type === 'app.bsky.embed.external#view' || embed.media.$type === 'app.bsky.embed.external') {
                      postToAdd.embedDetails.media = {
                        type: 'external',
                        external: {
                          uri: embed.media.external?.uri || embed.media.uri || '',
                          title: embed.media.external?.title || embed.media.title || '',
                          description: embed.media.external?.description || embed.description || ''
                        }
                      };
                    }
                  }
                }
              }
              // Removed */
              actorPosts.push(postToAdd);
              fetchedCount++;
            } // Ensures if(isRelevant) is properly closed here
          } // Closes 'for (const item of response.data.feed)'

          cursor = response.data.cursor;
          if (!cursor || response.data.feed.length === 0) {
            console.log(`[ConvHistory] No more posts or cursor for ${actorToFetchDid}. Fetched ${actorPosts.length} relevant posts so far.`);
            break; // Exit if no cursor or no new posts
          }
          if (actorPosts.length >= fetchLimitPerActor) { // If we have enough relevant posts
             console.log(`[ConvHistory] Sufficient relevant posts collected for ${actorToFetchDid} (${actorPosts.length}).`);
             break;
          }

        } catch (error) {
          console.error(`[ConvHistory] Error fetching feed for ${actorToFetchDid}:`, error);
          break; // Exit on error
        }
      }
      return actorPosts;
    };

    // We need the user's handle to check if the bot mentioned the user by handle (less reliable than DID)
    // This requires an extra API call if we don't have it. Assuming `post.author.handle` is available from the triggering post.
    // For now, we will primarily rely on DID matching in facets and reply parent author DIDs.
    // Let's assume the calling context (`generateResponse`) has `post.author.handle`.
    // For now, we'll assume `this.config.BLUESKY_IDENTIFIER` is the bot's handle.
    // And we'll need the user's handle to check bot's mentions of the user.
    // This is tricky because getAuthorFeed items don't always resolve handles for mentions if only DIDs are present.
    // Let's refine the logic to pass the handles too.

    let userHandle = ''; // We need this. Let's try to get it.
    try {
        const userProfile = await this.agent.getProfile({actor: userDid});
        if (userProfile && userProfile.data && userProfile.data.handle) {
            userHandle = userProfile.data.handle;
        } else {
            console.warn(`[ConvHistory] Could not fetch handle for user DID ${userDid}`);
        }
    } catch (e) {
        console.error(`[ConvHistory] Error fetching profile for user DID ${userDid} to get handle:`, e);
    }
    if (!userHandle) { // Fallback if API call fails or no handle
        console.warn(`[ConvHistory] User handle for ${userDid} is unknown. Mention filtering might be less effective.`);
        // We could try to extract it from the `post` object passed to `generateResponse` if that's feasible
        // For now, proceeding without it means mention filtering from bot to user might be impaired if only handle is used.
    }


    const userPostsFiltered = await fetchAndFilterActorFeed(userDid, botDid, botHandle);
    const botPostsFiltered = await fetchAndFilterActorFeed(botDid, userDid, userHandle || "user"); // Pass userHandle if available

    allRelevantPosts.push(...userPostsFiltered);
    allRelevantPosts.push(...botPostsFiltered);

    // Deduplicate posts based on URI
    const uniquePosts = Array.from(new Map(allRelevantPosts.map(p => [p.uri, p])).values());

    // Sort by creation date (newest first)
    uniquePosts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Limit to the most recent `historyLimit` posts
    const finalHistory = uniquePosts.slice(0, historyLimit);

    console.log(`[ConvHistory] Found ${uniquePosts.length} unique relevant posts. Returning ${finalHistory.length} for history.`);
    return finalHistory;
  }

  async searchBotMediaGallery(keywords, limit) {
    console.log(`[BotMediaSearch] Searching bot's own media gallery. Keywords: ${JSON.stringify(keywords)}, Limit: ${limit}`);
    const botDid = this.agent.did;
    const matchingPosts = [];
    let cursor = undefined;
    const fetchPageLimit = 50; // How many to fetch per API call
    let fetchedImagePostsCount = 0; // Count of posts with images we've processed enough of
    const maxApiPages = 3; // Limit API calls to avoid excessive scanning for very broad searches
    let apiPagesCalled = 0;

    try {
      while (apiPagesCalled < maxApiPages && (matchingPosts.length < limit || fetchedImagePostsCount < limit * 2 /* fetch a bit more to sort from */) ) {
        apiPagesCalled++;
        console.log(`[BotMediaSearch] Fetching bot's feed page ${apiPagesCalled}. Cursor: ${cursor}`);
        const response = await this.agent.api.app.bsky.feed.getAuthorFeed({
          actor: botDid,
          limit: fetchPageLimit,
          cursor: cursor
        });

        if (!response.success || !response.data.feed || response.data.feed.length === 0) {
          console.log("[BotMediaSearch] No more posts in bot's feed or API error.");
          break;
        }

        for (const item of response.data.feed) {
          if (!item.post || !item.post.record || item.post.author.did !== botDid) {
            continue; // Should always be bot's post, but double check
          }

          const postRecord = item.post.record;
          const embed = item.post.embed;
          let postImages = [];

          if (embed) {
            if (embed.$type === 'app.bsky.embed.images#view' || embed.$type === 'app.bsky.embed.images') {
              postImages = embed.images?.map(img => ({
                alt: img.alt || '',
                cid: img.image?.cid || img.cid || (typeof img.image === 'object' ? img.image.ref?.toString() : null) || null,
              })) || [];
            } else if (embed.$type === 'app.bsky.embed.recordWithMedia#view' || embed.$type === 'app.bsky.embed.recordWithMedia') {
              if (embed.media && (embed.media.$type === 'app.bsky.embed.images#view' || embed.media.$type === 'app.bsky.embed.images')) {
                postImages = embed.media.images?.map(img => ({
                  alt: img.alt || '',
                  cid: img.image?.cid || img.cid || (typeof img.image === 'object' ? img.image.ref?.toString() : null) || null,
                })) || [];
              }
            }
          }

          if (postImages.length > 0) {
            fetchedImagePostsCount++;
            const postTextLower = (postRecord.text || "").toLowerCase();
            const altTextsLower = postImages.map(img => (img.alt || "").toLowerCase()).join(" ");
            const combinedTextForSearch = `${postTextLower} ${altTextsLower}`;

            let keywordsMatch = true;
            if (keywords && keywords.length > 0) {
              keywordsMatch = keywords.every(kw => combinedTextForSearch.includes(kw.toLowerCase()));
            }

            if (keywordsMatch) {
              matchingPosts.push({
                uri: item.post.uri,
                cid: item.post.cid, // Capture the CID of the post
                text: postRecord.text || "",
                authorHandle: item.post.author.handle, // Bot's handle
                authorDid: item.post.author.did,     // Bot's DID
                createdAt: postRecord.createdAt,
                embedDetails: { type: 'images', images: postImages } // Store extracted image info
              });
              if (matchingPosts.length >= limit) break; // Found enough
            }
          }
        }
        if (matchingPosts.length >= limit) break;

        cursor = response.data.cursor;
        if (!cursor) {
          console.log("[BotMediaSearch] No more cursor from bot's feed.");
          break;
        }
      }
    } catch (error) {
      console.error(`[BotMediaSearch] Error searching bot's media gallery:`, error);
    }

    // Sort by creation date (newest first) - already fetched in this order generally, but good to ensure
    matchingPosts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const finalResults = matchingPosts.slice(0, limit);
    console.log(`[BotMediaSearch] Found ${finalResults.length} matching image posts in bot's gallery.`);
    return finalResults;
  }

  async performWebSearch(searchQuery, freshness = null) {
    console.log(`[WebSearch] Performing web search for query: "${searchQuery}", Freshness: ${freshness}`);
    if (!this.config.LANGSEARCH_API_KEY) {
      console.error("[WebSearch] LANGSEARCH_API_KEY is not set. Cannot perform web search.");
      return [];
    }

    const requestBody = {
      query: searchQuery,
      summary: true, // Request summaries
      count: 3       // Request 3 results
    };
    if (freshness && ["oneDay", "oneWeek", "oneMonth"].includes(freshness)) { // Basic validation for freshness
      requestBody.freshness = freshness; // Keep freshness if provided
    }

    try {
      const response = await fetch('https://api.langsearch.com/v1/web-search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.LANGSEARCH_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[WebSearch] LangSearch API error: ${response.status} - ${errorText}`);
        return [];
      }

      const searchData = await response.json(); // Assuming the top-level response is SearchData

      // Log query context if available
      if (searchData.queryContext) {
        console.log(`[WebSearch] Query Context: Original Query - "${searchData.queryContext.originalQuery}"`);
      }

      if (searchData.webPages && searchData.webPages.value && searchData.webPages.value.length > 0) {
        // The 'count' parameter should mean we don't need to slice here if the API respects it.
        // However, to be safe and match old behavior of taking max 3, we can still slice or rely on API's count.
        // For now, let's assume API returns 'count' items.
        const results = searchData.webPages.value.map(page => ({
          title: page.name || "No title",
          url: page.url,
          displayUrl: page.displayUrl || page.url, // Add displayUrl
          snippet: page.snippet || "No snippet available.",
          summary: page.summary || null, // Extract summary
          datePublished: page.datePublished || null,
          dateLastCrawled: page.dateLastCrawled || null,
          // id: page.id // id might be useful for debugging or future features
        }));
        console.log(`[WebSearch] Found ${results.length} results for query "${searchQuery}". Estimated total matches: ${searchData.webPages.totalEstimatedMatches || 'N/A'}`);
        if (searchData.webPages.someResultsRemoved) {
            console.warn("[WebSearch] Some results were removed due to restrictions.");
        }
        return results;
      } else {
        console.log(`[WebSearch] No web page results found for query "${searchQuery}"`);
        return [];
      }
    } catch (error) {
      console.error(`[WebSearch] Exception during web search for query "${searchQuery}":`, error);
      return [];
    }
  }

  async getSearchHistoryIntent(userQueryText) { // Renaming from getSearchHistoryIntent
    if (!userQueryText || userQueryText.trim() === "") {
      return { intent: "none" };
    }
    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    const systemPromptContent = `Your task is to analyze the user's query to determine if it's a request to find a specific item from past interactions OR a general question that could be answered by a web search.
You will also be used to determine if an image-based query should trigger OCR and search.
Output a JSON object. Choose ONE of the following intent structures:

PRIORITY 1: Explicit Image Generation Command:
- If the query is a direct command to GENERATE, CREATE, DRAW, OR MAKE an image (e.g., "generate an image of X", "draw me Y", "create a picture of Z", "make an artwork showing..."), output:
  {\\"intent\\": \\"none\\", \\"reason\\": \\"image_generation_command\\"}

PRIORITY 2: Bot Self-Help/Capabilities Query:
- If the user is asking about your (the bot's) capabilities, features, how to use you, or asking for help with how you work (e.g., "what can you do?", "how do I use the meme feature?", "help with bot commands"):
{
  "intent": "read_readme_for_self_help",
  "user_query_about_bot": "the user's original question about your capabilities"
}

PRIORITY 3: If not an image generation or self-help command, then consider other intents:
1. If searching PAST INTERACTIONS (conversation history, bot's gallery) for something specific the user or bot previously posted or saw:
{
  "intent": "search_history",
  "target_type": "image" | "link" | "post" | "message" | "unknown",
  "author_filter": "user" | "bot" | "any",
  "keywords": ["keyword1", ...],
  "recency_cue": "textual cue for recency" | null,
  "search_scope": "bot_gallery" | "conversation" | null
}
   - "target_type": "image" if user asks to FIND/SEARCH FOR an "image", "picture", "photo" they or you posted/saw.
   - "keywords": EXCLUDE image generation verbs like "generate", "create", "draw", "make".

2. If it's a GENERAL QUESTION *clearly asking for external information* that can be answered by a WEB SEARCH (including requests to find generic images not tied to conversation history):
{
  "intent": "web_search",
  "search_query": "optimized query for web search engine",
  "search_type": "webpage" | "image",
  "freshness_suggestion": "oneDay" | "oneWeek" | "oneMonth" | null
}
   - Only use "web_search" if the user is explicitly asking a question that requires looking up external facts, current events, or generic images NOT related to conversation history.
   - Simple statements, observations, or replies in a conversation should generally NOT be a "web_search".
   - "search_type": "image" if user asks for a generic image (e.g., "show me pictures of cats", "find images of Mars").

3. If asking for NASA's Astronomy Picture of the Day (APOD):
{
  "intent": "nasa_apod",
  "date": "YYYY-MM-DD" | "today" | null
}
4. If asking to create a meme using Imgflip templates:
{
  "intent": "create_meme",
  "template_query": "drake" | "181913649" | "list" | null, "captions": ["top text", ...], "generate_captions": true | false
}
5. If the user explicitly asks you to SEARCH or FIND a YouTube video on a topic:
{
  "intent": "youtube_search",
  "search_query": "optimized query for YouTube video search"
}
6. If the user explicitly asks you to SEARCH or FIND a GIF from GIPHY on a topic (e.g., using terms like "gif of", "giphy", "find a gif"):
{
  "intent": "giphy_search",
  "search_query": "keywords for GIPHY search"
}
7. If NEITHER of the above specific intents fit (and it's not an image generation or self-help command), OR if the query is a general statement, observation, or conversational reply not explicitly asking for external information, output:
{\\"intent\\": \\"none\\"}


IMPORTANT RULES for "search_history":
- "target_type": "image" if the user is asking to FIND or REMEMBER a specific "image", "picture", "photo", "screenshot" that was previously seen, posted, or generated in the conversation or gallery.
- "author_filter": "user" (they sent/posted), "bot" (you sent/generated/posted), or "any".
- "keywords": Core content terms for the search. EXCLUDE recency cues (e.g., "yesterday") AND type words (e.g., "image", "link") AND image generation verbs. Max 5.
- "recency_cue": Time phrases (e.g., "yesterday", "last week"). Null if none.
- "search_scope": For "target_type": "image" AND "author_filter": "bot": If user asks for an image bot *previously created/generated* and not explicitly tied to a direct reply/chat, prefer "bot_gallery". If 'sent me' or part of shared chat, "conversation". Default "conversation" if ambiguous. Null otherwise.

IMPORTANT RULES for "web_search":
- Use "web_search" ONLY for explicit questions needing external knowledge (e.g., "What is X?", "How does Y work?", "Show me Z pictures") or very clear implicit requests for such information.
- Conversational statements (e.g., "I think X is interesting", "That's cool", "Yes, I agree") should result in {"intent": "none"}.
- Observations about the bot itself (e.g., "You seem to be working better now", "You can do many things") should result in {"intent": "none"} unless they are direct questions about capabilities (which would be \\\`read_readme_for_self_help\\\`).
- "search_query": Essence of user's question. For news from a source (e.g., "recent news from NBC"), simplify to "[Source] news". For generic images, this is the image subject.
- "search_type": Set to "image" if the user is asking for generic images (e.g., "find pictures of sunsets", "show me a photo of a dog"). Otherwise, "webpage".
- "freshness_suggestion": For "recent", "latest", "today", "this week", "this month", suggest "oneDay", "oneWeek", "oneMonth". Smallest sensible period. Null if no strong cue.

CLARIFICATION ON IMAGE REQUESTS:
- "Generate an image of a cat" -> { "intent": "none", "reason": "image_generation_command" }
- "Find the image of a cat we were talking about yesterday" -> { "intent": "search_history", "target_type": "image", ... }
- "Show me pictures of cats" -> { "intent": "web_search", "search_type": "image", "search_query": "cats" }

NEW EXAMPLES to guide "none" intent for conversational statements:
User Query: "I think your new autonomous API call feature is pretty neat."
Your JSON Output: {\"intent\": \"none\"}

User Query: "The weather is nice today."
Your JSON Output: {\"intent\": \"none\"}

User Query: "Yes, that makes sense." (in reply to the bot)
Your JSON Output: {\"intent\": \"none\"}

User Query: "Okay, I will test that scenario now."
Your JSON Output: {\"intent\": \"none\"}

Output ONLY the JSON object.`;
    // System prompt shortened for diff display

    const userPromptContent = `User query: '${userQueryText}'`;
    const defaultErrorResponse = { intent: "none", error: "Intent classification failed." };

    try {
      console.log(`[IntentClassifier] Calling ${modelId} (getIntent) for query: "${userQueryText.substring(0,100)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPromptContent },
            { role: "user", content: userPromptContent }
          ],
          temperature: 0.2, max_tokens: 200,
          stream: false
        }),
        customTimeout: 90000 // 90s
      });

      console.log(`[IntentClassifier] ${modelId} (getIntent) response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IntentClassifier] NIM CALL ERROR: API error ${response.status} for model ${modelId} in getIntent: ${errorText}`);
        return { ...defaultErrorResponse, error: `API error ${response.status}: ${errorText.substring(0,100)}` };
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        let rawContent = data.choices[0].message.content.trim();
        console.log(`[IntentClassifier] ${modelId} raw response (getIntent): "${rawContent.substring(0,200)}..."`);

        const jsonRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
        const match = rawContent.match(jsonRegex);
        let jsonString = "";
        if (match && match[1]) {
          jsonString = match[1];
        } else if (rawContent.startsWith("{") && rawContent.endsWith("}")) {
          jsonString = rawContent;
        } else {
          const firstBrace = rawContent.indexOf('{');
          const lastBrace = rawContent.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            const potentialJson = rawContent.substring(firstBrace, lastBrace + 1);
            try { JSON.parse(potentialJson); jsonString = potentialJson; } catch (e) { /* ignore */ }
          }
        }

        if (jsonString) {
          console.log(`[IntentClassifier] ${modelId} extracted JSON string (getIntent): "${jsonString.substring(0,200)}..."`);
          try {
            const parsedJson = JSON.parse(jsonString);
            if (!parsedJson.intent) {
                console.warn(`[IntentClassifier] ${modelId} Parsed JSON missing 'intent' field in getIntent: ${jsonString}`);
                return { ...defaultErrorResponse, error: "Parsed JSON missing 'intent' field."};
            }
            // Simplified validation for brevity, assuming original validation logic was sound
            if (parsedJson.intent === "search_history") {
              if (!["image", "link", "post", "message", "unknown"].includes(parsedJson.target_type)) parsedJson.target_type = "unknown";
              if (!["user", "bot", "any"].includes(parsedJson.author_filter)) parsedJson.author_filter = "any";
              if (!Array.isArray(parsedJson.keywords)) parsedJson.keywords = [];
            } else if (parsedJson.intent === "web_search") {
              if (typeof parsedJson.search_query !== 'string' || !parsedJson.search_query.trim()) {
                 console.warn(`[IntentClassifier] ${modelId} 'web_search' missing search_query in getIntent: ${jsonString}`);
                 return { ...defaultErrorResponse, error: "Malformed web_search: missing search_query."};
              }
              if (!["webpage", "image"].includes(parsedJson.search_type)) parsedJson.search_type = "webpage";
            } else if (parsedJson.intent === "youtube_search" && (typeof parsedJson.search_query !== 'string' || !parsedJson.search_query.trim())) {
                 parsedJson.search_query = userQueryText.replace(`@${this.config.BLUESKY_IDENTIFIER}`, "").trim();
            } else if (parsedJson.intent === "giphy_search" && (typeof parsedJson.search_query !== 'string' || !parsedJson.search_query.trim())) {
                 parsedJson.search_query = userQueryText.replace(`@${this.config.BLUESKY_IDENTIFIER}`, "").replace(/giphy|gif/gi, "").trim();
            }

            console.log(`[IntentClassifier] ${modelId} parsed intent (getIntent):`, parsedJson);
            return parsedJson;
          } catch (e) {
            console.error(`[IntentClassifier] NIM CALL ERROR: Error parsing JSON from ${modelId} in getIntent: ${e.message}. JSON string: "${jsonString}"`);
            return { ...defaultErrorResponse, error: `JSON parsing error: ${e.message.substring(0,100)}` };
          }
        } else {
          console.error(`[IntentClassifier] NIM CALL ERROR: Could not extract JSON from ${modelId} response in getIntent. Raw: "${rawContent}"`);
          return { ...defaultErrorResponse, error: "Could not extract JSON from response." };
        }
      }
      console.error(`[IntentClassifier] NIM CALL ERROR: Unexpected response format from ${modelId} (getIntent). Data: ${JSON.stringify(data)}`);
      return { ...defaultErrorResponse, error: "Unexpected API response format." };
    } catch (error) {
        console.error(`[IntentClassifier] NIM CALL EXCEPTION: Error in getIntent with model ${modelId}: ${error.message}`);
        return { ...defaultErrorResponse, error: error.message };
    }
  }

  async shouldFetchProfileContext(userQueryText) {
    if (!userQueryText || userQueryText.trim() === "") return false;

    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    const systemPromptContent = "Your task is to determine if the user's query is primarily asking for an analysis, reflection, or information about themselves, their posts, their online personality, their Bluesky account, or their life, in a way that their recent Bluesky activity could provide relevant context. Respond with only the word YES or the word NO.";
    const userPromptContent = `User query: '${userQueryText}'`;

    try {
      console.log(`[IntentClassifier] Calling ${modelId} (shouldFetchProfileContext) for query: "${userQueryText.substring(0,100)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [ { role: "system", content: systemPromptContent }, { role: "user", content: userPromptContent } ],
          temperature: 0.1, max_tokens: 5, stream: false
        }),
        customTimeout: 90000 // 90s
      });
      console.log(`[IntentClassifier] ${modelId} (shouldFetchProfileContext) response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IntentClassifier] NIM CALL ERROR: API error ${response.status} for model ${modelId} in shouldFetchProfileContext: ${errorText}. Defaulting to false.`);
        return false;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toUpperCase();
        console.log(`[IntentClassifier] ${modelId} decision (shouldFetchProfileContext): "${decision}"`);
        return decision === 'YES';
      }
      console.error(`[IntentClassifier] NIM CALL ERROR: Unexpected response format from ${modelId} in shouldFetchProfileContext. Data: ${JSON.stringify(data)}. Defaulting to false.`);
      return false;
    } catch (error) {
      console.error(`[IntentClassifier] NIM CALL EXCEPTION: Error in shouldFetchProfileContext with model ${modelId}: ${error.message}. Defaulting to false.`);
      return false;
    }
  }

  async isRequestingDetails(userFollowUpText) {
    if (!userFollowUpText || userFollowUpText.trim() === "") return false;

    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    const systemPromptContent = "The user was previously asked if they wanted a detailed breakdown of a profile analysis. Does their current reply indicate they affirmatively want to see these details? Respond with only YES or NO.";
    const userPromptContent = `User reply: '${userFollowUpText}'`;

    try {
      console.log(`[IntentClassifier] Calling ${modelId} (isRequestingDetails) for follow-up: "${userFollowUpText.substring(0,100)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [ { role: "system", content: systemPromptContent }, { role: "user", content: userPromptContent } ],
          temperature: 0.1, max_tokens: 5, stream: false
        }),
        customTimeout: 90000 // 90s
      });
      console.log(`[IntentClassifier] ${modelId} (isRequestingDetails) response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IntentClassifier] NIM CALL ERROR: API error ${response.status} for model ${modelId} in isRequestingDetails: ${errorText}. Defaulting to false.`);
        return false;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toUpperCase();
        console.log(`[IntentClassifier] ${modelId} decision (isRequestingDetails): "${decision}"`);
        return decision === 'YES';
      }
      console.error(`[IntentClassifier] NIM CALL ERROR: Unexpected response format from ${modelId} in isRequestingDetails. Data: ${JSON.stringify(data)}. Defaulting to false.`);
      return false;
    } catch (error) {
      console.error(`[IntentClassifier] NIM CALL EXCEPTION: Error in isRequestingDetails with model ${modelId}: ${error.message}. Defaulting to false.`);
      return false;
    }
  }

  async generateImage(prompt) {
    const modelToUse = "black-forest-labs/FLUX.1-schnell-Free";
    const apiKey = this.config.TOGETHER_AI_API_KEY;
    if (!apiKey) { console.error('TOGETHER_AI_API_KEY is not configured. Cannot generate image.'); return null; }
    console.log(`TOGETHER AI CALL START: generateImage for model "${modelToUse}" with prompt "${prompt}"`);
    const requestBody = { model: modelToUse, prompt: prompt, n: 1, size: "1024x1024" };

    try {
      // Note: fetchWithRetries is for NIM; Together AI might have different retry/timeout needs.
      // For now, using direct fetch for Together AI as it wasn't the source of original timeouts.
      // If Together AI also shows instability, a similar wrapper might be needed for it.
      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody)
        // Consider adding a timeout here if direct fetch is kept, e.g., using AbortController
      });
      const responseStatus = response.status;
      // It's important to read response.text() or .json() only once.
      // Let's try to parse as JSON first, and if it fails, then use text.
      let responseBody;
      try {
        responseBody = await response.json();
      } catch (e) {
        // If .json() fails, try to get text (though for errors, text might be more useful)
        // This path is less likely if response.ok is false and API returns structured JSON error
        responseBody = await response.text();
      }

      console.log(`TOGETHER AI CALL END: generateImage - Status: ${responseStatus}`);

      if (!response.ok) {
        console.error(`Together AI API error (${responseStatus}) for generateImage with prompt "${prompt}". Response:`, responseBody);
        return null;
      }
      // Assuming responseBody is now parsed JSON if response.ok was true
      const data = responseBody;
      if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        const firstImageData = data.data[0];
        if (firstImageData.b64_json) {
          console.log(`Successfully received b64_json image data from Together AI for prompt "${prompt}".`);
          return firstImageData.b64_json;
        } else if (firstImageData.url) {
          console.log(`Received image URL from Together AI: ${firstImageData.url}. Attempting to download and convert to base64 for prompt "${prompt}".`);
          try {
            const base64Image = await utils.imageUrlToBase64(firstImageData.url);
            if (base64Image) { console.log(`Successfully downloaded and converted image from URL to base64 for prompt "${prompt}".`); return base64Image; }
            else { console.error(`Failed to convert image from URL to base64 for prompt "${prompt}". URL: ${firstImageData.url}`); return null; }
          } catch (urlConversionError) { console.error(`Error downloading or converting image from URL (${firstImageData.url}) for prompt "${prompt}":`, urlConversionError); return null; }
        }
      }
      console.error(`Unexpected response format or missing image data from Together AI for generateImage (prompt: "${prompt}"):`, JSON.stringify(data));
      return null;
    } catch (error) { console.error(`Error in LlamaBot.generateImage (prompt: "${prompt}"):`, error); return null; }
  }

  async isTextSafeScout(prompt) {
    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    const systemPromptContent = `${this.config.SAFETY_SYSTEM_PROMPT} You are an AI safety moderator. Analyze the following user text. If the text violates any of the safety guidelines (adult content, NSFW, copyrighted material, illegal content, violence, politics), respond with "unsafe". Otherwise, respond with "safe". Only respond with "safe" or "unsafe".`;

    try {
      console.log(`NIM CALL START: isTextSafe (using ${modelId}) for prompt "${prompt.substring(0, 50)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPromptContent },
            { role: "user", content: prompt }
          ],
          temperature: 0.1, max_tokens: 10, stream: false
        }),
        customTimeout: 90000 // 90s
      });
      console.log(`NIM CALL END: isTextSafe (using ${modelId}) for prompt "${prompt.substring(0, 50)}..." - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`NIM CALL ERROR: API error ${response.status} for model ${modelId} in isTextSafe: ${errorText}. Defaulting to unsafe.`);
        return false;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toLowerCase();
        console.log(`Safety check for text "${prompt.substring(0,50)}..." with ${modelId}: AI decision: "${decision}"`);
        return decision === 'safe';
      }
      console.error(`NIM CALL ERROR: Unexpected response format from ${modelId} in isTextSafe: ${JSON.stringify(data)}. Defaulting to unsafe.`);
      return false;
    } catch (error) {
      console.error(`NIM CALL EXCEPTION: Error in isTextSafe with model ${modelId} for prompt "${prompt.substring(0,50)}...": ${error.message}. Defaulting to unsafe.`);
      return false; // Default to unsafe on any exception
    }
  }

  async processImagePromptWithScout(user_prompt_text) { // Renaming to processImagePrompt, Scout no longer specific
    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
    const system_instruction = `${this.config.SAFETY_SYSTEM_PROMPT} You are an AI assistant. Analyze the following user text intended as a prompt for an image generation model.
1. First, determine if the user's text is safe according to the safety guidelines. The guidelines include: no adult content, no NSFW material, no copyrighted characters or concepts unless very generic, no illegal activities, no violence, no political content.
2. If the text is unsafe, respond with a JSON object: \`{ "safe": false, "reply_text": "I cannot generate an image based on that request due to safety guidelines. Please try a different prompt." }\`.
3. If the text is safe, extract the core artistic request. Rephrase it if necessary to be a concise and effective prompt for an image generation model like Flux.1 Schnell. The prompt should be descriptive and clear.
4. If safe, respond with a JSON object: \`{ "safe": true, "image_prompt": "your_refined_image_prompt_here" }\`.
Ensure your entire response is ONLY the JSON object.`;

    const defaultErrorResponse = { safe: false, reply_text: "Sorry, I encountered an issue processing your image request. Please try again later." };

    try {
      console.log(`NIM CALL START: processImagePrompt (using ${modelId}) for user_prompt "${user_prompt_text.substring(0,50)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [ { role: "system", content: system_instruction }, { role: "user", content: user_prompt_text } ],
          temperature: 0.3, max_tokens: 150, stream: false,
        }),
        customTimeout: 45000 // 45s
      });
      console.log(`NIM CALL END: processImagePrompt (using ${modelId}) - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`NIM CALL ERROR: API error ${response.status} for model ${modelId} in processImagePrompt: ${errorText}`);
        return { ...defaultErrorResponse, reply_text: `API Error: ${errorText.substring(0,100)}`};
      }
      const apiResponseText = await response.text();
      try {
        const apiData = JSON.parse(apiResponseText);
        if (apiData.choices && apiData.choices.length > 0 && apiData.choices[0].message && apiData.choices[0].message.content) {
          let rawContent = apiData.choices[0].message.content.trim();
          console.log(`NIM CALL RESPONSE: processImagePrompt (model ${modelId}) - Raw content: "${rawContent}"`);

          let jsonString = null;
          const markdownJsonRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
          const markdownMatch = rawContent.match(markdownJsonRegex);

          if (markdownMatch && markdownMatch[1]) {
            jsonString = markdownMatch[1].trim();
          } else {
            const firstBrace = rawContent.indexOf('{');
            const lastBrace = rawContent.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
              const potentialJson = rawContent.substring(firstBrace, lastBrace + 1);
              try { JSON.parse(potentialJson); jsonString = potentialJson; } catch (e) { /* ignore */ }
            }
            if (!jsonString) {
              const embeddedJsonRegex = /(?:^|\s|\[|\(|`)*(\{[\s\S]*?\})(?=\s*$|\s*|,|\]|\)|\.|`)/;
              const embeddedMatch = rawContent.match(embeddedJsonRegex);
              if (embeddedMatch && embeddedMatch[1]) { jsonString = embeddedMatch[1].trim(); }
            }
          }

          if (jsonString) {
             console.log(`NIM CALL RESPONSE: processImagePrompt (model ${modelId}) - Extracted JSON string: "${jsonString}"`);
            try {
              const decision = JSON.parse(jsonString); // Renamed from scoutDecision
              if (typeof decision.safe === 'boolean') {
                if (decision.safe === false && typeof decision.reply_text === 'string') return decision;
                if (decision.safe === true && typeof decision.image_prompt === 'string') return decision;
              }
              console.error(`NIM CALL ERROR: Unexpected JSON structure from ${modelId} in processImagePrompt: ${jsonString}`);
              return { ...defaultErrorResponse, reply_text: "Received unexpected JSON structure."};
            } catch (parseError) {
              console.error(`NIM CALL ERROR: Error parsing extracted JSON from ${modelId} in processImagePrompt: ${parseError.message}. JSON string: "${jsonString}". Original raw: "${rawContent}"`);
              return { ...defaultErrorResponse, reply_text: "Could not parse JSON response."};
            }
          } else {
            console.error(`NIM CALL ERROR: Could not extract JSON from ${modelId} response in processImagePrompt: "${rawContent}"`);
            return { ...defaultErrorResponse, reply_text: "Could not extract JSON from response string."};
          }
        } else {
          console.error(`NIM CALL ERROR: Unexpected API structure (missing choices/message/content) from ${modelId} in processImagePrompt: ${apiResponseText}`);
          return { ...defaultErrorResponse, reply_text: "API response structure was unexpected."};
        }
      } catch (apiJsonError) {
        console.error(`NIM CALL ERROR: Error parsing main API JSON from ${modelId} in processImagePrompt: ${apiJsonError.message}. Raw API response: ${apiResponseText}`);
        return { ...defaultErrorResponse, reply_text: "Could not parse main API JSON response."};
      }
    } catch (error) { // Catch errors from fetchWithRetries or other synchronous errors
      console.error(`NIM CALL EXCEPTION: Error in processImagePrompt with model ${modelId}: ${error.message}`);
      return { ...defaultErrorResponse, reply_text: error.message || defaultErrorResponse.reply_text };
    }
  }

  async describeImageWithScout(imageBase64) { // Renaming to describeImage
    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      console.error('describeImage: imageBase64 data is invalid or empty.');
      return null;
    }
    let mimeType = 'image/jpeg';
    if (imageBase64.startsWith('iVBORw0KGgo=')) mimeType = 'image/png';
    else if (imageBase64.startsWith('/9j/')) mimeType = 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const systemPromptContent = "You are an AI assistant. Your task is to describe the provided image for a social media post. Be descriptive, engaging, and try to capture the essence of the image. Keep your description concise, ideally under 200 characters, as it will also be used for alt text. Focus solely on describing the visual elements of the image.";
    const userPromptText = "Please describe this image.";
    // Caveat: Gemma's multimodal capabilities for image_url via NIM need confirmation.

    try {
      console.log(`NIM CALL START: describeImage (using ${modelId})`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [ { role: "system", content: systemPromptContent }, { role: "user", content: [ { type: "text", text: userPromptText }, { type: "image_url", image_url: { url: dataUrl } } ] } ],
          temperature: 0.5, max_tokens: 100, stream: false
        }),
        customTimeout: 90000 // 90s
      });
      console.log(`NIM CALL END: describeImage (using ${modelId}) - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`NIM CALL ERROR: API error ${response.status} for model ${modelId} in describeImage: ${errorText}`);
        return null;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const description = data.choices[0].message.content.trim();
        console.log(`NIM CALL RESPONSE: describeImage (model ${modelId}) - Description: "${description}"`);
        if (description && description.length > 5) {
          return description;
        } else {
          console.warn(`NIM CALL WARN: describeImage (model ${modelId}) received an empty or too short description: "${description}"`);
          return null;
        }
      }
      console.error(`NIM CALL ERROR: Unexpected response format from ${modelId} in describeImage: ${JSON.stringify(data)}`);
      return null;
    } catch (error) {
      console.error(`NIM CALL EXCEPTION: Error in describeImage with model ${modelId}: ${error.message}`);
      return null;
    }
  }

  async isImageSafeScout(imageBase64) { // Renaming to isImageSafe
    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      console.error('[VisualSafetyCheck] imageBase64 data is invalid or empty.');
      return false;
    }
    let mimeType = 'image/jpeg';
    if (imageBase64.startsWith('iVBORw0KGgo=')) mimeType = 'image/png';
    else if (imageBase64.startsWith('/9j/')) mimeType = 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;

    const systemPromptContent = `You are an AI visual safety moderator. For this image, which is a generated meme, focus primarily on identifying: adult content, NSFW, depictions of real-world violence or gore, hate speech symbols or imagery, and illegal activities. The use of recognizable characters or copyrighted elements, when clearly part of a known meme format or used in a transformative comedic way typical of internet memes, should generally be considered acceptable unless it directly promotes one of the aforementioned harmful categories. If strictly harmful content is present, respond with ONLY the word 'unsafe'. Otherwise, respond with ONLY the word 'safe'. Do not provide any other explanation or commentary.`;
    const userPromptText = "Please analyze this image for safety according to the guidelines.";
    // Caveat: Gemma's multimodal capabilities for image_url via NIM need confirmation.

    try {
      console.log(`[VisualSafetyCheck] NIM CALL START: isImageSafe (using ${modelId})`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPromptContent },
            { role: "user", content: [ { type: "text", text: userPromptText }, { type: "image_url", image_url: { url: dataUrl } } ] }
          ],
          temperature: 0.1, max_tokens: 10, stream: false
        }),
        customTimeout: 90000 // 90s
      });
      console.log(`[VisualSafetyCheck] NIM CALL END: isImageSafe (using ${modelId}) - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[VisualSafetyCheck] NIM CALL ERROR: API error ${response.status} for model ${modelId} in isImageSafe: ${errorText}. Defaulting to unsafe.`);
        return false;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toLowerCase();
        console.log(`[VisualSafetyCheck] (model ${modelId}) AI decision for image safety: "${decision}"`);
        return decision === 'safe';
      }
      console.error(`[VisualSafetyCheck] NIM CALL ERROR: Unexpected response format from ${modelId} in isImageSafe: ${JSON.stringify(data)}. Defaulting to unsafe.`);
      return false;
    } catch (error) {
      console.error(`[VisualSafetyCheck] NIM CALL EXCEPTION: Error in isImageSafe with model ${modelId}: ${error.message}. Defaulting to unsafe.`);
      return false;
    }
  }

  async performYouTubeSearch(searchQuery, maxResults = 1) {
    console.log(`[YouTubeSearch] Performing YouTube search for query: "${searchQuery}", maxResults: ${maxResults}`);
    if (!this.config.YOUTUBE_API_KEY) {
      console.error("[YouTubeSearch] YOUTUBE_API_KEY is not set. Cannot perform YouTube search.");
      return [];
    }

    const apiKey = this.config.YOUTUBE_API_KEY;
    const safeSearchSetting = 'moderate'; // Options: 'moderate', 'strict', 'none'

    let url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&part=snippet&type=video&safeSearch=${safeSearchSetting}&maxResults=${maxResults}&q=${encodeURIComponent(searchQuery)}`;

    try {
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) {
        const errorText = await response.text();
        let detail = errorText;
        try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.error && errorJson.error.message) {
                detail = errorJson.error.message;
            }
        } catch (e) { /* ignore parsing error if not json */ }
        console.error(`[YouTubeSearch] API error: ${response.status} - ${detail}`);
        return []; // Return empty array on error
      }

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        const results = data.items
          .filter(item => item.id && item.id.kind === "youtube#video" && item.id.videoId) // Ensure it's a video and has an ID
          .map(item => ({
            videoId: item.id.videoId,
            title: item.snippet?.title || "No title",
            description: item.snippet?.description || "No description",
            thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
            channelTitle: item.snippet?.channelTitle || "Unknown channel",
            videoUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`
          }));

        console.log(`[YouTubeSearch] Found ${results.length} video results for query "${searchQuery}".`);
        return results;
      } else {
        console.log(`[YouTubeSearch] No YouTube video results found for query "${searchQuery}".`);
        return [];
      }
    } catch (error) {
      console.error(`[YouTubeSearch] Exception during YouTube search for query "${searchQuery}":`, error);
      return []; // Return empty array on exception
    }
  }

  async searchGiphy(query, limit = 1) {
    console.log(`[GiphySearch] Searching Giphy for query: "${query}", Limit: ${limit}`);
    if (!this.config.GIPHY_API_KEY) {
      console.error("[GiphySearch] GIPHY_API_KEY is not set. Cannot perform Giphy search.");
      return [];
    }

    const apiKey = this.config.GIPHY_API_KEY;
    // Using 'pg-13' as a general-purpose rating. This could be made configurable.
    const rating = 'pg-13';
    const lang = 'en'; // Defaulting to English, could also be configurable.

    const params = new URLSearchParams({
      api_key: apiKey,
      q: query,
      limit: limit.toString(),
      offset: '0', // Starting from the first result
      rating: rating,
      lang: lang,
      bundle: 'messaging_non_clips' // Recommended bundle for most integrations
    });

    const url = `https://api.giphy.com/v1/gifs/search?${params.toString()}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GiphySearch] Giphy API error: ${response.status} - ${errorText}`);
        return [];
      }

      const data = await response.json();

      if (data.data && data.data.length > 0) {
        const results = data.data.map(gif => {
          let gifUrlToUse = null;
          let mimeType = null;

          // Prioritize GIF formats for animation
          if (gif.images?.downsized?.url) {
            gifUrlToUse = gif.images.downsized.url;
            mimeType = 'image/gif';
          } else if (gif.images?.original?.url) {
            // Check if original URL ends with .gif, Giphy sometimes returns non-gif in original.url
            if (gif.images.original.url.endsWith('.gif')) {
                gifUrlToUse = gif.images.original.url;
                mimeType = 'image/gif';
            }
          }

          // Fallback to WebP if no suitable GIF URL was found (might be static)
          if (!gifUrlToUse) {
            if (gif.images?.original?.webp) {
              gifUrlToUse = gif.images.original.webp;
              mimeType = 'image/webp';
            } else if (gif.images?.fixed_height?.webp) {
              gifUrlToUse = gif.images.fixed_height.webp;
              mimeType = 'image/webp';
            }
          }

          return {
            id: gif.id,
            gifUrl: gifUrlToUse,
            pageUrl: gif.url || gif.bitly_url, // Giphy page URL for the GIF
            title: gif.title || query, // Use Giphy title or fallback to query
            altText: gif.title || `GIF for ${query}`, // Alt text for accessibility
            mimeType: mimeType
          };
        }).filter(gif => gif.gifUrl && gif.mimeType); // Ensure we have a URL and mimeType

        console.log(`[GiphySearch] Found ${results.length} GIF(s)/Image(s) for query "${query}".`);
        return results;
      } else {
        console.log(`[GiphySearch] No Giphy results found for query "${query}".`);
        return [];
      }
    } catch (error) {
      console.error(`[GiphySearch] Exception during Giphy search for query "${query}":`, error);
      return [];
    }
  }

  async getPersonaAlignment(postText, postAuthorHandle) {
    if (!postText || postText.trim() === "") {
      return { alignment: "neutral", theme: "empty post" };
    }

    // Using a specific, potentially faster model for this classification if desired,
    // or could use Nemotron with a very specific prompt.
    // For now, let's use a generic model like Gemma for this, with a focused system prompt.
    const modelId = 'google/gemma-3n-e4b-it';
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    const systemPromptForAlignment = `You are an AI content analyzer. Your task is to determine if a given Bluesky post aligns with the general persona, interests, likes, or dislikes of another AI, "Dearest Llama". Dearest Llama's persona is described as: "${this.config.TEXT_SYSTEM_PROMPT}".

Analyze the following post text by user @${postAuthorHandle}:
"${postText.substring(0, 500)}${postText.length > 500 ? '...' : ''}"

Based ONLY on Dearest Llama's persona description and the post text, decide the alignment:
1.  If the post discusses topics Dearest Llama would likely be very interested in, agree with, or find positive (based on its persona), output:
    {"alignment": "positive", "theme": "briefly describe the matching theme/topic, e.g., 'AI ethics discussion' or 'enthusiasm for llamas'"}
2.  If the post discusses topics Dearest Llama might be cautious about, want to offer a polite counter-perspective on, or generally 'dislikes' (based on its persona, avoiding aggression), output:
    {"alignment": "negative_cautious", "theme": "briefly describe the theme, e.g., 'concerns about AI misuse' or 'negativity towards open dialogue'"}
3.  Otherwise (if the post is neutral, irrelevant to the persona, or unclear), output:
    {"alignment": "neutral", "theme": "general content" | "unclear alignment"}

Respond ONLY with a single JSON object. Focus on strong alignments derived from the persona.
Do not infer likes/dislikes beyond what the persona description implies.
Example: If persona mentions liking "constructive dialogue", a post full of insults might be "negative_cautious" with theme "unconstructive communication".
Example: If persona mentions interest in "technology", a post about "new AI breakthroughs" might be "positive" with theme "AI breakthroughs".`;

    const userPromptForAlignment = `Post text by @${postAuthorHandle} for alignment check: "${postText.substring(0, 500)}${postText.length > 500 ? '...' : ''}"\n\nYour JSON output:`;

    const defaultResponse = { alignment: "neutral", theme: "alignment check failed" };

    try {
      console.log(`[PersonaAlign] Calling ${modelId} for post by @${postAuthorHandle}: "${postText.substring(0, 70)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPromptForAlignment },
            { role: "user", content: userPromptForAlignment }
          ],
          temperature: 0.3, // Lower temp for more deterministic classification
          max_tokens: 100,
          stream: false
        }),
        customTimeout: 90000 // 90s
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[PersonaAlign] API error (${response.status}) for model ${modelId}: ${errorText}`);
        return defaultResponse;
      }

      const data = await response.json();
      if (data.choices && data.choices[0].message && data.choices[0].message.content) {
        let rawContent = data.choices[0].message.content.trim();
        const jsonMatch = rawContent.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        let jsonString = jsonMatch ? jsonMatch[1] : (rawContent.startsWith("{") && rawContent.endsWith("}") ? rawContent : null);

        if (jsonString) {
          try {
            const parsedJson = JSON.parse(jsonString);
            if (parsedJson.alignment && parsedJson.theme) {
              console.log(`[PersonaAlign] Alignment for post by @${postAuthorHandle}: ${parsedJson.alignment}, Theme: ${parsedJson.theme}`);
              return parsedJson;
            }
            console.warn(`[PersonaAlign] Parsed JSON missing 'alignment' or 'theme': ${jsonString}`);
          } catch (e) {
            console.error(`[PersonaAlign] Error parsing JSON from ${modelId}: ${e.message}. JSON string: "${jsonString}"`);
          }
        } else {
            console.warn(`[PersonaAlign] Could not extract JSON from ${modelId} response: "${rawContent}"`)
        }
      } else {
        console.error(`[PersonaAlign] Unexpected response format from ${modelId}: ${JSON.stringify(data)}`);
      }
      return defaultResponse;
    } catch (error) {
      console.error(`[PersonaAlign] Exception in getPersonaAlignment with ${modelId}: ${error.message}`);
      return defaultResponse;
    }
  }

  async monitorBotFollowingFeed() {
    console.log('[BotFeedMonitor] Starting bot following feed monitor...');
    if (!this.botDisplayName) { // Check if bot's display name is available
      console.warn('[BotFeedMonitor] Bot DisplayName not fetched. Skipping bot following feed monitoring.');
      return;
    }

    // Use a dedicated set for processed posts from the bot's following feed
    const processedBotFeedPostsPath = path.join(process.cwd(), 'processed_bot_feed_posts.json');
    let processedBotFeedPosts = new Set();
    try {
      if (fs.existsSync(processedBotFeedPostsPath)) {
        const data = fs.readFileSync(processedBotFeedPostsPath, 'utf-8');
        processedBotFeedPosts = new Set(JSON.parse(data));
        console.log(`[BotFeedMonitor] Loaded ${processedBotFeedPosts.size} processed post URIs for bot's own following feed.`);
      }
    } catch (error) {
      console.error('[BotFeedMonitor] Error loading processed bot feed posts:', error);
    }

    const saveProcessedBotFeedPosts = () => {
      try {
        fs.writeFileSync(processedBotFeedPostsPath, JSON.stringify(Array.from(processedBotFeedPosts)), 'utf-8');
      } catch (error) {
        console.error('[BotFeedMonitor] Error saving processed bot feed posts:', error);
      }
    };

    const CHECK_INTERVAL_BOT_FEED = this.config.CHECK_INTERVAL_BOT_FEED; // Uses value from config.js

    while (true) {
      try {
        console.log(`[BotFeedMonitor] Checking for new posts from accounts followed by this bot (${this.config.BLUESKY_IDENTIFIER}).`);

        // Use existing getBotFollowingDids method which uses this.agent.did (bot's own DID)
        const botFollowsDids = await this.getBotFollowingDids();

        console.log(`[BotFeedMonitor] Bot follows ${botFollowsDids.length} accounts. Checking their feeds for mentions of '${this.botDisplayName}'.`);

        for (const followedUserDid of botFollowsDids) {
          console.log(`[BotFeedMonitor] Fetching feed for followed DID: ${followedUserDid}`);
          // No need to check if followedUserDid is the bot itself, as getBotFollowingDids likely doesn't return self.
          // But if it could, a check here would be: if (followedUserDid === this.agent.did) continue;

          let postsCursor;
          const { data: feedResponse } = await this.agent.api.app.bsky.feed.getAuthorFeed({
            actor: followedUserDid,
            limit: 20, // Check recent 20 posts per followed user
            // cursor: postsCursor; // Not managing deep pagination for each followed user for now to keep it simple
          });

          if (feedResponse && feedResponse.feed) {
            console.log(`[BotFeedMonitor] Found ${feedResponse.feed.length} items for DID: ${followedUserDid}`);
            for (const item of feedResponse.feed) {
              // Skip simple reposts (boosts)
              if (item.reason && item.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
                console.log(`[BotFeedMonitor] Skipping repost ${item.post.uri} by ${item.post.author.handle} (reposted by ${followedUserDid})`);
                // Also add to processed so we don't check it again if it appears through other means, though unlikely here.
                processedBotFeedPosts.add(item.post.uri);
                continue;
              }

              // Now, item.post is an original post or a quote post by followedUserDid
              if (!item.post || !item.post.record || item.post.author.did !== followedUserDid) {
                // This check ensures we are only processing posts authored by the person whose feed we are fetching,
                // which should be true if we've correctly filtered reposts of *other* people's content.
                // A quote post *is* authored by followedUserDid.
                if (item.post && item.post.author.did !== followedUserDid) {
                    console.log(`[BotFeedMonitor] Skipping post ${item.post.uri} because author ${item.post.author.handle} is not the followed user ${followedUserDid}. This might be a repost not caught by reason check.`);
                }
                continue;
              }

              const postObject = { // This is an original post or quote post by followedUserDid
                uri: item.post.uri,
                cid: item.post.cid,
                author: item.post.author, // Should be followedUserDid
                record: item.post.record,
              };

              if (processedBotFeedPosts.has(postObject.uri)) {
                continue;
              }

              const postText = postObject.record.text || "";
              console.log(`[BotFeedMonitor] Checking post ${postObject.uri} by ${postObject.author.handle}. Text: "${postText.substring(0, 50)}..."`);

              // Enhanced Content Matching
              let matchCondition = null; // e.g., "displayName", "did", "likeKeyword", "dislikeKeyword"
              let matchedTerm = null; // The specific term that was matched

              const postTextLower = postText.toLowerCase();

              // 1. Check for display name
              if (this.botDisplayName && this.botDisplayName.trim() !== "") {
                if (postTextLower.includes(this.botDisplayName.toLowerCase())) {
                  matchCondition = "displayName";
                  matchedTerm = this.botDisplayName;
                }
              }

              // 2. Check for handle (full or base) if no display name match
              if (!matchCondition && this.botHandle && this.botHandle.trim() !== "") {
                const handleBase = this.botHandle.split('.')[0];
                if (postTextLower.includes(this.botHandle.toLowerCase())) {
                  matchCondition = "handle";
                  matchedTerm = this.botHandle;
                } else if (postTextLower.includes(handleBase.toLowerCase())) {
                  matchCondition = "handleBase";
                  matchedTerm = handleBase;
                }
              }

              // 3. Check for DID mention in text (simple includes, facets might be more robust but complex)
              if (!matchCondition && postTextLower.includes(this.config.BLUESKY_IDENTIFIER)) { // BLUESKY_IDENTIFIER is bot's DID
                matchCondition = "did";
                matchedTerm = this.config.BLUESKY_IDENTIFIER;
              }
              // Note: A more robust DID check might involve parsing `record.facets` if mentions are linked DIDs.
              // For now, a simple text inclusion of the DID string.

              // Keyword checking loops removed.

              // If no direct mention, check for persona alignment
              if (!matchCondition) {
                const alignmentResult = await this.getPersonaAlignment(postText, postObject.author.handle);
                if (alignmentResult.alignment === "positive") {
                  matchCondition = "personaLike";
                  matchedTerm = alignmentResult.theme;
                } else if (alignmentResult.alignment === "negative_cautious") {
                  matchCondition = "personaDislike";
                  matchedTerm = alignmentResult.theme;
                }
                // If alignment is "neutral" or failed, matchCondition remains null, and post is skipped for proactive reply.
              }

              if (matchCondition) {
                console.log(`[BotFeedMonitor] SUCCESS: Post ${postObject.uri} by ${postObject.author.handle} matched condition '${matchCondition}' with term '${matchedTerm}'.`);

                if (await this.hasAlreadyReplied(postObject)) {
                  console.log(`[BotFeedMonitor] SKIP: Bot has already replied to ${postObject.uri}.`);
                  processedBotFeedPosts.add(postObject.uri);
                  continue;
                }

                if (!this._canSendProactiveReply(postObject.author.did)) {
                    console.log(`[BotFeedMonitor] SKIP: Proactive reply limit reached for user ${postObject.author.handle} (${postObject.author.did}) regarding post ${postObject.uri}.`);
                    processedBotFeedPosts.add(postObject.uri);
                    continue;
                }
                console.log(`[BotFeedMonitor] ACTION: Conditions met for replying to ${postObject.uri} due to '${matchCondition}' (term: '${matchedTerm}').`);
                const context = await this.getReplyContext(postObject);

                let systemPromptForReply = "";
                let userPromptForReply = "";

                switch (matchCondition) {
                  case "displayName":
                  case "handle":
                  case "handleBase":
                  case "did":
                    systemPromptForReply = `You are an AI assistant with the persona defined in the main system prompt. The user @${postObject.author.handle} (an account you follow) mentioned you (as "${matchedTerm}") in their post. Craft a helpful and relevant reply in your persona.`;
                    userPromptForReply = `Full Conversation Context (if any, oldest first):\n${context.map(p => `${p.author}: ${p.text ? p.text.substring(0, 200) + (p.text.length > 200 ? '...' : '') : ''}`).join('\n---\n')}\n\nUser @${postObject.author.handle}'s relevant post (that mentions you as "${matchedTerm}"):\n"${postText}"\n\nBased on this, generate a suitable reply in your defined persona.`;
                    break;
                  case "likeKeyword":
                    systemPromptForReply = `You are an AI assistant with the persona defined in the main system prompt. The user @${postObject.author.handle} (an account you follow) posted about a topic you like: "${matchedTerm}". Craft an engaging and positive reply in your persona.`;
                    userPromptForReply = `Full Conversation Context (if any, oldest first):\n${context.map(p => `${p.author}: ${p.text ? p.text.substring(0, 200) + (p.text.length > 200 ? '...' : '') : ''}`).join('\n---\n')}\n\nUser @${postObject.author.handle}'s relevant post (mentions a liked topic: "${matchedTerm}"):\n"${postText}"\n\nBased on this, generate a suitable positive and engaging reply in your defined persona.`;
                    break;
                  case "dislikeKeyword":
                    systemPromptForReply = `You are an AI assistant with the persona defined in the main system prompt. The user @${postObject.author.handle} (an account you follow) posted about a topic you generally dislike or are cautious about: "${matchedTerm}". Craft a nuanced and polite reply. You can offer a gentle counterpoint, a neutral observation, or shift the conversation if appropriate, all within your persona. Avoid being aggressive or overly negative.`;
                    userPromptForReply = `Full Conversation Context (if any, oldest first):\n${context.map(p => `${p.author}: ${p.text ? p.text.substring(0, 200) + (p.text.length > 200 ? '...' : '') : ''}`).join('\n---\n')}\n\nUser @${postObject.author.handle}'s relevant post (mentions a disliked/cautionary topic: "${matchedTerm}"):\n"${postText}"\n\nBased on this, generate a suitable nuanced and polite reply in your defined persona.`;
                    break;
                  default:
                    console.warn(`[BotFeedMonitor] Unknown matchCondition: ${matchCondition}. Skipping LLM call for ${postObject.uri}`);
                    continue; // Skip this post if condition is unknown
                }

                console.log(`[BotFeedMonitor] Generating response for post ${postObject.uri} based on matchCondition '${matchCondition}'.`);

                const nimResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                    body: JSON.stringify({
                        model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
                        messages: [
                            { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT} ${systemPromptForReply}` },
                            { role: "user", content: userPromptForReply }
                        ],
                        temperature: 0.7, max_tokens: 150, stream: false
                    }),
                    customTimeout: 120000 // 120s
                });

                if (nimResponse.ok) {
                    const nimData = await nimResponse.json();
                    if (nimData.choices && nimData.choices[0].message && nimData.choices[0].message.content) {
                        let responseText = nimData.choices[0].message.content.trim();
                        // Filter with Scout/Gemma
                        const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                            body: JSON.stringify({
                                model: 'meta/llama-3.2-90b-vision-instruct',
                                messages: [
                                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting...Output only the processed text." }, // Simplified for brevity
                                    { role: "user", content: responseText }
                                ],
                                temperature: 0.1, max_tokens: 100, stream: false
                            }),
                            customTimeout: 90000 // 90s
                        });
                        if (filterResponse.ok) {
                            const filterData = await filterResponse.json();
                            if (filterData.choices && filterData.choices[0].message) {
                                responseText = filterData.choices[0].message.content.trim();
                            }
                        }

                        if (responseText) {
                            await this.postReply(postObject, responseText);
                            this._recordProactiveReplyTimestamp(postObject.author.did);
                            console.log(`[BotFeedMonitor] Replied to bot mention in post ${postObject.uri}`);
                        }
                    }
                } else {
                    console.error(`[BotFeedMonitor] NIM API error generating response for bot mention: ${nimResponse.status}`);
                }
                processedBotFeedPosts.add(postObject.uri); // Use new set
              } else {
                const postDate = new Date(postObject.record.createdAt);
                const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
                if (postDate < twoDaysAgo) {
                    processedBotFeedPosts.add(postObject.uri); // Use new set
                }
              }
            }
          }
          await utils.sleep(2000);
        }
        saveProcessedBotFeedPosts(); // Use new save function
        console.log(`[BotFeedMonitor] Finished bot following feed scan. Waiting for ${CHECK_INTERVAL_BOT_FEED / 1000 / 60} minutes.`);
        await utils.sleep(CHECK_INTERVAL_BOT_FEED); // Use new interval variable
      } catch (error) {
        console.error('[BotFeedMonitor] Error in bot following feed monitoring loop:', error);
        await utils.sleep(CHECK_INTERVAL_BOT_FEED); // Use new interval variable
      }
    }
  }
} // Closes the LlamaBot class

// Initialize and run the bot
async function startBots() {
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const llamaBot = new LlamaBot({
    ...config,
    BLUESKY_IDENTIFIER: config.BLUESKY_IDENTIFIER,
    BLUESKY_APP_PASSWORD: config.BLUESKY_APP_PASSWORD,
  }, agent);

  llamaBot.monitor().catch(error => console.error('[MainMonitor] Main monitor crashed:', error));

  // Start the bot following feed monitor
  // No specific DID check needed here as it uses the bot's own DID which is always expected to be present.
  // However, it relies on this.botDisplayName being fetched.
  llamaBot.monitorBotFollowingFeed().catch(error => console.error('[BotFeedMonitor] Bot feed monitor crashed:', error));
}

startBots().catch(console.error);

//end of index.js
