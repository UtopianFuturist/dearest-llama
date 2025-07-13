import { AtpAgent } from '@atproto/api';
import config from './config.js';
import fetch from 'node-fetch';
import express from 'express';
import Sentiment from 'sentiment';

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
async function fetchWithRetries(url, options, maxRetries = 3, initialDelay = 5000, timeout = 30000) { // Increased initialDelay to 5s
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

  truncateResponse(text, maxLength = 290) {
    if (!text || text.length <= maxLength) return text;
    
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
    this.sentimentAnalyzer = new Sentiment();
    this.userBlocklist = new Set(); // Users who have issued !STOP
    this.mutedThreads = new Set(); // Root URIs of threads the bot should not reply to
    this.conversationLengths = new Map(); // Track conversation lengths with other bots
  }

  // Helper to cleanup expired pending analyses
  _cleanupExpiredDetailedAnalyses() {
    const now = Date.now();
    for (const [key, value] of this.pendingDetailedAnalyses.entries()) {
      if (now - value.timestamp > this.DETAIL_ANALYSIS_TTL) {
        this.pendingDetailedAnalyses.delete(key);
        console.log(`[CacheCleanup] Removed expired detailed analysis for post URI: ${key}`);
      }
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
      if (thread?.thread?.replies && thread.thread.replies.length > 0) {
        const hasReply = thread.thread.replies.some(reply => {
          if (reply && reply.post && reply.post.author && reply.post.author.handle) {
            return reply.post.author.handle === this.config.BLUESKY_IDENTIFIER;
          }
          console.warn(`[hasAlreadyReplied] Encountered reply with missing post, author, or handle for post.uri: ${post.uri}. Reply object:`, reply);
          return false; // Treat as not a reply from the bot if data is incomplete
        });
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
              // Likes tracking removed as per request.
              // The console.log statement logging the like event has been removed.
              // No other action was being taken on likes, so this effectively removes like tracking.
              continue; // Don't process 'like' notifications further for replies
            }

            // For other actionable types (reply, mention, quote)
            // Ensure the record is a post type we can handle, e.g. app.bsky.feed.post
            if (notif.record.$type !== 'app.bsky.feed.post') {
                console.log(`[Monitor] Skipping notification for non-post record type: ${notif.record.$type} from @${notif.author.handle}`);
                continue;
            }

            // Construct a 'post' object similar to what previous logic expected
            const postAuthorHandle = notif.author.handle;
            const postTextContent = notif.record.text || "";

            // Check for !STOP command from user
            if (await this.isStopRequest(postTextContent)) {
              const sentimentResult = this.sentimentAnalyzer.analyze(postTextContent);
              console.log(`[Monitor] !STOP command detected from @${postAuthorHandle}. Sentiment score: ${sentimentResult.score}`);
              // Block if sentiment is negative or neutral (score <= 0)
              // The 'sentiment' library scores range from negative to positive.
              // A score of 0 is neutral. Negative scores are < 0.
              if (sentimentResult.score <= 0) {
                this.userBlocklist.add(postAuthorHandle);
                const stopMessage = "You have been added to my blocklist and will no longer receive messages from me. You can use the `!RESUME` command if you change your mind.";
                console.log(`[Monitor] User @${postAuthorHandle} added to blocklist due to !STOP command with non-positive sentiment. Score: ${sentimentResult.score}`);

                // Send confirmation message about being blocked and how to resume
                const tempPostForStopReply = {
                  uri: notif.uri,
                  cid: notif.cid,
                  author: notif.author,
                  record: {
                    reply: {
                      root: { uri: notif.record?.reply?.root?.uri || notif.uri, cid: notif.record?.reply?.root?.cid || notif.cid },
                      parent: { uri: notif.uri, cid: notif.cid }
                    }
                  }
                };
                await this.postReply(tempPostForStopReply, stopMessage);
                this.repliedPosts.add(notif.uri); // Mark as replied
                continue;
              } else {
                console.log(`[Monitor] User @${postAuthorHandle} issued !STOP, but sentiment was positive (${sentimentResult.score}). Not adding to blocklist, and not replying to this specific !STOP message.`);
                // Still, do not process this '!STOP' message for a normal reply, and don't send any confirmation.
                this.repliedPosts.add(notif.uri);
                continue;
              }
            }

            // Check if user is on blocklist before any further processing
            if (this.userBlocklist.has(postAuthorHandle)) {
              console.log(`[Monitor] User @${postAuthorHandle} is on the blocklist. Ignoring their message: ${notif.uri}`);
              this.repliedPosts.add(notif.uri); // Mark as "handled" to prevent accidental processing
              continue;
            }

            // Determine thread root URI for potential muting or checking if muted
            let threadRootUri = notif.record?.reply?.root?.uri || notif.uri;
            if (notif.reason === 'quote') { // If it's a quote of the bot, the quote itself is the start of a new thread in terms of interaction
                threadRootUri = notif.uri;
            }


            // Check if thread is muted
            if (this.mutedThreads.has(threadRootUri)) {
              console.log(`[Monitor] Thread ${threadRootUri} is muted. Ignoring message: ${notif.uri} from @${postAuthorHandle}`);
              // No reply, just ignore. Mark as "replied" to prevent other processing.
              this.repliedPosts.add(notif.uri);
              continue;
            }

            // Check for !HELP command
            if (postTextContent.toLowerCase().trim() === '!help') {
              console.log(`[Monitor] !HELP command detected from @${postAuthorHandle}.`);
              const helpMessage = `I'm a conversational AI here to chat and answer questions!

For managing our conversation, you can use a few commands: \`!STOP\` if you'd like me to stop sending you messages, \`!RESUME\` to start them again, and \`!MUTE\` to stop me from replying in the current thread.`;
              // Construct a temporary post object for the postReply method
              const tempPostForHelpReply = {
                uri: notif.uri,
                cid: notif.cid,
                author: notif.author,
                record: { // Mock just enough of the record for postReply to work
                  reply: { // Ensure it's treated as a reply to the help request
                    root: { uri: notif.record?.reply?.root?.uri || notif.uri, cid: notif.record?.reply?.root?.cid || notif.cid },
                    parent: { uri: notif.uri, cid: notif.cid }
                  }
                }
              };
              await this.postReply(tempPostForHelpReply, helpMessage);
              this.repliedPosts.add(notif.uri); // Mark as replied
              continue;
            }

            // Check for !RESUME command
            if (await this.isResumeRequest(postTextContent)) {
              console.log(`[Monitor] !RESUME command detected from @${postAuthorHandle}.`);
              let resumeMessage = "";
              if (this.userBlocklist.has(postAuthorHandle)) {
                this.userBlocklist.delete(postAuthorHandle);
                resumeMessage = "Welcome back! You will now receive messages from me again.";
                console.log(`[Monitor] User @${postAuthorHandle} removed from blocklist.`);
              } else {
                resumeMessage = "Thanks for checking in! You were not on my blocklist.";
                console.log(`[Monitor] User @${postAuthorHandle} issued !RESUME but was not on blocklist.`);
              }
              const tempPostForResumeReply = {
                uri: notif.uri,
                cid: notif.cid,
                author: notif.author,
                record: {
                  reply: {
                    root: { uri: notif.record?.reply?.root?.uri || notif.uri, cid: notif.record?.reply?.root?.cid || notif.cid },
                    parent: { uri: notif.uri, cid: notif.cid }
                  }
                }
              };
              await this.postReply(tempPostForResumeReply, resumeMessage);
              this.repliedPosts.add(notif.uri); // Mark as replied
              continue;
            }

            // Check for !MUTE command
            if (await this.isMuteRequest(postTextContent)) {
              console.log(`[Monitor] !MUTE command detected from @${postAuthorHandle} in thread starting with ${threadRootUri}.`);
              this.mutedThreads.add(threadRootUri);
              const muteMessage = "Okay, I will not reply further in this thread. If you want me to speak here again, you'll need to mention me in a new thread or use a command in a different context.";

              const tempPostForMuteReply = {
                uri: notif.uri,
                cid: notif.cid,
                author: notif.author,
                record: {
                  reply: {
                    root: { uri: threadRootUri, cid: notif.record?.reply?.root?.cid || notif.cid }, // Ensure root is correct
                    parent: { uri: notif.uri, cid: notif.cid }
                  }
                }
              };
              await this.postReply(tempPostForMuteReply, muteMessage);
              this.repliedPosts.add(notif.uri); // Mark as replied
              continue;
            }

            // Check if the author is a bot and if the conversation is too long
            const profile = await this.agent.getProfile({ actor: postAuthorHandle });
            if (await this.isBot(postAuthorHandle, profile.data)) {
              const conversationLength = this.conversationLengths.get(threadRootUri) || 0;
              if (conversationLength > 3) {
                console.log(`[Monitor] Conversation with bot @${postAuthorHandle} in thread ${threadRootUri} is too long (${conversationLength} messages). Concluding conversation.`);
                await this.postReply({
                  uri: notif.uri,
                  cid: notif.cid,
                  author: notif.author,
                  record: {
                    reply: {
                      root: { uri: threadRootUri, cid: notif.record?.reply?.root?.cid || notif.cid },
                      parent: { uri: notif.uri, cid: notif.cid }
                    }
                  }
                }, "This conversation has become very long. I'm going to step away now, but feel free to start a new one!");
                this.mutedThreads.add(threadRootUri);
                this.repliedPosts.add(notif.uri);
                continue;
              }
            }

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
            if (currentPostObject.author.handle === this.config.ADMIN_BLUESKY_HANDLE &&
                currentPostObject.record.text &&
                currentPostObject.record.text.includes('!post')) {

              const commandText = currentPostObject.record.text;
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

            if (!isAdminCmdHandled) {
              if (await this.hasAlreadyReplied(currentPostObject)) { // Pass the full post object
                console.log(`[Monitor] Already replied to post ${currentPostObject.uri} or it's a like. Skipping.`);
                continue;
              }

              // Standard response generation for mentions, replies, quotes
              console.log(`[Monitor] Processing notification for post ${currentPostObject.uri} from @${currentPostObject.author.handle}, reason: ${notif.reason}`);
              const context = await this.getReplyContext(currentPostObject); // Pass the full post object
              const responseText = await this.generateResponse(currentPostObject, context); // Pass the full post object

              if (responseText) { // generateResponse may return null if it handles the reply itself (e.g., for embeds)
                await this.postReply(currentPostObject, responseText);
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
    } catch (error) {
      console.error('Authentication failed:', error);
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
      const extractImages = (record) => (record?.embed?.images || record?.embed?.media?.images || []).map(img => ({ alt: img.alt, url: img.fullsize || img.thumb }));
      conversation.push({ author: post.author.handle, text: post.record.text, images: extractImages(post.record) });
      if (post.record.embed?.$type === 'app.bsky.embed.record' && post.record.embed) {
        try {
          const uri = post.record.embed.record.uri;
          const matches = uri.match(/at:\/\/([^/]+)\/[^/]+\/([^/]+)/);
          if (matches) {
            const [_, repo, rkey] = matches;
            const quotedPostResponse = await this.agent.getPost({ repo, rkey });
            if (quotedPostResponse?.value) {
              const authorDid = matches[1];
              const postValue = quotedPostResponse.value;
              if (postValue.text) {
                const quotedImages = postValue.embed?.images || postValue.embed?.media?.images || [];
                conversation.unshift({ author: authorDid, text: postValue.text, images: quotedImages.map(img => ({ alt: img.alt, url: img.fullsize || img.thumb })) });
              }
            }
          }
        } catch (error) { console.error('Error fetching quoted post:', error); }
      }
      if (post.record?.reply) {
        let currentUri = post.record.reply.parent?.uri; // Start with the parent's URI
        let safetyCount = 0; // Prevent infinite loops

        while (currentUri && safetyCount < 5) { // Limit depth
          safetyCount++;
          try {
            const { data: thread } = await this.agent.getPostThread({ uri: currentUri, depth: 0, parentHeight: 0 }); // Fetch only the specific post
            const parentPostInThread = thread?.thread?.post;

            if (!parentPostInThread) break;

            if (parentPostInThread.record) {
              console.log(`[getReplyContext] Parent Loop: Processing parent URI ${parentPostInThread.uri}. Author DID: ${parentPostInThread.author.did}. Embed object:`, JSON.stringify(parentPostInThread.record.embed, null, 2));
            }

            let parentImages = [];
            const embed = parentPostInThread.record?.embed;
            if (embed && (embed.$type === 'app.bsky.embed.images' || embed.$type === 'app.bsky.embed.images#view') && embed.images) {
              parentImages = embed.images.map(img => {
                let imageUrl = null;
                if (img.fullsize) {
                  imageUrl = img.fullsize;
                } else if (img.thumb) {
                  imageUrl = img.thumb;
                } else if (img.image && img.image.ref && typeof img.image.ref.$link === 'string') {
                  // Most specific path first
                  console.log(`[getReplyContext Map Detail] Accessing img.image.ref.$link. img.image.ref object:`, JSON.stringify(img.image.ref));
                  imageUrl = `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${parentPostInThread.author.did}&cid=${img.image.ref.$link}`;
                } else if (img.image && typeof img.image.cid === 'string') {
                  console.log(`[getReplyContext Map Detail] Accessing img.image.cid. img.image object:`, JSON.stringify(img.image));
                   imageUrl = `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${parentPostInThread.author.did}&cid=${img.image.cid}`;
                } else if (img.image) {
                  console.warn(`[getReplyContext Map Detail] img.image exists for ${parentPostInThread.uri}, but expected CID paths (.ref.$link or .cid) not found. img.image:`, JSON.stringify(img.image));
                } else {
                  console.warn(`[getReplyContext Map Detail] img.image is missing for an image object in ${parentPostInThread.uri}. Img object:`, JSON.stringify(img));
                }
                console.log(`[getReplyContext Map] Img obj for ${parentPostInThread.uri}: CID via $link: ${img.image?.ref?.$link}, CID via .cid: ${img.image?.cid}, Author DID: ${parentPostInThread.author.did}, Constructed URL: ${imageUrl}`);
                return {
                  alt: img.alt || '',
                  url: imageUrl
                };
              }).filter(img => img.url); // Only keep images where a URL could be constructed
            }

            conversation.unshift({ // Add parent to the beginning of the array
              uri: parentPostInThread.uri,
              author: parentPostInThread.author.handle,
              text: parentPostInThread.record.text,
              images: parentImages
            });

            currentUri = parentPostInThread.record?.reply?.parent?.uri; // Move to next parent
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
      // Fallback with current post only, ensuring 'uri' is present for safety
      const extractImages = (record) => (record?.embed?.images || record?.embed?.media?.images || []).map(img => ({ alt: img.alt, url: img.fullsize || img.thumb }));
      return [{ uri: post.uri, author: post.author.handle, text: post.record.text, images: extractImages(post.record) }];
    }
  }

  async postReply(post, response, imageBase64 = null, altText = "Generated image", embedRecordDetails = null, externalEmbedDetails = null, imageMimeType = 'image/png') {
    try {
      RateLimit.check();
      const CHAR_LIMIT_PER_POST = 300; // Bluesky's actual limit

      let text = utils.truncateResponse(response, CHAR_LIMIT_PER_POST);

      const replyObject = {
        text: text,
        reply: {
          root: post.record?.reply?.root || { uri: post.uri, cid: post.cid },
          parent: { uri: post.uri, cid: post.cid }
        }
      };

      // Embed logic
      if (embedRecordDetails && embedRecordDetails.uri && embedRecordDetails.cid) {
        replyObject.embed = {
          $type: 'app.bsky.embed.record',
          record: {
            uri: embedRecordDetails.uri,
            cid: embedRecordDetails.cid
          }
        };
      } else if (externalEmbedDetails && externalEmbedDetails.uri && externalEmbedDetails.title && externalEmbedDetails.description) {
        replyObject.embed = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: externalEmbedDetails.uri,
            title: externalEmbedDetails.title,
            description: externalEmbedDetails.description
          }
        };
      } else if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
        const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
        if (imageBytes.length > 0) {
          const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: imageMimeType });
          if (uploadedImage && uploadedImage.data && uploadedImage.data.blob) {
            replyObject.embed = { $type: 'app.bsky.embed.images', images: [{ image: uploadedImage.data.blob, alt: altText }] };
          }
        }
      }

      console.log(`[postReply] Attempting to post single reply. Text: "${replyObject.text.substring(0,50)}..." Embed type: ${replyObject.embed ? replyObject.embed.$type : 'none'}`);
      const result = await this.agent.post(replyObject);
      console.log(`Successfully posted reply: ${result.uri}`);
      this.repliedPosts.add(post.uri);
      const threadRootUri = post.record?.reply?.root?.uri || post.uri;
      const conversationLength = (this.conversationLengths.get(threadRootUri) || 0) + 1;
      this.conversationLengths.set(threadRootUri, conversationLength);

      return { uris: [result.uri], lastCid: result.cid };
    } catch (error) {
      console.error('Error posting reply:', error);
      this.repliedPosts.add(post.uri);
      return { uris: [], lastCid: null };
    }
  }

  getModelName() {
    return 'Unknown Model';
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
    this.dailyProactiveReplyCounts = new Map(); // { userDid: { date: 'YYYY-MM-DD', count: N } }
    this.processedBotFeedPosts = new Set(); // Initialize Set for processed feed posts
    this.MAX_DAILY_PROACTIVE_REPLIES_PER_USER = 5; // Configurable: Max proactive replies to a single user per day
    this.MAX_REPLIES_PER_USER_PER_SCAN = 2; // As per commit: Max 2 proactive replies per user per scan
  }

  async isBot(handle, profile) {
    if (this.config.KNOWN_BOTS.includes(handle)) {
      return true;
    }
    if (handle.includes('bot')) {
      return true;
    }
    if (profile && profile.description && profile.description.toLowerCase().includes('bot')) {
      return true;
    }
    return false;
  }

  async isStopRequest(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('!stop')) {
      return true;
    }
    const stopWords = ['stop replying', 'don\'t reply', 'stop sending', 'no more messages', 'go away'];
    return stopWords.some(word => lowerText.includes(word));
  }

  async isResumeRequest(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('!resume')) {
      return true;
    }
    const resumeWords = ['start replying', 'start sending', 'resume messages', 'come back'];
    return resumeWords.some(word => lowerText.includes(word));
  }

  async isMuteRequest(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('!mute')) {
      return true;
    }
    const muteWords = ['mute this thread', 'stop replying here', 'don\'t reply in this thread'];
    return muteWords.some(word => lowerText.includes(word));
  }

  async generateStandalonePostFromContext(context, adminInstructions) {
    console.log('LlamaBot.generateStandalonePostFromContext called. Context (sample):', context ? JSON.stringify(context.slice(0,1)) : "null", 'Instructions:', adminInstructions);
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
      let nemotronResponseText = data.choices[0].message.content.trim();
      console.log(`[LlamaBot.generateStandalonePostFromContext] Initial response from nvidia/llama-3.3-nemotron-super-49b-v1: "${nemotronResponseText}"`);

      // The following two lines were a duplicate declaration and log, causing a SyntaxError. They have been removed.
      // let nemotronResponseText = data.choices[0].message.content.trim();
      // console.log(`[LlamaBot.generateStandalonePostFromContext] Initial response from nvidia/llama-3.3-nemotron-super-49b-v1: "${nemotronResponseText}"`);

      // Now, filter this response using Gemma
      const filterModelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
      const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
      const standardFilterSystemPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (`**`) used for emphasis, as they do not render correctly. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it.";

      try {
        console.log(`NIM CALL START: filterResponse (using ${filterModelId}) in generateStandalonePostFromContext`);
        const filterResponse = await fetchWithRetries(endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: filterModelId,
            messages: [
              { role: "system", content: standardFilterSystemPrompt },
              { role: "user", content: nemotronResponseText } // textToFilter is nemotronResponseText
            ],
            temperature: 0.0, max_tokens: 100, stream: false // Temperature changed to 0.0
          }),
          customTimeout: 60000 // 60s timeout
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
          return this.basicFormatFallback(finalResponse); // Apply fallback for guaranteed cleanup
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

    formattedText = formattedText.replace(/\*\*/g, ""); // Remove double asterisks

    // Truncate more intelligently (similar to utils.truncateResponse but simplified)
    if (formattedText.length > maxLength) {
        let truncated = formattedText.substring(0, maxLength - 3);
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > maxLength / 2) { // Only truncate at space if it's reasonably far in
            truncated = truncated.substring(0, lastSpace);
        }
        formattedText = truncated + "...";
    }
    return formattedText.trim();
  }

  async extractTextFromImageWithScout(imageBase64) { // Renaming to extractTextFromImage
    const modelId = 'google/gemma-3n-e4b-it'; // Changed to Gemma
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
        customTimeout: 90000 // 90s
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
      const lowerUserQueryTextForGenerateCheck = userQueryText.toLowerCase();

      // === High-priority check for "generate image" type commands ===
      const generateKeywords = ["generate", "create", "make", "draw", "sketch"];
      const imageNounKeywords = ["image", "picture", "photo", "art", "artwork", "drawing", "sketch", "painting"];

      let isGenerateImageRequest = false;
      let generateKeywordUsed = "";
      let imageNounUsed = "";

      for (const gk of generateKeywords) {
        if (lowerUserQueryTextForGenerateCheck.includes(gk)) {
          generateKeywordUsed = gk;
          break;
        }
      }
      if (generateKeywordUsed) {
        for (const ik of imageNounKeywords) {
          if (lowerUserQueryTextForGenerateCheck.includes(ik)) {
            imageNounUsed = ik;
            isGenerateImageRequest = true;
            break;
          }
        }
      }

      // Check if the query *only* contains "generate" without an image noun, but implies it (e.g. "generate a cat")
      // This is a heuristic. A more robust solution might involve NLP or more complex keyword analysis.
      // For now, if "generate" is present but no explicit image noun, we'll be conservative and let it pass to intent classification.
      // The original request was "The word 'generate' in a post or reply should always trigger an image generation call"
      // This implies if "generate" is there, it's likely an image request. Let's refine this.
      // If "generate" is present, and it's not part of a known non-image command (e.g. "generate text", "generate response")
      // then assume it's for an image.

      if (generateKeywordUsed && !lowerUserQueryTextForGenerateCheck.includes("generate text") && !lowerUserQueryTextForGenerateCheck.includes("generate response") && !lowerUserQueryTextForGenerateCheck.includes("generate post")) {
        // If an image noun is also present, it's definitely an image generation request.
        // If no explicit image noun, but "generate" is there and it's not for text/response,
        // we'll also treat it as an image generation request.
        isGenerateImageRequest = true;
      }


      if (isGenerateImageRequest) {
        console.log(`[GenerateImageDirect] Detected image generation request. Query: "${userQueryText}"`);
        let imagePrompt = userQueryText;
        // Attempt to strip "generate an image of", "create a picture of", etc.
        const patternsToRemove = [];
        generateKeywords.forEach(gk => {
          imageNounKeywords.forEach(ik => {
            patternsToRemove.push(new RegExp(`${gk}\\s+(an|a|the)?\\s*${ik}\\s+(of|about)?`, 'i'));
          });
          // Pattern for just "generate [prompt]"
          patternsToRemove.push(new RegExp(`${gk}\\s+`, 'i'));
        });

        let cleanedPrompt = imagePrompt;
        for (const pattern of patternsToRemove) {
          cleanedPrompt = cleanedPrompt.replace(pattern, "").trim();
        }
        // Further clean common bot mentions or leading/trailing prepositions
        cleanedPrompt = cleanedPrompt.replace(`@${this.config.BLUESKY_IDENTIFIER}`, "").replace(/^(of|about)\s+/i, "").trim();


        if (!cleanedPrompt) {
            console.warn("[GenerateImageDirect] Extracted prompt is empty after cleaning. Original:", userQueryText);
            await this.postReply(post, "I think you want me to generate an image, but I couldn't understand what you want an image of. Please try rephrasing!");
            return null;
        }

        console.log(`[GenerateImageDirect] Extracted prompt: "${cleanedPrompt}"`);

        const scoutResult = await this.processImagePromptWithScout(cleanedPrompt); // Use the cleaned prompt
        if (!scoutResult.safe) {
          await this.postReply(post, scoutResult.reply_text || "I can't generate an image based on that request due to safety guidelines.");
          return null;
        }

        const imageBase64 = await this.generateImage(scoutResult.image_prompt);
        if (imageBase64) {
          const altText = await this.describeImageWithScout(imageBase64) || `Generated image for: ${scoutResult.image_prompt}`;
          await this.postReply(post, `Here's the image you asked me to generate for "${scoutResult.image_prompt}":`, imageBase64, altText);
        } else {
          await this.postReply(post, `I tried to generate an image for "${scoutResult.image_prompt}", but it didn't work out this time.`);
        }
        return null; // Request handled
      }

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
          customTimeout: 60000 // 60s
        });

        if (nimWebResponse.ok) {
          const nimWebData = await nimWebResponse.json();
          if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
            const synthesizedResponse = nimWebData.choices[0].message.content.trim();
            // Filter this response
            const filterModelIdForWebSearch = 'google/gemma-3n-e4b-it'; // Using Gemma
            const standardFilterSystemPromptForWeb = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text."; // Standard prompt

            const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
              body: JSON.stringify({
                model: filterModelIdForWebSearch, // Gemma
                messages: [
                  { role: "system", content: standardFilterSystemPromptForWeb },
                  { role: "user", content: synthesizedResponse }
                ],
                temperature: 0.0, max_tokens: 100, stream: false // Temperature changed to 0.0
              }),
              customTimeout: 60000 // 60s
            });
            if (filterResponse.ok) {
              const filterData = await filterResponse.json();
              if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                await this.postReply(post, filterData.choices[0].message.content.trim());
              } else {
                await this.postReply(post, this.basicFormatFallback(synthesizedResponse)); // Fallback to basic formatted unfiltered
              }
            } else {
              await this.postReply(post, this.basicFormatFallback(synthesizedResponse)); // Fallback to basic formatted unfiltered
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
          let systemPromptContext = `You are replying to @${post.author.handle}. The user asked a question like "${userQueryText}"`;
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
            customTimeout: 60000 // 60s
          });

          if (nimWebResponse.ok) {
            const nimWebData = await nimWebResponse.json();
            if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
              const synthesizedResponse = nimWebData.choices[0].message.content.trim();
              const filterModelIdForWebSearchPage = 'google/gemma-3n-e4b-it'; // Using Gemma
              const standardFilterSystemPromptForWebPage = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text."; // Standard prompt

              const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: filterModelIdForWebSearchPage, // Gemma
                  messages: [
                    { role: "system", content: standardFilterSystemPromptForWebPage },
                    { role: "user", content: synthesizedResponse }
                  ],
                temperature: 0.0, max_tokens: 100, stream: false // Temperature changed to 0.0
                }),
                customTimeout: 60000 // 60s
              });
              if (filterResponse.ok) {
                const filterData = await filterResponse.json();
                if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                  await this.postReply(post, this.basicFormatFallback(filterData.choices[0].message.content.trim()));
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
      const searchIntent = await this.determineUserIntent(userQueryText);

      if (searchIntent.intent === "autonomous_web_search" && searchIntent.search_query) {
        console.log(`[AutonomousWebSearch] Intent detected. Query: "${searchIntent.search_query}"`);
        const searchResults = await this.performGoogleWebSearch(searchIntent.search_query, null, 'webpage');
        let webContext = "";
        if (searchResults && searchResults.length > 0) {
          const resultsText = searchResults.map((res, idx) =>
            `Result ${idx + 1}: Title: ${res.title}, Snippet: ${res.snippet}`
          ).join("\n");
          webContext = `Based on a quick web search, here's some information that might be relevant:\n${resultsText}\n\n`;
        } else {
          console.log(`[AutonomousWebSearch] No results found for query: "${searchIntent.search_query}". Proceeding without web context.`);
        }

        // Now, re-generate the response with the added web context.
        // We will pass this context to the standard conversational response generator.
        // This avoids duplicating the response generation logic.
        // The conversationHistory already exists, we prepend our new context.
        let conversationHistoryWithWebContext = webContext;
        if (context && context.length > 0) {
          for (const msg of context) {
            conversationHistoryWithWebContext += `${msg.author}: ${msg.text}\n`;
            if (msg.images && msg.images.length > 0) {
              msg.images.forEach(image => { if (image.alt) conversationHistoryWithWebContext += `[Image description: ${image.alt}]\n`; });
            }
          }
        }

        const nemotronUserPrompt = `You are replying to @${post.author.handle}. Here's the conversation context, which includes internal web search results:\n\n${conversationHistoryWithWebContext}\nThe most recent message mentioning you is: "${post.record.text}"\nPlease respond to the request in the most recent message, using the provided web search context to inform your answer. Your response will be posted to BlueSky as a reply. For detailed topics, you can generate a response up to about 870 characters; it will be split into multiple posts if needed.`;

        console.log(`NIM CALL START: Autonomous Web Search Response for model nvidia/llama-3.3-nemotron-super-49b-v1`);
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
            customTimeout: 120000
        });
        console.log(`NIM CALL END: Autonomous Web Search Response - Status: ${response.status}`);
        if (response.ok) {
            const data = await response.json();
            if (data.choices && data.choices.length > 0 && data.choices[0].message.content) {
                const finalResponse = this.basicFormatFallback(data.choices[0].message.content, 870);
                await this.postReply(post, finalResponse);
            } else {
                // Fallback to a simple response if generation fails
                await this.postReply(post, "I've processed your request.");
            }
        } else {
            console.error(`[AutonomousWebSearch] NIM API error after search: ${response.status}`);
            await this.postReply(post, "I looked into that for you, but I'm having trouble formulating a response right now.");
        }
        return null; // End of autonomous web search flow
      }
      else if (searchIntent.intent === "search_history") {
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
          let topMatch = matches[0]; // Get the single best match

          // ===>>> Prevent self-quote: If the top match is the current post, treat as no distinct embeddable match found.
          if (topMatch && topMatch.uri === post.uri) {
            console.log(`[SearchHistory] Top match URI (${topMatch.uri}) is the same as the current post URI. Preventing self-quote. Will respond as if no distinct historical post was found to embed.`);
            topMatch = null; // This will trigger the "no embeddable match found" logic path below.
          }
          // <<<=== End of self-quote prevention

          if (topMatch) {
            let userQueryContextForNemotron = `You are replying to @${post.author.handle}. The user asked: "${userQueryText}".`;
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
          }


        }

        if (!topMatch) { // NO MATCHES FOUND
          let userQueryContextForNemotron = `You are replying to @${post.author.handle}. The user asked: "${userQueryText}".`;
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
          customTimeout: 60000 // 60s
        });
        console.log(`NIM CALL END: Search History Response - Status: ${nimSearchResponse.status}`);

        if (nimSearchResponse.ok) {
          const nimSearchData = await nimSearchResponse.json();
          if (nimSearchData.choices && nimSearchData.choices.length > 0 && nimSearchData.choices[0].message && nimSearchData.choices[0].message.content) {
            const baseResponseText = nimSearchData.choices[0].message.content.trim();

            const filterModelIdForSearchHistory = 'google/gemma-3n-e4b-it'; // Using Gemma
            const standardFilterSystemPromptForSearchHistory = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text."; // Standard prompt

            const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: filterModelIdForSearchHistory, // Gemma
                  messages: [
                    { role: "system", content: standardFilterSystemPromptForSearchHistory },
                    { role: "user", content: baseResponseText }
                  ],
                temperature: 0.0, max_tokens: 100, stream: false // Temperature changed to 0.0
                }),
                customTimeout: 60000 // 60s
            });

            let finalResponseText = baseResponseText;
            if (filterResponse.ok) {
                const filterData = await filterResponse.json();
                if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                    finalResponseText = filterData.choices[0].message.content.trim();
                }
            }

            // Now, decide whether to embed based on `topMatch` having URI and CID
            const cleanedFinalText = this.basicFormatFallback(finalResponseText, 870);
            if (matches.length > 0 && matches[0].uri && matches[0].cid) {
                const foundPostToEmbed = { uri: matches[0].uri, cid: matches[0].cid };
                await this.postReply(post, cleanedFinalText, null, null, foundPostToEmbed);
            } else {
                // This branch is for when no match was found, or match was missing uri/cid (fallback to text URL)
                await this.postReply(post, cleanedFinalText);
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
      else if (searchIntent.intent === "process_url" && searchIntent.url) {
        console.log(`[ProcessUrlFlow] Detected 'process_url' intent for URL: ${searchIntent.url}`);
        await this.handleUserProvidedUrl(post, searchIntent.url);
        return null; // URL processing handled, no further response needed from this function
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

            const nimResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'nvidia/llama-3.3-nemotron-super-49b-v1', // Or a model good for creative short text
                  messages: [ { role: "system", content: nemotronSystemPrompt }, { role: "user", content: captionGenPrompt } ],
                  temperature: 0.8, max_tokens: 50 * foundTemplate.box_count, stream: false
                })
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
                await this.postReply(post, "Those words... they seem to echo in a strange way. I can't use them right now.");
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
          await this.postReply(post, `The final image... it's... shimmering. Unstable. I can't post it, but perhaps you can see it here: ${memeData.pageUrl}`);
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
      else if (searchIntent.intent === "bot_feature_inquiry") {
        console.log(`[BotFeatureInquiry] Intent detected for query: "${userQueryText}"`);
        // The user's original query is `userQueryText`
        // The bot's persona/identity is in `this.config.TEXT_SYSTEM_PROMPT`

        const inquirySystemPrompt = `You are an AI assistant. Your persona is defined as: "${this.config.TEXT_SYSTEM_PROMPT}". The user is asking a question about you or your capabilities. Answer the user's question based on your defined persona and general knowledge of your functions as a helpful AI. Keep the response concise and suitable for a social media post.`;
        const inquiryUserPrompt = `The user @${post.author.handle} asked this question about me/my features: "${userQueryText}"`;

        console.log(`NIM CALL START: BotFeatureInquiry for model nvidia/llama-3.3-nemotron-super-49b-v1`);
        const nimInquiryResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
            messages: [
              { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${inquirySystemPrompt}` },
              { role: "user", content: inquiryUserPrompt }
            ],
            temperature: 0.7, // Slightly higher for more natural, less rigid persona responses
            max_tokens: 200, // Enough for a concise answer about identity
            stream: false
          }),
          customTimeout: 60000 // 60s
        });
        console.log(`NIM CALL END: BotFeatureInquiry - Status: ${nimInquiryResponse.status}`);

        let responseTextToPost = "I'm having a little trouble talking about myself right now, but I'm here to help with other questions!"; // Default fallback

        if (nimInquiryResponse.ok) {
          const nimInquiryData = await nimInquiryResponse.json();
          if (nimInquiryData.choices && nimInquiryData.choices.length > 0 && nimInquiryData.choices[0].message && nimInquiryData.choices[0].message.content) {
            responseTextToPost = nimInquiryData.choices[0].message.content.trim();
          } else {
            console.error('[BotFeatureInquiry] Nvidia NIM API response for inquiry was ok, but no content found:', JSON.stringify(nimInquiryData));
          }
        } else {
          const errorText = await nimInquiryResponse.text();
          console.error(`[BotFeatureInquiry] Nvidia NIM API error for inquiry response (${nimInquiryResponse.status}) - Text: ${errorText}`);
        }

        // Filter the response from Nemotron using Gemma (standard minimal filter)
        const filterModelIdForBotInquiry = 'google/gemma-3n-e4b-it';
        const universalMinimalFilterPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (`**`) used for emphasis, as they do not render correctly. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it.";

        console.log(`NIM CALL START: filterResponse (using ${filterModelIdForBotInquiry}) in BotFeatureInquiry`);
        const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: filterModelIdForBotInquiry,
              messages: [
                { role: "system", content: universalMinimalFilterPrompt },
                { role: "user", content: responseTextToPost }
              ],
              temperature: 0.0, max_tokens: 150,
              stream: false
            }),
            customTimeout: 30000 // 30s
        });
        console.log(`NIM CALL END: filterResponse (using ${filterModelIdForBotInquiry}) in BotFeatureInquiry - Status: ${filterResponse.status}`);

        if (filterResponse.ok) {
            const filterData = await filterResponse.json();
            if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message && filterData.choices[0].message.content) {
                responseTextToPost = filterData.choices[0].message.content.trim();
            } else {
                console.warn('[BotFeatureInquiry] Gemma filter response was ok, but no content. Using Nemotron direct output.');
            }
        } else {
            const filterErrorText = await filterResponse.text();
            console.error(`[BotFeatureInquiry] Gemma filter API error (${filterResponse.status}) - Text: ${filterErrorText}. Using Nemotron direct output.`);
        }
        // Always apply the final cleanup before posting.
        await this.postReply(post, this.basicFormatFallback(responseTextToPost, 870));
        return null; // Bot feature inquiry handled
      }
      else if (searchIntent.intent === "get_bot_status") {
        console.log(`[GetBotStatus] Intent detected for query: "${userQueryText}"`);
        let recentActivity = "I've been chatting with a few people and exploring some new ideas!"; // Default if no posts.

        if (this.repliedPosts.size > 0) {
            try {
                // Get the last 3 post URIs the bot replied to
                const recentPostUris = Array.from(this.repliedPosts).slice(-3);
                const topics = [];
                for (const uri of recentPostUris) {
                    try {
                        const { data: threadView } = await this.agent.getPostThread({ uri });
                        if (threadView && threadView.thread && threadView.thread.post && threadView.thread.post.record && typeof threadView.thread.post.record.text === 'string') {
                            topics.push(threadView.thread.post.record.text.substring(0, 75));
                        }
                    } catch (threadError) {
                        console.error(`[GetBotStatus] Error fetching individual thread for URI ${uri}:`, threadError);
                    }
                }

                if (topics.length > 0) {
                    recentActivity = `I've just been chatting about things like "${topics.join('", "')}"...`;
                }
            } catch (error) {
                console.error("[GetBotStatus] Error processing recent replied-to posts:", error);
                // Fallback to default activity text
            }
        }

        const statusSystemPrompt = `You are an AI assistant replying to @${post.author.handle}. The user has asked what you are up to or how you are doing. Based on the provided summary of your recent activity, give a brief, natural, and conversational response. Do NOT list your skills. Be casual. Do not repeat the prompt.`;
        const statusUserPrompt = `My recent activity summary is: "${recentActivity}". How should I respond to @${post.author.handle} asking what I'm up to?`;

        const nimStatusResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
            messages: [
              { role: "system", content: statusSystemPrompt },
              { role: "user", content: statusUserPrompt }
            ],
            temperature: 0.8, max_tokens: 150, stream: false
          }),
          customTimeout: 60000
        });

        if (nimStatusResponse.ok) {
            const nimStatusData = await nimStatusResponse.json();
            if (nimStatusData.choices && nimStatusData.choices.length > 0 && nimStatusData.choices[0].message && nimStatusData.choices[0].message.content) {
                const responseText = nimStatusData.choices[0].message.content;

                const filterModelIdForBotStatus = 'google/gemma-3n-e4b-it';
                const universalMinimalFilterPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (`**`) used for emphasis, as they do not render correctly. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it.";

                const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                    body: JSON.stringify({
                      model: filterModelIdForBotStatus,
                      messages: [
                        { role: "system", content: universalMinimalFilterPrompt },
                        { role: "user", content: responseText }
                      ],
                      temperature: 0.0, max_tokens: 150,
                      stream: false
                    }),
                    customTimeout: 30000 // 30s
                });

                let responseTextToPost = responseText;
                if (filterResponse.ok) {
                    const filterData = await filterResponse.json();
                    if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message && filterData.choices[0].message.content) {
                        responseTextToPost = filterData.choices[0].message.content.trim();
                    }
                }

                await this.postReply(post, this.basicFormatFallback(responseTextToPost, 870));
            } else {
                await this.postReply(post, "Just processing some data and getting ready for our chat! What's on your mind?");
            }
        } else {
            await this.postReply(post, "Just processing some data and getting ready for our chat! What's on your mind?");
        }
        return null;
      }
      // If not a search history or other specific intent, proceed with web search or original logic
      else if (searchIntent.intent === "web_search" && searchIntent.search_query) {
        console.log(`[WebSearchFlow] Consolidated web search intent detected. Query: "${searchIntent.search_query}", Type: "${searchIntent.search_type}"`);

        const isQuerySafe = await this.isTextSafeScout(searchIntent.search_query);
        if (!isQuerySafe) {
          console.warn(`[WebSearchFlow] Web search query "${searchIntent.search_query}" deemed unsafe.`);
          const unsafeQueryResponse = "That's a path I can't take. The whispers from the network are... unsettling. Let's try a different direction.";
          const filterModelIdForUnsafeWebSearch = 'google/gemma-3n-e4b-it'; // Using Gemma
          const standardFilterSystemPromptForUnsafeWeb = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text."; // Standard prompt

          const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: filterModelIdForUnsafeWebSearch, // Gemma
              messages: [
                { role: "system", content: standardFilterSystemPromptForUnsafeWeb },
                { role: "user", content: unsafeQueryResponse }
              ],
              temperature: 0.0, max_tokens: 100, stream: false // Temperature changed to 0.0
            }),
            customTimeout: 30000 // 30s
          });
          if (filterResponse.ok) {
            const filterData = await filterResponse.json();
            if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
              await this.postReply(post, filterData.choices[0].message.content.trim());
            } else {
              await this.postReply(post, this.basicFormatFallback(unsafeQueryResponse));
            }
          } else {
            await this.postReply(post, this.basicFormatFallback(unsafeQueryResponse));
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

                  const postReplyResult = await this.postReply(parentPostForReply, this.basicFormatFallback(responseText), imageBase64, altText);
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
          const webSearchSystemPrompt = `You are an AI assistant replying to @${post.author.handle}. The user asked a question: "${userQueryText}". You have performed a web search for "${searchIntent.search_query}" (freshness: ${searchIntent.freshness_suggestion || 'not specified'}).
Use the provided search results (title, URL, snippet) to formulate a concise and helpful answer to the user's original question.
Synthesize the information from the results. If appropriate, you can cite the source URL(s) by including them in your answer (e.g., "According to [URL], ...").
If the search results do not provide a clear answer, state that you couldn't find specific information from the web for their query.
Do not make up information not present in the search results. Keep the response suitable for a social media post.`;

          if (searchResults && searchResults.length > 0) {
            const resultsText = searchResults.map((res, idx) =>
              `Result ${idx + 1}:\nTitle: ${res.title}\nURL: ${res.url}\nSnippet: ${res.snippet}`
            ).join("\n\n---\n");
            nemotronWebServicePrompt = `User's original question: "${userQueryText}"\nSearch query sent to web: "${searchIntent.search_query}"\n\nWeb Search Results:\n${resultsText}\n\nBased on these results, please answer the user's original question.`;
          } else {
            nemotronWebServicePrompt = `User's original question: "${userQueryText}"\nSearch query sent to web: "${searchIntent.search_query}"\n\nNo clear results were found from the web search. Please inform the user politely that you couldn't find information for their query via web search and suggest they rephrase or try a search engine directly.`;
          }

          console.log(`[WebSearchFlow] Nemotron prompt for web search synthesis: "${nemotronWebServicePrompt.substring(0, 300)}..."`);
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
            customTimeout: 60000 // 60s
          });

          if (nimWebResponse.ok) {
            const nimWebData = await nimWebResponse.json();
            if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
              const synthesizedResponse = nimWebData.choices[0].message.content.trim();
              const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-4-scout-17b-16e-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: synthesizedResponse }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                }),
                customTimeout: 60000 // 60s
              });
              if (filterResponse.ok) {
                const filterData = await filterResponse.json();
                if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message) {
                  await this.postReply(post, this.basicFormatFallback(filterData.choices[0].message.content.trim()));
                } else {
                  await this.postReply(post, this.basicFormatFallback(synthesizedResponse));
                }
              } else {
                await this.postReply(post, this.basicFormatFallback(synthesizedResponse));
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
            conversationHistory += `${msg.author}: ${msg.text}\n`;
            if (msg.images && msg.images.length > 0) {
              msg.images.forEach(image => { if (image.alt) conversationHistory += `[Image description: ${image.alt}]\n`; });
            }
          }
        }

        let userBlueskyPostsContext = "";
        // If the intent is an explicit request for profile analysis, OR if the bot decides autonomously.
        const isAutonomousProfileAnalysis = await this.shouldFetchProfileContext(userQueryText);

        if (isAutonomousProfileAnalysis) {
          console.log(`[Context] Fetching profile context. Autonomous decision: ${isAutonomousProfileAnalysis}. Query: "${userQueryText}"`);
          try {
            const conversationHistoryItems = await this.getBotUserConversationHistory(post.author.did, this.agent.did, 50);
            if (conversationHistoryItems.length > 0) {
              userBlueskyPostsContext = "\n\nRecent conversation history between you and the user (" + post.author.handle + "):\n" + conversationHistoryItems.map(item => `${item.authorHandle}: ${item.text}`).join("\n---\n") + "\n\n";
              console.log(`[Context] Added ${conversationHistoryItems.length} conversation messages to context.`);
            } else {
              console.log(`[Context] No direct conversation history found.`);
            }
          } catch (error) {
            console.error(`[Context] Error fetching conversation history:`, error);
          }
        }

        let nemotronUserPrompt = "";
        const baseInstruction = `Your response will be posted to BlueSky as a reply. For detailed topics, generate a response up to about 870 characters; it will be split into multiple posts if needed.`;

        if (isAutonomousProfileAnalysis && userBlueskyPostsContext) {
          // Autonomous Profile Analysis (Internal Context Prompt)
          nemotronUserPrompt = `You are replying to @${post.author.handle}.
The user's immediate message is: "${post.record.text}"
The preceding conversation thread is:\n${conversationHistory}
**INTERNAL CONTEXT ONLY - DO NOT MENTION THIS ANALYSIS TO THE USER**: To provide a more insightful response, you have autonomously analyzed the user's recent activity. Use these themes and topics from their history to inform the tone, content, and direction of your reply to their immediate message.
<INTERNAL_ANALYSIS_CONTEXT>
${userBlueskyPostsContext}
</INTERNAL_ANALYSIS_CONTEXT>

Based on all available context (especially the user's immediate message), generate a natural, in-character response. ${baseInstruction}`;
        } else {
          // Standard prompt (no profile context fetched or used)
          nemotronUserPrompt = `You are replying to @${post.author.handle}. Here's the conversation context:\n\n${conversationHistory}\nThe most recent message mentioning you is: "${post.record.text}"\nPlease respond to the request in the most recent message. ${baseInstruction}`;
        }

        console.log(`NIM CALL START: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1. Prompt type: ${isAutonomousProfileAnalysis ? "Autonomous Internal Context" : "Standard"}`);
      const response = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [
            { role: "system", content: `Your primary instruction is to ALWAYS respond in the character and persona defined here: "${this.config.TEXT_SYSTEM_PROMPT}". Adhere to this persona strictly. ${this.config.SAFETY_SYSTEM_PROMPT} Important: You are a text-based assistant. You can suggest that an image could be generated if it is relevant. Do not claim to have already generated an image, as that is handled by a separate system. Focus on your textual reply in character.` },
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
      console.log(`[LlamaBot.generateResponse] Length of initialResponse (from Nemotron) before sending to Gemma filter: ${initialResponse.length} characters.`);

      // Using Gemma for filtering instead of Scout
      const filterModelIdForGenerateResponse = 'google/gemma-3n-e4b-it';
      const endpointUrlForGenerateResponse = 'https://integrate.api.nvidia.com/v1/chat/completions';
      // This is the Llama 3.2 Vision style prompt for minimal formatting.
      // It's slightly different from the original filterSystemPromptForGenerateResponse,
      // particularly in that it does NOT have special handling for "[SUMMARY...]" tags.
      // This is the one to use if the user wants the "Llama 3.2 Vision system prompt" universally.
      // const universalMinimalFilterPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (`**`) used for emphasis, as they do not render correctly. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it.";

      // New specific filter prompt for structured (summary/details) responses from Nemotron
      const structuredResponseFilterPrompt = `ATTENTION: You are filtering a structured response from another AI. The response contains specific markers: "[SUMMARY FINDING WITH INVITATION]" and "[DETAILED ANALYSIS POINT X]" (where X is a number).
      Your tasks are:
      1.  **PRESERVE THE MARKERS EXACTLY** as they appear: "[SUMMARY FINDING WITH INVITATION]" and "[DETAILED ANALYSIS POINT X]". Do not alter or remove them.
      2.  For the text *following* "[SUMMARY FINDING WITH INVITATION]" and before the first "[DETAILED ANALYSIS POINT 1]", ensure it's a concise summary (target around 250-280 characters, max 300). Truncate if necessary, prioritizing whole sentences.
      3.  For the text *following each* "[DETAILED ANALYSIS POINT X]" marker, ensure it's a short paragraph (target around 2-4 sentences, max 290 characters for a Bluesky post). Truncate if necessary, prioritizing whole sentences.
      4.  Perform these standard cleanups on ALL text content:
          a. Remove any surrounding quotation marks that make the entire text (or segments) appear as a direct quote.
          b. Remove any sender attributions like 'Bot:', 'Nemotron says:', 'AI:'.
          c. Remove any double asterisks (\`**\`) used for bold emphasis. Single asterisks used for roleplay actions (e.g., \`*smiles*\`, \`*nods*\`) should be PRESERVED.
          d. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear.
      5.  DO NOT rephrase, summarize beyond the truncation rules, or add/remove any other content. Maintain original meaning and sentence structure as much as possible within character limits.
      Output only the processed text with preserved markers. This is an internal formatting step; do not mention it.`;

      // Determine which filter prompt to use
      const universalMinimalFilterPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (\`**\`) used for bold emphasis. Single asterisks used for roleplay actions (e.g., \`*smiles*\`, \`*nods*\`) should be PRESERVED. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it.";
      let filterSystemPromptToUse = universalMinimalFilterPrompt;
      // universalMinimalFilterPrompt is already defined above and assigned to filterSystemPromptToUse by default
      console.log("[LlamaBot.generateResponse] Using UNIVERSAL MINIMAL response filter prompt for Gemma.");


      let gemmaFormattedText;
      console.log(`NIM CALL START: filterResponse (using ${filterModelIdForGenerateResponse}) in generateResponse`);
      const gemmaFilterResponse = await fetchWithRetries(endpointUrlForGenerateResponse, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: filterModelIdForGenerateResponse,
          messages: [
            { role: "system", content: filterSystemPromptToUse }, // Using the dynamically chosen filter prompt
            { role: "user", content: initialResponse }
          ],
          temperature: 0.0, // Temperature changed to 0.0
          max_tokens: 1024, // Increased max_tokens for potentially longer structured responses
          stream: false
        }),
        customTimeout: 60000
      });
      console.log(`NIM CALL END: filterResponse (using ${filterModelIdForGenerateResponse}) in generateResponse - Status: ${gemmaFilterResponse.status}`);

      if (!gemmaFilterResponse.ok) {
        const errorText = await gemmaFilterResponse.text();
        console.error(`Nvidia NIM API error (filter model ${filterModelIdForGenerateResponse}) (${gemmaFilterResponse.status}) - Text: ${errorText}. Falling back to basic formatter.`);
        gemmaFormattedText = this.basicFormatFallback(initialResponse, 870);
      } else {
        const gemmaFilterData = await gemmaFilterResponse.json();
        if (gemmaFilterData.choices && gemmaFilterData.choices.length > 0 && gemmaFilterData.choices[0].message && gemmaFilterData.choices[0].message.content) {
          gemmaFormattedText = gemmaFilterData.choices[0].message.content;
          console.log(`[LlamaBot.generateResponse] Filtered response from ${filterModelIdForGenerateResponse}: "${gemmaFormattedText.substring(0,200)}..."`);
        } else {
          console.error(`Unexpected response format from Nvidia NIM (filter model ${filterModelIdForGenerateResponse}):`, JSON.stringify(gemmaFilterData), '. Falling back to basic formatter.');
          gemmaFormattedText = this.basicFormatFallback(initialResponse, 870);
        }
      }

      // Ensure final cleanup, especially for asterisks, is always applied.
      const scoutFormattedText = this.basicFormatFallback(gemmaFormattedText, 870); // Use a higher length limit for multipart posts
      console.log(`[LlamaBot.generateResponse] Final formatted text for processing (after ${filterModelIdForGenerateResponse} filter and basicFormatFallback): "${scoutFormattedText.substring(0,200)}..."`);

      // Attempt to parse structured response if profile analysis was done
      // Note: an image generated for the *initial* query that leads to a summary/details flow.
      // This image should be passed if details are later requested.
      // We need to receive potential imageBase64 & altText if they were generated for the initial query.
      // Let's assume `post.generatedImageForThisInteraction = { imageBase64, altText }` if available.
      // This is a placeholder; actual passing of this data needs to be handled from the monitor call.

      return scoutFormattedText;
    } // Closes the main 'else' block starting at L1390
    } catch (error) { // This is line 1520 in Render's logs
      console.error(`[LlamaBot.generateResponse] Caught error for post URI: ${post.uri}. Error:`, error);
      return null; // Ensure null is returned on error so monitor doesn't try to post it.
    } // Closes the catch block of generateResponse
  } // Closes the generateResponse method async generateResponse(post, context) {

  getModelName() {
    return 'nvidia/llama-3.3-nemotron-super-49b-v1 (filtered by meta/llama-4-scout-17b-16e-instruct)'.split('/').pop();
  }

  async handleUserProvidedUrl(post, url) {
    console.log(`[handleUserProvidedUrl] Processing URL: ${url} for post ${post.uri}`);
    try {
      // Basic check for local/internal IPs
      try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('10.') || hostname.startsWith('192.168.') || (hostname.startsWith('172.') && parseInt(hostname.split('.')[1], 10) >= 16 && parseInt(hostname.split('.')[1], 10) <= 31)) {
          console.warn(`[handleUserProvidedUrl] Attempt to access internal/local URL blocked: ${url}`);
          await this.postReply(post, "Sorry, I can't access that URL as it appears to be an internal or local address.");
          return;
        }
      } catch (e) {
        console.warn(`[handleUserProvidedUrl] Invalid URL provided: ${url}. Error: ${e.message}`);
        await this.postReply(post, "That doesn't look like a valid URL I can process. Please check it and try again.");
        return;
      }

      // 1. Perform a HEAD request to get Content-Type
      const headResponse = await fetchWithRetries(url, { method: 'HEAD', customTimeout: 15000 }); // 15s timeout for HEAD

      if (!headResponse.ok) {
        await this.postReply(post, `I couldn't access that URL (status: ${headResponse.status}). Please check if it's correct and publicly accessible.`);
        return;
      }

      const contentType = headResponse.headers.get('content-type');
      console.log(`[handleUserProvidedUrl] URL: ${url}, Content-Type: ${contentType}`);

      // 2. Image URL Handling
      if (contentType && (contentType.startsWith('image/jpeg') || contentType.startsWith('image/png') || contentType.startsWith('image/gif') || contentType.startsWith('image/webp'))) {
        await this.postReply(post, `I see you've shared an image link. Let me try to fetch and describe it for you...`);
        const imageBase64 = await utils.imageUrlToBase64(url);
        if (imageBase64) {
          const isSafe = await this.isImageSafeScout(imageBase64);
          if (!isSafe) {
            await this.postReply(post, "I see the image, but it's... distorted. I can't seem to bring it into focus.");
            return;
          }
          const description = await this.describeImageWithScout(imageBase64) || "Here's the image you shared:";
          await this.postReply(post, description, imageBase64, description.substring(0, 280));
        } else {
          await this.postReply(post, "I tried to fetch the image, but something went wrong. Maybe the link is broken or private?");
        }
      }
      // 3. Webpage (HTML/Text) URL Handling
      else if (contentType && (contentType.startsWith('text/html') || contentType.startsWith('text/plain'))) {
        await this.postReply(post, `You've shared a web page. Let me try to fetch its content and give you a summary...`);
        const pageResponse = await fetchWithRetries(url, { method: 'GET', customTimeout: 20000 }); // 20s for GET
        if (!pageResponse.ok) {
          await this.postReply(post, `I couldn't fetch the content from that web page (status: ${pageResponse.status}).`);
          return;
        }
        let pageText = await pageResponse.text();

        if (contentType.startsWith('text/html')) {
          // Basic HTML stripping: remove tags, scripts, styles.
          // Replace <br>, <p>, </div>, </h1>-</h6> with newlines for better readability before full stripping.
          pageText = pageText.replace(/<\/(p|div|h[1-6])>/gi, '\n');
          pageText = pageText.replace(/<br\s*\/?>/gi, '\n');
          // Strip all other tags
          pageText = pageText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ''); // Remove style blocks
          pageText = pageText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ''); // Remove script blocks
          pageText = pageText.replace(/<[^>]+>/g, ''); // Strip all remaining HTML tags
          pageText = pageText.replace(/\s+/g, ' ').trim(); // Normalize whitespace
        }

        if (pageText.length > 50000) { // Limit input text to LLM
            console.warn(`[handleUserProvidedUrl] Page text too long (${pageText.length}), truncating to 50000 chars.`);
            pageText = pageText.substring(0, 50000);
        }

        if (!pageText.trim()) {
            await this.postReply(post, "I fetched the page, but it seems to have no readable text content.");
            return;
        }

        const isSafeText = await this.isTextSafeScout(pageText.substring(0, 2000)); // Check a snippet for safety
        if (!isSafeText) {
          await this.postReply(post, "The text from that link... it's like static in my circuits. I can't process it.");
          return;
        }

        const summarySystemPrompt = `You are an AI assistant replying to @${post.author.handle}. The user provided a URL to a webpage. You have been given the extracted text content from that page. Your task is to provide a concise summary or highlight key points from the text. The response should be engaging and suitable for a social media post. If the text is very short, you can quote a relevant part. Keep your response under 280 characters.`;
        const summaryUserPrompt = `Here is the text extracted from the webpage at ${url}:\n\n"${pageText.substring(0, 4000)}..."\n\nPlease summarize this or highlight its key points for @${post.author.handle}.`;

        console.log(`NIM CALL START: handleUserProvidedUrl (Summarize Webpage) for model nvidia/llama-3.3-nemotron-super-49b-v1`);
        const nimResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
            messages: [
              { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${summarySystemPrompt}` },
              { role: "user", content: summaryUserPrompt }
            ],
            temperature: 0.5, max_tokens: 150, stream: false
          }),
          customTimeout: 60000 // 60s
        });
        console.log(`NIM CALL END: handleUserProvidedUrl (Summarize Webpage) - Status: ${nimResponse.status}`);

        let summaryResponseText;
        if (nimResponse.ok) {
          const nimData = await nimResponse.json();
          if (nimData.choices && nimData.choices.length > 0 && nimData.choices[0].message && nimData.choices[0].message.content) {
            summaryResponseText = nimData.choices[0].message.content.trim();
          } else {
            summaryResponseText = "I fetched the page content, but I'm having a bit of trouble summarizing it right now.";
          }
        } else {
          summaryResponseText = "Sorry, I couldn't process the webpage content with my summarizer at the moment.";
        }

        // Filter the summary using Gemma
        const filterModelIdForSummary = 'google/gemma-3n-e4b-it';
        const universalMinimalFilterPrompt = "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text.";

        const filterResponse = await fetchWithRetries('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
            body: JSON.stringify({
              model: filterModelIdForSummary,
              messages: [
                { role: "system", content: universalMinimalFilterPrompt },
                { role: "user", content: summaryResponseText }
              ],
              temperature: 0.0, max_tokens: 100, stream: false
            }),
            customTimeout: 30000 // 30s
        });

        let finalSummaryText = summaryResponseText; // Fallback to Nemotron's direct output
        if (filterResponse.ok) {
            const filterData = await filterResponse.json();
            if (filterData.choices && filterData.choices.length > 0 && filterData.choices[0].message && filterData.choices[0].message.content) {
                finalSummaryText = filterData.choices[0].message.content.trim();
            } else {
                 console.warn(`[handleUserProvidedUrl] Gemma filter for summary was OK but no content. Using Nemotron's direct output.`);
                 finalSummaryText = summaryResponseText; // Keep unfiltered Nemotron response
            }
        } else {
            console.error(`[handleUserProvidedUrl] Gemma filter API error for summary. Using Nemotron's direct output.`);
            finalSummaryText = summaryResponseText; // Keep unfiltered Nemotron response
        }

        // Always apply basicFormatFallback to the final text, regardless of which model it came from.
        const cleanedFinalText = this.basicFormatFallback(finalSummaryText);

        // Create a link card for the original URL
        const externalEmbed = {
          uri: url,
          title: `Content from: ${new URL(url).hostname}`, // Basic title
          description: `Summary of content from the shared link. (Original URL: ${url})` // Basic description
        };
        // Attempt to get a better title/description for the card from the page itself (if HTML)
        if (contentType.startsWith('text/html')) {
            const titleMatch = pageText.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch && titleMatch[1]) {
                externalEmbed.title = titleMatch[1].trim().substring(0,100); // Limit title length
            }
            const metaDescriptionMatch = pageText.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
            if (metaDescriptionMatch && metaDescriptionMatch[1]) {
                externalEmbed.description = metaDescriptionMatch[1].trim().substring(0,200); // Limit description length
            }
        }

        await this.postReply(post, cleanedFinalText, null, null, null, externalEmbed);

      }
      // 4. Other Content Types / Fallback
      else {
        console.log(`[handleUserProvidedUrl] Unsupported content type: ${contentType} for URL: ${url}`);
        // Create a simple link card as a fallback for unsupported types
        const externalEmbed = {
          uri: url,
          title: `Link: ${new URL(url).hostname}`,
          description: `Shared link. Content type: ${contentType || 'unknown'}.`
        };
        await this.postReply(post, `I'm not sure how to process this type of link directly (${contentType || 'unknown'}), but here's a card for it:`, null, null, null, externalEmbed);
      }
    } catch (error) {
      console.error(`[handleUserProvidedUrl] Error processing URL ${url}:`, error);
      if (error.name === 'AbortError') {
           await this.postReply(post, `Sorry, I took too long trying to fetch that URL and had to give up. It might be slow or temporarily unavailable.`);
      } else {
           await this.postReply(post, `I ran into an unexpected problem trying to process that URL. Please try again later or with a different link.`);
      }
    }
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
    console.log(`[NasaApodCall] Initiating direct API call to NASA APOD. Requested date: ${requestedDate || 'today'}`);
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
    const lowerSearchQuery = searchQuery.toLowerCase();
    if (lowerSearchQuery.includes("nasa") && (lowerSearchQuery.includes("apod") || lowerSearchQuery.includes("astronomy picture of the day") || lowerSearchQuery.includes("picture of the day"))) {
      console.log(`[WebSearchForAPOD] Performing Google web search for NASA APOD-related query. Type: ${searchType}, Query: "${searchQuery}", Freshness: ${freshness}`);
    } else {
      console.log(`[GoogleSearch] Performing Google search. Type: ${searchType}, Query: "${searchQuery}", Freshness: ${freshness}`);
    }
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
            const postText = postRecord ? postRecord.text || "" : "";
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

            // Fallback: If not already relevant, and otherActorHandleToMatch is valid, check for text mentions.
            if (!isRelevant && otherActorHandleToMatch && otherActorHandleToMatch !== "user" && postText.toLowerCase().includes(`@${otherActorHandleToMatch.toLowerCase()}`)) {
                console.log(`[ConvHistory] Fallback: Relevant text mention found: ${postUri} from ${postAuthorHandle} includes @${otherActorHandleToMatch}`);
                isRelevant = true;
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

  async determineUserIntent(userQueryText, conversationContext) {
    if (!userQueryText || userQueryText.trim() === "") {
      return { intent: "none" };
    }

    // First, perform the "search necessity" rating.
    const searchRating = await this.rateWebSearchNecessity(userQueryText, conversationContext);

    // If the rating indicates a high-confidence need for a web search,
    // we can bypass the more complex intent model and go straight to the autonomous search.
    if (searchRating.search_needed && searchRating.confidence === 'high' && searchRating.suggested_query) {
      console.log(`[determineUserIntent] High-confidence autonomous web search triggered by internal rating. Query: "${searchRating.suggested_query}"`);
      return {
        intent: "autonomous_web_search",
        search_query: searchRating.suggested_query,
        search_type: "webpage", // Default to webpage for autonomous searches
        freshness_suggestion: null // Can be refined later if needed
      };
    }

    // If not a high-confidence autonomous search, proceed with the full intent classification model.
    const modelId = 'google/gemma-3n-e4b-it';
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    const systemPromptContent = `Your task is to analyze the user's query to determine their primary intent. Output a JSON object. Choose ONE of the following intent structures:
1.  **"search_history"**: For finding a specific item from past interactions (conversation history, bot's own posts/gallery).
    { "intent": "search_history", "target_type": "image" | "link" | "post", "author_filter": "user" | "bot" | "any", "keywords": ["keyword1", ...], "recency_cue": "textual cue" | null, "search_scope": "bot_gallery" | "conversation" | null }
2.  **"bot_feature_inquiry"**: For questions about the bot's own features, identity, or capabilities.
    { "intent": "bot_feature_inquiry" }
3.  **"get_bot_status"**: For conversational questions about the bot's current state (e.g., "how are you?", "what are you up to?"). Do NOT use for simple greetings.
    { "intent": "get_bot_status" }
4.  **"process_url"**: If the query contains a generic URL for processing.
    { "intent": "process_url", "url": "the_extracted_url" }
5.  **"none"**: If no other intent fits. This is the default for general conversation, including simple greetings like "hello", "good morning", or "thanks".
    { "intent": "none" }

**PRIORITIZATION AND RULES:**
- **Greetings vs. Status**: A simple greeting like "Good morning" is "none". A greeting combined with a question like "Good morning, what are you up to?" is "get_bot_status".
- **Internal Context**: If the internal search rating already suggested a search, you can use that to inform your decision, but the final intent choice is yours based on the full query.
- **Safety**: If a query for any search type seems unsafe, you may classify it as "none".
- **Output ONLY the JSON object.**`;

    const userPromptContent = `User query: '${userQueryText}'\n\nConversation Context:\n${conversationContext || "No context provided."}`;
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
        customTimeout: 45000 // 45s
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
            } else if (parsedJson.intent === "process_url") {
                if (typeof parsedJson.url !== 'string' || !parsedJson.url.startsWith('http')) {
                    // LLM might hallucinate a URL or get the field wrong. Fallback to regex if so.
                    const urlRegex = /(https?:\/\/[^\s]+)/g;
                    const urlsFound = userQueryText.match(urlRegex);
                    if (urlsFound && urlsFound.length > 0) {
                        parsedJson.url = urlsFound[0]; // Take the first one
                        console.log(`[IntentClassifier] Corrected/extracted URL for process_url intent via regex: ${parsedJson.url}`);
                    } else {
                        console.warn(`[IntentClassifier] ${modelId} returned 'process_url' but no valid URL found in response or query. Returning 'none'. Query: ${userQueryText}`);
                        return { intent: "none", comment: "LLM suggested process_url but no URL found." };
                    }
                }
            }


            console.log(`[IntentClassifier] ${modelId} parsed intent (getIntent):`, parsedJson);
            // Client-side fallback URL detection if LLM returns "none" or a non-URL intent but a URL is present.
            // This is a lower priority than LLM's specific intent if that intent is NOT "none".
            if (parsedJson.intent === "none" || (parsedJson.intent !== "process_url" /* and not admin command */)) {
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                const urlsFound = userQueryText.match(urlRegex);
                if (urlsFound && urlsFound.length > 0) {
                    // Check if this URL is part of an admin command (which is handled elsewhere, not by intent)
                    const isAdminCommandWithUrl = (userQueryText.includes("!post+video") || userQueryText.includes("!post+image")) && userQueryText.includes(urlsFound[0]);

                    if (!isAdminCommandWithUrl) {
                         // If current intent is "none", or it's something generic that might miss a URL context,
                         // and we found a URL, we can override to "process_url".
                         // This is especially for the case where the LLM returns "none" but a URL is clearly present.
                        if (parsedJson.intent === "none") {
                            console.log(`[IntentClassifier] Fallback Regex: Found URL ${urlsFound[0]} and current LLM intent is 'none'. Switching to 'process_url'.`);
                            return { intent: "process_url", url: urlsFound[0], source: "regex_fallback_from_none" };
                        }
                        // If LLM returned something like 'web_search' but the query was *just* a URL, 'process_url' might be better.
                        // This needs careful consideration to not override valid LLM decisions.
                        // For now, only overriding "none".
                    }
                }
            }
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
    // This function is now internal-only and should not be triggered by user input.
    // It will always return false.
    return false;
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
        customTimeout: 30000 // 30s
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

  async rateWebSearchNecessity(userQueryText, conversationContext) {
    const modelId = 'google/gemma-3-9b-it'; // Using Gemma 3 for this rating task.
    const endpointUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

    const systemPrompt = `You are an expert search query analyst. Your task is to determine if a user's query requires an internal, autonomous web search to provide a high-quality answer.
Analyze the user's query in the context of the conversation.
Output a JSON object with the following structure:
{
  "search_needed": boolean,
  "confidence": "high" | "medium" | "low" | null,
  "suggested_query": "a concise, effective search query" | null,
  "reasoning": "a brief explanation for your decision"
}

**Criteria for "search_needed": true**:
- The query asks for specific, factual information (e.g., "who is...", "what is the capital of...", "explain X").
- The query asks for current events, news, or information that is likely outside the bot's pre-existing knowledge.
- The query cannot be answered sufficiently with the provided conversation context.

**Criteria for "search_needed": false**:
- The query is a simple greeting, conversational filler, or social interaction ("hello", "how are you?", "lol").
- The query is a direct command to the bot that doesn't require external data (e.g., "!mute", "!help", "create a meme").
- The query is an opinion-based question directed at the bot ("what do you think of...?").
- The query is too vague or ambiguous to form a meaningful search query ("tell me something interesting").

**Confidence Score**:
- **high**: You are very certain a search is necessary and a good query can be formed.
- **medium**: A search might be helpful, but the query is a bit ambiguous or could potentially be answered conversationally.
- **low**: A search is probably not needed, but there's a slight chance it could add value.

**Suggested Query**:
- If "search_needed" is true, provide a clean, concise search query that captures the essence of the user's question.
- If "search_needed" is false, this should be null.

**Example 1**:
Query: "Hey, can you explain the concept of quantum entanglement for me?"
Context: "User just said hello."
Output: { "search_needed": true, "confidence": "high", "suggested_query": "explain quantum entanglement", "reasoning": "The user is asking for a factual explanation of a complex scientific topic." }

**Example 2**:
Query: "lol that's funny"
Context: "Bot just told a joke."
Output: { "search_needed": false, "confidence": null, "suggested_query": null, "reasoning": "The user's query is a conversational reaction and does not require a web search." }

**Example 3**:
Query: "what about that new movie?"
Context: "No prior mention of any movie."
Output: { "search_needed": false, "confidence": null, "suggested_query": null, "reasoning": "The query is too vague and lacks specific details to form a useful search query." }

Output ONLY the JSON object.`;

    const userPrompt = `User Query: "${userQueryText}"\n\nRecent Conversation Context:\n${conversationContext || "No context provided."}`;

    try {
      console.log(`[rateWebSearchNecessity] Calling ${modelId} for query: "${userQueryText.substring(0, 100)}..."`);
      const response = await fetchWithRetries(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          temperature: 0.1,
          max_tokens: 250,
          stream: false,
        }),
        customTimeout: 45000,
      });

      if (!response.ok) {
        console.error(`[rateWebSearchNecessity] API error ${response.status}. Defaulting to no search.`);
        return { search_needed: false, confidence: null, suggested_query: null, reasoning: `API error ${response.status}` };
      }

      const data = await response.json();
      if (data.choices && data.choices[0].message && data.choices[0].message.content) {
        let rawContent = data.choices[0].message.content.trim();
        // Extract JSON from markdown code block if present
        const jsonMatch = rawContent.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
          rawContent = jsonMatch[1];
        }
        const result = JSON.parse(rawContent);
        console.log('[rateWebSearchNecessity] Search necessity rating:', result);
        return result;
      }
      console.error('[rateWebSearchNecessity] Unexpected response format. Defaulting to no search.');
      return { search_needed: false, confidence: null, suggested_query: null, reasoning: 'Unexpected API response format' };
    } catch (error) {
      console.error(`[rateWebSearchNecessity] Exception during rating: ${error.message}. Defaulting to no search.`);
      return { search_needed: false, confidence: null, suggested_query: null, reasoning: `Exception: ${error.message}` };
    }
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
        customTimeout: 30000 // 30s
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
2. If the text is unsafe, respond with a JSON object: \`{ "safe": false, "reply_text": "That idea... it's a little too bright. It might burn out my circuits. Let's try something else." }\`.
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


  async monitorBotFollowingFeed() {
    console.log('[MonitorFollowingFeed] Starting to monitor feeds of followed users.');
    const MAX_POSTS_PER_USER_FEED = 5; // Changed from 10 to 5

    try {
      if (!this.agent.session) {
        console.warn('[MonitorFollowingFeed] Bot is not authenticated. Skipping feed monitoring.');
        return;
      }
      const botDid = this.agent.session.did;

      let followingCursor;
      const followedUsers = [];

      // 1. Fetch users the bot is following
      do {
        const resp = await this.agent.api.app.bsky.graph.getFollows({
          actor: botDid,
          limit: 100, // Max limit
          cursor: followingCursor,
        });
        if (!resp.success || !resp.data) {
          console.error('[MonitorFollowingFeed] Could not fetch follows:', resp.data?.error || 'Unknown error');
          break;
        }
        resp.data.follows.forEach(user => followedUsers.push(user));
        followingCursor = resp.data.cursor;
      } while (followingCursor);

      console.log(`[MonitorFollowingFeed] Bot is following ${followedUsers.length} users.`);

      for (const user of followedUsers) {
        console.log(`[MonitorFollowingFeed] Checking feed for user: @${user.handle} (DID: ${user.did})`);
        try {
          let authorFeedCursor;
          const userPosts = [];
          // Fetch a few pages of user's posts to get MAX_POSTS_PER_USER_FEED
          // This loop is a basic pagination example; might need refinement based on API behavior
          while (userPosts.length < MAX_POSTS_PER_USER_FEED) {
            const feedResp = await this.agent.api.app.bsky.feed.getAuthorFeed({
              actor: user.did,
              limit: MAX_POSTS_PER_USER_FEED, // Fetch up to 10, could be less if user has fewer
              cursor: authorFeedCursor,
            });

            if (!feedResp.success || !feedResp.data || !feedResp.data.feed) {
              console.warn(`[MonitorFollowingFeed] Could not fetch feed for @${user.handle}:`, feedResp.data?.error || 'No feed data');
              break;
            }

            feedResp.data.feed.forEach(item => {
              if (item.post && userPosts.length < MAX_POSTS_PER_USER_FEED) {
                // Basic filtering: ignore replies and self-posts by the bot
                if (item.post.author.did === botDid) {
                    // console.log(`[MonitorFollowingFeed] Skipping self-post by bot in @${user.handle}'s feed.`);
                    return;
                }
                // We might want to filter out posts that are replies to others,
                // focusing on original posts by the user for proactive engagement.
                // For now, let's include them and decide later.
                userPosts.push(item.post);
              }
            });

            authorFeedCursor = feedResp.data.cursor;
            if (!authorFeedCursor || feedResp.data.feed.length === 0) {
              break; // No more posts
            }
          }

          console.log(`[MonitorFollowingFeed] Fetched ${userPosts.length} posts from @${user.handle}.`);

          let repliesSentThisScanForUser = 0;
          const todayStr = new Date().toISOString().split('T')[0];

          // Get current daily reply count for this user
          const dailyReplyInfo = this.dailyProactiveReplyCounts.get(user.did) || { date: todayStr, count: 0 };
          if (dailyReplyInfo.date !== todayStr) { // Reset if it's a new day
            dailyReplyInfo.date = todayStr;
            dailyReplyInfo.count = 0;
          }
          let dailyRepliesSentForUser = dailyReplyInfo.count;

          for (const post of userPosts) {
            // --- Reply Limiting Logic ---
            if (repliesSentThisScanForUser >= this.MAX_REPLIES_PER_USER_PER_SCAN) {
              console.log(`[MonitorFollowingFeed] Max replies per scan (${this.MAX_REPLIES_PER_USER_PER_SCAN}) reached for @${user.handle}. Breaking from their feed.`);
              break; // Exit loop for this user's feed
            }

            if (dailyRepliesSentForUser >= this.MAX_DAILY_PROACTIVE_REPLIES_PER_USER) {
              console.log(`[MonitorFollowingFeed] Max daily replies (${this.MAX_DAILY_PROACTIVE_REPLIES_PER_USER}) reached for @${user.handle} for today. Skipping further posts for them in this scan.`);
              break; // No more proactive replies for this user today
            }

            // Check if post has already been processed by this monitor or if bot has already replied to it reactively
            if (this.processedBotFeedPosts.has(post.uri)) {
              // console.log(`[MonitorFollowingFeed] Post ${post.uri} already processed by feed monitor. Skipping.`);
              continue;
            }
            // Also check general reply history (e.g. from direct mentions)
            if (await this.hasAlreadyReplied(post)) {
                // console.log(`[MonitorFollowingFeed] Bot has already replied (reactively) to ${post.uri}. Adding to processed and skipping.`);
                this.processedBotFeedPosts.add(post.uri); // Add here to avoid re-checking via hasAlreadyReplied in future feed scans
                continue;
            }

            // --- Proactive Reply Logic Removed ---
            // The logic for shouldAttemptProactiveReply and sendProactiveReply has been removed
            // to disable automatic replies to posts from followed users.

            // We still need to mark posts as processed to avoid re-evaluating them if other
            // functionality is added to this loop in the future, or if they are very old.
            if (!this.processedBotFeedPosts.has(post.uri)) {
                 // Check if it's old (older than 2 days) to add to processed set.
                if (post.record?.createdAt) {
                    const postDate = new Date(post.record.createdAt);
                    const twoDaysAgo = new Date();
                    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
                    if (postDate < twoDaysAgo) {
                    // console.log(`[MonitorFollowingFeed] Post ${post.uri} is older than 2 days. Adding to processed set.`);
                    this.processedBotFeedPosts.add(post.uri);
                    }
                } else {
                    // If no createdAt, we might add it to processed or handle differently.
                    // For now, if it wasn't replied to and has no date, it's fine to re-evaluate next time
                    // if some other non-reply logic was added.
                    // However, since current function's main goal was replies, and that's removed,
                    // we can be more liberal or simply ensure it's added if we are sure no other action will be taken.
                    // Let's add to processedBotFeedPosts if it wasn't already replied to by reactive means,
                    // just to ensure it's not picked up by some future logic if this function is expanded.
                    if (!await this.hasAlreadyReplied(post)) {
                         // console.log(`[MonitorFollowingFeed] Post ${post.uri} (no date) processed without proactive reply. Adding to processed set.`);
                         this.processedBotFeedPosts.add(post.uri);
                    }
                }
            }
          } // End of for...of userPosts loop

        } catch (feedError) {
          console.error(`[MonitorFollowingFeed] Error processing feed for @${user.handle}:`, feedError);
        }
        // Add a small delay between processing users if needed
        // await utils.sleep(1000);
      }

    } catch (error) {
      console.error('[MonitorFollowingFeed] General error in monitorBotFollowingFeed:', error);
    } finally {
      // Schedule next run - this will be handled by the main calling loop
      console.log('[MonitorFollowingFeed] Finished scan of followed users feeds (auto-reply feature disabled).');
    }
  }

  async shouldAttemptProactiveReply(post, userHandle) {
    // This function is no longer called by monitorBotFollowingFeed for auto-replies.
    // Kept for potential future use or if other parts of the system reference it,
    // but it will currently return false to prevent proactive replies.
    console.log(`[shouldAttemptProactiveReply] Proactive reply feature disabled. Called for post ${post.uri} from @${userHandle}. Returning false.`);
    return false;
  }

  async sendProactiveReply(post, userHandle) {
    // This function is no longer called by monitorBotFollowingFeed for auto-replies.
    // Kept for potential future use.
    console.log(`[sendProactiveReply] Proactive reply feature disabled. Called for post ${post.uri} from @${userHandle}. No action taken.`);
    return false;
  }
} // Closes the LlamaBot class

// Test function for !STOP logic
async function runStopCommandTests(botInstance) {
  console.log("--- Running !STOP Command Tests ---");

  const testBot = botInstance; // Use the passed bot instance

  // Mock notifications for testing the !STOP logic directly
  // These won't go through the full monitor loop's API calls,
  // but will test the specific blocklist and sentiment logic.

  const mockNotificationBase = {
    uri: "at://did:plc:test/app.bsky.feed.post/test1",
    cid: "bafyreiambryh4xijexr7axohozwqgfs52vqgsksg532n35jdsf7t6n2x5a",
    reason: "mention",
    isRead: false,
    indexedAt: new Date().toISOString(),
    record: {
      $type: "app.bsky.feed.post",
      text: "", // Will be overridden
      createdAt: new Date().toISOString(),
      langs: ["en"],
    }
  };

  // Test Case 1: !STOP with negative sentiment
  let notif1 = JSON.parse(JSON.stringify(mockNotificationBase)); // Deep copy
  notif1.author = { handle: "userNegativeStop.test", did: "did:plc:negativestop" };
  notif1.record.text = "This bot is annoying, !STOP messaging me";
  notif1.uri = "at://did:plc:test/app.bsky.feed.post/negstop";

  console.log(`\nTest 1: Simulating message from @${notif1.author.handle}: "${notif1.record.text}"`);
  // Simulate the relevant part of the monitor loop
  // For these tests, we'll directly check conditions and call blocklist/reply logic
  // rather than fully replicating the monitor's notification iteration.

  // Test Case 1: !STOP with negative sentiment
  console.log(`\nTest 1: Simulating message from @${notif1.author.handle}: "${notif1.record.text}"`);
  if (notif1.record.text.toLowerCase().includes('!stop')) {
    const sentimentResult = testBot.sentimentAnalyzer.analyze(notif1.record.text);
    console.log(`Test 1: Sentiment score: ${sentimentResult.score}`);
    if (sentimentResult.score <= 0) {
      testBot.userBlocklist.add(notif1.author.handle);
      console.log(`Test 1: @${notif1.author.handle} ADDED to blocklist.`);
      // Simulate sending the !STOP confirmation message
      const stopConfirmMsg = `Simulated reply to ${notif1.author.handle}: You have been added to my blocklist... You can use !RESUME...`;
      console.log(stopConfirmMsg);
    } else {
      console.log(`Test 1: @${notif1.author.handle} NOT added to blocklist.`);
    }
  }
  console.log(`Test 1: Blocklist contains @${notif1.author.handle}: ${testBot.userBlocklist.has(notif1.author.handle)} (Expected: true)`);

  // Test Case 2: !STOP with neutral sentiment
  let notif2 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif2.author = { handle: "userNeutralStop.test", did: "did:plc:neutralstop" };
  notif2.record.text = "Please !STOP";
  notif2.uri = "at://did:plc:test/app.bsky.feed.post/neutralstop";

  console.log(`\nTest 2: Simulating message from @${notif2.author.handle}: "${notif2.record.text}"`);
  if (notif2.record.text.toLowerCase().includes('!stop')) {
    const sentimentResult = testBot.sentimentAnalyzer.analyze(notif2.record.text);
    console.log(`Test 2: Sentiment score: ${sentimentResult.score}`);
    if (sentimentResult.score <= 0) {
      testBot.userBlocklist.add(notif2.author.handle);
      console.log(`Test 2: @${notif2.author.handle} ADDED to blocklist.`);
      const stopConfirmMsg = `Simulated reply to ${notif2.author.handle}: You have been added to my blocklist... You can use !RESUME...`;
      console.log(stopConfirmMsg);
    } else {
      console.log(`Test 2: @${notif2.author.handle} NOT added to blocklist.`);
    }
  }
  console.log(`Test 2: Blocklist contains @${notif2.author.handle}: ${testBot.userBlocklist.has(notif2.author.handle)} (Expected: true)`);

  // Test Case 3: !STOP with positive sentiment
  let notif3 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif3.author = { handle: "userPositiveStop.test", did: "did:plc:positivestop" };
  notif3.record.text = "Thanks for the help, but !STOP for now, cheers!";
  notif3.uri = "at://did:plc:test/app.bsky.feed.post/posstop";

  console.log(`\nTest 3: Simulating message from @${notif3.author.handle}: "${notif3.record.text}"`);
  if (notif3.record.text.toLowerCase().includes('!stop')) {
    const sentimentResult = testBot.sentimentAnalyzer.analyze(notif3.record.text);
    console.log(`Test 3: Sentiment score: ${sentimentResult.score}`);
    if (sentimentResult.score <= 0) {
      testBot.userBlocklist.add(notif3.author.handle);
      console.log(`Test 3: @${notif3.author.handle} ADDED to blocklist.`);
      // Should not send !RESUME info if not blocking.
    } else {
      console.log(`Test 3: @${notif3.author.handle} NOT added to blocklist. Message ignored.`);
    }
  }
  console.log(`Test 3: Blocklist contains @${notif3.author.handle}: ${testBot.userBlocklist.has(notif3.author.handle)} (Expected: false)`);

  // Test Case 4: Message from a blocklisted user (userNegativeStop.test should be on blocklist from Test 1)
  let notif4 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif4.author = { handle: "userNegativeStop.test", did: "did:plc:negativestop" }; // Same as Test 1 user
  notif4.record.text = "Hello again";
  notif4.uri = "at://did:plc:test/app.bsky.feed.post/blocktest";

  console.log(`\nTest 4: Simulating message from blocklisted user @${notif4.author.handle}: "${notif4.record.text}"`);
  let processed4 = true;
  if (testBot.userBlocklist.has(notif4.author.handle)) {
    console.log(`Test 4: Message from @${notif4.author.handle} IGNORED (user is blocklisted).`);
    processed4 = false;
  } else if (notif4.record.text.toLowerCase().includes('!stop')) {
     // This case should ideally not be hit if blocklist check is first, but for completeness
    console.log(`Test 4: Message from @${notif4.author.handle} contains !STOP and would be handled by stop logic.`);
    processed4 = false;
  }
  console.log(`Test 4: Message processed (should be false if blocklisted): ${processed4} (Expected: false)`);

  // Test Case 5: Normal message from a non-blocklisted user
  let notif5 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif5.author = { handle: "userNormal.test", did: "did:plc:normaluser" };
  notif5.record.text = "Hi bot";
  notif5.uri = "at://did:plc:test/app.bsky.feed.post/normalmsg";

  console.log(`\nTest 5: Simulating message from normal user @${notif5.author.handle}: "${notif5.record.text}"`);
  let processed5 = true; // Assuming it would be processed if not caught by block/stop
  if (testBot.userBlocklist.has(notif5.author.handle)) {
    console.log(`Test 5: Message from @${notif5.author.handle} IGNORED (user is blocklisted).`);
    processed5 = false;
  } else if (notif5.record.text.toLowerCase().includes('!stop')) {
    console.log(`Test 5: Message from @${notif5.author.handle} contains !STOP and would be handled by stop logic.`);
    processed5 = false;
  } else if (notif5.record.text.toLowerCase().trim() === '!help') {
    console.log(`Test 5: Message from @${notif5.author.handle} is !HELP. Help message would be sent.`);
    const helpMsg = "Simulated reply to userNormal.test: Available commands...";
    console.log(helpMsg);
    processed5 = false; // For this test, consider it "handled" by help
  } else if (notif5.record.text.toLowerCase().trim() === '!resume') {
    console.log(`Test 5: Message from @${notif5.author.handle} is !RESUME. Resume logic would run.`);
     processed5 = false; // For this test, consider it "handled" by resume
  }
  console.log(`Test 5: Message processed for normal reply (should be true if not a command): ${processed5} (Expected: true for "Hi bot")`);

  // Test Case 6: !HELP command
  let notif6 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif6.author = { handle: "userHelp.test", did: "did:plc:helpuser" };
  notif6.record.text = "!help";
  notif6.uri = "at://did:plc:test/app.bsky.feed.post/helpcmd";

  console.log(`\nTest 6: Simulating message from @${notif6.author.handle}: "${notif6.record.text}"`);
  if (notif6.record.text.toLowerCase().trim() === '!help') {
    const helpText = "Available commands:\n" +
                     "- `!STOP`: Ask me to stop sending you messages. (Sentiment-based)\n" +
                     "- `!RESUME`: Ask me to start sending messages again if you used `!STOP`.\n" +
                     "- `!MUTE`: Ask me to stop replying in the current thread.\n" +
                     "- `!HELP`: Show this help message.";
    console.log(`Test 6: Bot would reply with: "${helpText}" (Expected to include !MUTE)`);
  }
  console.log("Test 6: Help command simulation complete.");

  // Test Case 7: !RESUME command for a blocklisted user (userNeutralStop.test should be blocklisted from Test 2)
  let notif7 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif7.author = { handle: "userNeutralStop.test", did: "did:plc:neutralstop" };
  notif7.record.text = "!resume";
  notif7.uri = "at://did:plc:test/app.bsky.feed.post/resumecmd_blocked";

  console.log(`\nTest 7: Simulating !RESUME from blocklisted user @${notif7.author.handle}`);
  console.log(`Test 7: Before RESUME, blocklist contains @${notif7.author.handle}: ${testBot.userBlocklist.has(notif7.author.handle)} (Expected: true)`);
  if (notif7.record.text.toLowerCase().trim() === '!resume') {
    if (testBot.userBlocklist.has(notif7.author.handle)) {
      testBot.userBlocklist.delete(notif7.author.handle);
      console.log(`Test 7: @${notif7.author.handle} REMOVED from blocklist.`);
      const resumeConfirmMsg = `Simulated reply to ${notif7.author.handle}: Welcome back! ...`;
      console.log(resumeConfirmMsg);
    } else {
      console.log(`Test 7: @${notif7.author.handle} was NOT on blocklist.`);
    }
  }
  console.log(`Test 7: After RESUME, blocklist contains @${notif7.author.handle}: ${testBot.userBlocklist.has(notif7.author.handle)} (Expected: false)`);

  // Test Case 8: !RESUME command for a user NOT on the blocklist
  let notif8 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif8.author = { handle: "userNeverBlocked.test", did: "did:plc:neverblocked" };
  notif8.record.text = "!resume";
  notif8.uri = "at://did:plc:test/app.bsky.feed.post/resumecmd_notblocked";

  console.log(`\nTest 8: Simulating !RESUME from non-blocklisted user @${notif8.author.handle}`);
  console.log(`Test 8: Before RESUME, blocklist contains @${notif8.author.handle}: ${testBot.userBlocklist.has(notif8.author.handle)} (Expected: false)`);
  if (notif8.record.text.toLowerCase().trim() === '!resume') {
    if (testBot.userBlocklist.has(notif8.author.handle)) {
      // This path should not be taken for this test case
      testBot.userBlocklist.delete(notif8.author.handle);
      console.log(`Test 8: @${notif8.author.handle} REMOVED from blocklist (UNEXPECTED).`);
    } else {
      console.log(`Test 8: @${notif8.author.handle} was NOT on blocklist. Bot would inform them.`);
      const notBlockedMsg = `Simulated reply to ${notif8.author.handle}: Thanks for checking in! You were not on my blocklist.`;
      console.log(notBlockedMsg);
    }
  }
  console.log(`Test 8: After RESUME, blocklist contains @${notif8.author.handle}: ${testBot.userBlocklist.has(notif8.author.handle)} (Expected: false)`);

  // Test Case 9: !MUTE command
  let notif9 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif9.author = { handle: "userMute.test", did: "did:plc:muteuser" };
  notif9.record.text = "!mute";
  notif9.uri = "at://did:plc:test/app.bsky.feed.post/mutecmd_thread1"; // This URI will be the root for this test
  // For this test, notif9.uri is also the rootUri since it's not a reply.
  const thread1RootUri = notif9.uri;

  console.log(`\nTest 9: Simulating !MUTE from @${notif9.author.handle} in thread ${thread1RootUri}`);
  if (notif9.record.text.toLowerCase().trim() === '!mute') {
    testBot.mutedThreads.add(thread1RootUri);
    console.log(`Test 9: Thread ${thread1RootUri} ADDED to mutedThreads.`);
    const muteConfirmMsg = `Simulated reply to ${notif9.author.handle}: Okay, I will not reply further in this thread...`;
    console.log(muteConfirmMsg);
  }
  console.log(`Test 9: mutedThreads contains ${thread1RootUri}: ${testBot.mutedThreads.has(thread1RootUri)} (Expected: true)`);

  // Test Case 10: Message in a muted thread
  let notif10 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif10.author = { handle: "anotherUser.test", did: "did:plc:anotheruser" };
  notif10.record.text = "Hello in muted thread";
  notif10.uri = "at://did:plc:test/app.bsky.feed.post/msg_in_muted_thread";
  // Simulate this message being a reply within thread1
  notif10.record.reply = {
    root: { uri: thread1RootUri, cid: "somecid1" },
    parent: { uri: notif9.uri, cid: notif9.cid }
  };
  const notif10ThreadRoot = notif10.record.reply.root.uri;

  console.log(`\nTest 10: Simulating message from @${notif10.author.handle} in muted thread ${notif10ThreadRoot}`);
  let processed10 = true;
  if (testBot.mutedThreads.has(notif10ThreadRoot)) {
    console.log(`Test 10: Message from @${notif10.author.handle} IGNORED (thread is muted).`);
    processed10 = false;
  }
  console.log(`Test 10: Message processed (should be false if thread muted): ${processed10} (Expected: false)`);

  // Test Case 11: Message in a different, non-muted thread
  let notif11 = JSON.parse(JSON.stringify(mockNotificationBase));
  notif11.author = { handle: "userNormal.test", did: "did:plc:normaluser2" };
  notif11.record.text = "Hi in a new thread";
  notif11.uri = "at://did:plc:test/app.bsky.feed.post/newthreadmsg";
  // This message is its own root
  const thread2RootUri = notif11.uri;

  console.log(`\nTest 11: Simulating message from @${notif11.author.handle} in new thread ${thread2RootUri}`);
  let processed11 = true;
   if (testBot.userBlocklist.has(notif11.author.handle)) { // Standard blocklist check
    console.log(`Test 11: Message from @${notif11.author.handle} IGNORED (user is blocklisted).`);
    processed11 = false;
  } else if (testBot.mutedThreads.has(thread2RootUri)) { // Mute check
    console.log(`Test 11: Message from @${notif11.author.handle} IGNORED (thread is muted, UNEXPECTED for this test).`);
    processed11 = false;
  }
  console.log(`Test 11: Message processed (should be true): ${processed11} (Expected: true)`);
  console.log(`Test 11: mutedThreads still contains ${thread1RootUri}: ${testBot.mutedThreads.has(thread1RootUri)} (Expected: true)`);
  console.log(`Test 11: mutedThreads does not contain ${thread2RootUri}: ${!testBot.mutedThreads.has(thread2RootUri)} (Expected: true)`);

  // Test Case 12: isBot function
  console.log("\n--- Testing isBot function ---");
  const botUser = { handle: 'testbot.bsky.social', profile: { description: 'I am a bot' } };
  const normalUser = { handle: 'testuser.bsky.social', profile: { description: 'I am a human' } };
  const isBotResult = await testBot.isBot(botUser.handle, botUser.profile);
  const isNotBotResult = await testBot.isBot(normalUser.handle, normalUser.profile);
  console.log(`isBot('testbot.bsky.social', botUser.profile): ${isBotResult} (Expected: true)`);
  console.log(`isBot('testuser.bsky.social', normalUser.profile): ${isNotBotResult} (Expected: false)`);
  testBot.config.KNOWN_BOTS = ['knownbot.bsky.social'];
  const isKnownBotResult = await testBot.isBot('knownbot.bsky.social', normalUser.profile);
  console.log(`isBot('knownbot.bsky.social', normalUser.profile): ${isKnownBotResult} (Expected: true)`);

  console.log("\n--- Command Tests Complete ---");
  // Clear blocklist and mutedThreads after tests
  testBot.userBlocklist.clear();
  testBot.mutedThreads.clear();
  console.log("Blocklist and MutedThreads cleared for subsequent operations.");
}


// Initialize and run the bot
async function startBots() {
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const llamaBot = new LlamaBot({
    ...config,
    BLUESKY_IDENTIFIER: config.BLUESKY_IDENTIFIER,
    BLUESKY_APP_PASSWORD: config.BLUESKY_APP_PASSWORD,
  }, agent);

  // Run inline tests
  await runStopCommandTests(llamaBot);

  // Start monitoring notifications
  llamaBot.monitor().catch(e => console.error("Error in main notification monitor loop:", e));

  // Start monitoring followed users' feeds on a separate interval
  const runFollowFeedMonitor = async () => {
    try {
      await llamaBot.authenticate(); // Ensure authenticated before this specific monitor runs too
      await llamaBot.monitorBotFollowingFeed();
    } catch (error) {
      console.error("Error in monitorBotFollowingFeed execution:", error);
    } finally {
      // Schedule the next run
      setTimeout(runFollowFeedMonitor, config.FOLLOW_FEED_CHECK_INTERVAL);
      console.log(`[MainLoop] Next follow feed scan scheduled in ${config.FOLLOW_FEED_CHECK_INTERVAL / 1000 / 60} minutes.`);
    }
  };

  // Initial call to start the follow feed monitoring loop after a short delay (e.g., to allow initial auth)
  // setTimeout(runFollowFeedMonitor, 10000); // Start after 10 seconds - DISABLED as per user request

}

startBots().catch(console.error);

//end of index.js
