import { AtpAgent } from '@atproto/api';
import config from './config.js';
import fetch from 'node-fetch';
import express from 'express';

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
const utils = {
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  async imageUrlToBase64(imageUrl) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        console.error(`Error fetching image from URL: ${response.status} ${response.statusText}. URL: ${imageUrl}`);
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    } catch (error) {
      console.error(`Error converting image to base64 (URL: ${imageUrl}):`, error);
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

  async handleAdminPostCommand(post, commandContent, isImageCommand) {
    if (await this.hasAlreadyReplied(post)) {
      console.log(`[ADMIN_CMD_SKIP_REPLIED] Post URI ${post.uri} already replied or processed, skipping in handleAdminPostCommand.`);
      return;
    }

    console.log(`[HANDLE_ADMIN_POST_COMMAND_ENTER] Timestamp: ${new Date().toISOString()}, Post URI: ${post.uri}, Command Content: "${commandContent}", IsImageCommand: ${isImageCommand}`);

    try {
      this.repliedPosts.add(post.uri);
      console.log(`[HANDLE_ADMIN_POST_COMMAND_PROCESSED_URI] Timestamp: ${new Date().toISOString()}, Added to repliedPosts: ${post.uri}`);

      const context = await this.getReplyContext(post);

      let textForLLM = commandContent;
      let imgPrompt = "";

      if (isImageCommand) {
        console.log(`[DEBUG_IMG_FLOW] isImageCommand is true. Initial commandContent for splitting: "${commandContent}"`);
        const parts = commandContent.split('+image');
        if (parts.length > 1 && commandContent.includes('+image')) {
            textForLLM = parts[0].trim();
            imgPrompt = parts[1].trim();
        } else {
            textForLLM = "";
            imgPrompt = commandContent.trim();
        }
        console.log(`[DEBUG_IMG_FLOW] Determined for Image Command: textForLLM: "${textForLLM}", imgPrompt: "${imgPrompt}"`);
      } else {
        console.log(`[DEBUG_IMG_FLOW] isImageCommand is false. textForLLM set to commandContent: "${textForLLM}"`);
      }

      if (isImageCommand && !textForLLM && !imgPrompt) {
          console.warn(`Admin command: !post+image used but both text and image prompts are effectively empty after parsing. Post URI: ${post.uri}`);
          await this.postReply(post, "Admin command '!post+image' requires a valid image prompt or text for the post.");
          return;
      }

      const newPostText = await this.generateStandalonePostFromContext(context, textForLLM);

      if (newPostText) {
        console.log(`Admin command: Generated new post text (first 50 chars): "${newPostText.substring(0,50)}..."`);
      } else {
        console.warn(`Admin command: generateStandalonePostFromContext returned no text for LLM prompt: "${textForLLM}"`);
      }

      let finalPostText = newPostText;
      let imageBase64 = null;
      let imageAltText = "Generated image";
      let imageGenError = null;

      if (isImageCommand) {
        console.log(`[DEBUG_IMG_BLOCK] Image processing initiated. Actual image prompt to use: "${imgPrompt}"`);
        if (imgPrompt && imgPrompt.length > 0) {
          console.log(`Admin command: Image requested. Passing to Scout. Prompt: "${imgPrompt}"`);
          const scoutResult = await this.processImagePromptWithScout(imgPrompt);
          console.log(`[DEBUG_IMG_BLOCK] Scout result: ${JSON.stringify(scoutResult)}`);

          if (!scoutResult.safe) {
            imageGenError = scoutResult.reply_text || "Image prompt deemed unsafe by Scout.";
            console.warn(`Admin command: Image prompt "${imgPrompt}" deemed unsafe. Reason: ${imageGenError}`);
          } else {
            console.log(`Admin command: Scout deemed prompt safe. Refined prompt for Flux: "${scoutResult.image_prompt}"`);
            imageBase64 = await this.generateImage(scoutResult.image_prompt);
            console.log(`[DEBUG_IMG_BLOCK] generateImage returned: ${imageBase64 ? 'base64 data received' : 'null'}`);

            if (imageBase64) {
              console.log(`Admin command: Image generated successfully by Flux.`);
              const describedAltText = await this.describeImageWithScout(imageBase64);
              if (describedAltText) {
                imageAltText = describedAltText;
                console.log(`Admin command: Image described by Scout for alt text: "${imageAltText}"`);
              } else {
                console.warn(`Admin command: Scout failed to describe the image. Using default alt text: "${imageAltText}"`);
              }

              if (!textForLLM && (!finalPostText || finalPostText.trim() === "")) {
                if (imageAltText !== "Generated image" && imageAltText.length > 0) {
                    finalPostText = imageAltText;
                    console.log(`[DEBUG_IMG_BLOCK] Used image alt text as finalPostText because textForLLM and newPostText were empty.`);
                } else {
                    finalPostText = "Here's an image I generated:";
                    console.log(`[DEBUG_IMG_BLOCK] Used generic message as finalPostText because textForLLM, newPostText were empty and alt text was default/empty.`);
                }
              }
            } else {
              imageGenError = "Image generation by Flux failed (returned null).";
              console.warn(`Admin command: Image generation failed for prompt (Flux returned null): "${scoutResult.image_prompt}"`);
            }
          }
        } else {
          imageGenError = "Image requested with '+image' command, but no image prompt was actually provided or extracted.";
          console.log(`Admin command: isImageCommand was true, but imgPrompt was empty. Setting error: "${imageGenError}"`);
        }
      } else {
         console.log(`[DEBUG_IMG_BLOCK] No image was requested (isImageCommand is false).`);
      }

      if (finalPostText || imageBase64) {
        console.log(`[DEBUG_POSTING_LOGIC] Attempting post. finalPostText (first 50): "${finalPostText ? finalPostText.substring(0,50)+'...' : 'null'}", imageBase64 present: ${!!imageBase64}`);
        const postSuccess = await this.postToOwnFeed(finalPostText, imageBase64, imageAltText);

        if (postSuccess) {
          let confirmationMessage = `Admin command executed.`;
          if (finalPostText && imageBase64) {
            confirmationMessage += ` I've posted text ("${utils.truncateResponse(finalPostText, 50)}") and an image to my feed.`;
          } else if (finalPostText) {
            confirmationMessage += ` I've posted the following text to my feed: "${utils.truncateResponse(finalPostText, 100)}"`;
          } else if (imageBase64) {
            confirmationMessage += ` I've posted an image to my feed.`;
          }

          if (isImageCommand && imageGenError) {
            confirmationMessage += ` (Note: Image processing failed: ${imageGenError})`;
          } else if (isImageCommand && !imageBase64 && !imageGenError) {
            confirmationMessage += ` (Note: Image was requested but not generated; verify prompt if provided).`;
          }

          await this.postReply(post, confirmationMessage);
          console.log(`Sent confirmation reply to admin for post URI: ${post.uri}. Message: "${confirmationMessage}"`);
        } else {
          const failureReason = `Admin command: postToOwnFeed failed for post URI: ${post.uri}. finalPostText: ${finalPostText ? '"'+finalPostText.substring(0,50)+"...\"" : 'null'}, imageBase64 present: ${!!imageBase64}.`;
          console.warn(failureReason);
          await this.postReply(post, "Admin command failed: Could not post to my own feed. " + (imageGenError ? `Image error: ${imageGenError}`: ""));
        }
      } else if (imageGenError && isImageCommand) {
         const reason = `Admin command: No text generated AND image generation failed for post URI: ${post.uri}. Error: ${imageGenError}`;
         console.warn(reason);
         await this.postReply(post, `Admin command failed: No text was generated and image generation failed: ${imageGenError}`);
      } else if (!finalPostText && !isImageCommand) {
         const reason = `Admin command: Could not generate any content for the post (no text from LLM, and no image requested). Post URI: ${post.uri}.`;
         console.warn(reason);
         await this.postReply(post, "Admin command failed: Could not generate any content for the post.");
      } else {
        console.log(`[DEBUG_POSTING_LOGIC] Nothing to post. finalPostText is empty/null and no imageBase64. isImageCommand: ${isImageCommand}, imageGenError: ${imageGenError}`);
        if (!imageGenError && !(finalPostText && finalPostText.length > 0) && !imageBase64 ) {
            await this.postReply(post, "Admin command resulted in no content to post.");
        }
      }
    } catch (error) {
      console.error(`FATAL Error handling admin command for post ${post.uri}:`, error);
      await this.postReply(post, `An unexpected error occurred while handling the admin command: ${error.message}`);
    }
  }

  async generateStandalonePostFromContext(context, adminInstructions) {
    console.log('BaseBot.generateStandalonePostFromContext called. Context (sample):', context ? JSON.stringify(context.slice(0,1)) : "null", 'Instructions:', adminInstructions);
    return 'Placeholder post text generated from context by BaseBot.';
  }

  async postToOwnFeed(text, imageBase64 = null, altText = "Generated image") {
    const postText = text ? utils.truncateResponse(text) : (imageBase64 ? "" : null);
    if (postText === null && !imageBase64) {
      console.warn(`[postToOwnFeed] Attempted to post with no text and no image. Aborting.`);
      return false;
    }
    console.log(`Attempting to post to own feed. Text: "${postText}"`, imageBase64 ? `Image included (Alt: "${altText}")` : "No image.");
    try {
      RateLimit.check();
      const postObject = {};
      if (postText !== null && postText.trim() !== "") {
        postObject.text = postText;
      } else if (postText === "" && !imageBase64) {
        console.warn('[postToOwnFeed] Attempting to post with empty text and no image. Aborting.');
        return false;
      } else if (postText === "" && imageBase64) {
         postObject.text = "";
      }

      if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
        console.log(`[postToOwnFeed] imageBase64 received, length: ${imageBase64.length}. Attempting to upload.`);
        try {
          const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
          console.log(`[postToOwnFeed] Converted base64 to Uint8Array, size: ${imageBytes.length} bytes.`);
          if (imageBytes.length === 0) {
            console.error('[postToOwnFeed] Image byte array is empty after conversion. Skipping image upload for this attempt.');
          } else {
            const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: 'image/png' });
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
      } else if (imageBase64) {
        console.warn(`[postToOwnFeed] imageBase64 was present but invalid. Length: ${imageBase64 ? imageBase64.length : 'null'}. Skipping image embed.`);
      }

      if (Object.keys(postObject).length === 0 || (postObject.text === undefined && !postObject.embed)) {
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
            if (currentPostObject.author.handle === this.config.ADMIN_BLUESKY_HANDLE &&
                currentPostObject.record.text &&
                currentPostObject.record.text.includes('!post')) {

              const commandText = currentPostObject.record.text;
              let commandContent = "";
              let isImageCommand = false;
              let commandSearchText = commandText;
              const botMention = `@${this.config.BLUESKY_IDENTIFIER}`;

              if (commandText.startsWith(botMention)) {
                  commandSearchText = commandText.substring(botMention.length).trim();
              }

              if (commandSearchText.startsWith("!post+image ")) {
                  isImageCommand = true;
                  commandContent = commandSearchText.substring("!post+image ".length).trim();
              } else if (commandSearchText.startsWith("!post ")) {
                  isImageCommand = false;
                  commandContent = commandSearchText.substring("!post ".length).trim();
              }

              if (commandSearchText.startsWith("!post+image ") || commandSearchText.startsWith("!post ")) {
                console.log(`[Monitor] Admin command detected: "${commandSearchText}" in post ${currentPostObject.uri}`);
                await this.handleAdminPostCommand(currentPostObject, commandContent, isImageCommand);
                isAdminCmdHandled = true;
              } else {
                console.log(`[Monitor] Admin post ${currentPostObject.uri} included '!post' but not as a recognized command prefix.`);
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

              if (responseText) { // generateResponse now handles search history internally and might return null
                // Image generation request detection (simplified for brevity, actual logic is more complex)
                const imageRequestKeywords = ["generate image", "create a picture of"]; // Simplified
                let isImageRequest = false;
                let imagePrompt = "";
                const lowercasedText = (currentPostObject.record.text || "").toLowerCase();
                for (const keyword of imageRequestKeywords) {
                    if (lowercasedText.includes(keyword)) {
                        isImageRequest = true;
                        imagePrompt = lowercasedText.replace(keyword, "").trim().replace(/^of /,"").trim();
                        break;
                    }
                }

                if (isImageRequest && imagePrompt) {
                    console.log(`[Monitor] Image request detected in ${currentPostObject.uri}. Prompt: "${imagePrompt}"`);
                    const scoutResult = await this.processImagePromptWithScout(imagePrompt);
                    if (!scoutResult.safe) {
                        await this.postReply(currentPostObject, `${responseText}\n\nRegarding your image request: ${scoutResult.reply_text}`);
                    } else {
                        const imageBase64 = await this.generateImage(scoutResult.image_prompt);
                        if (imageBase64) {
                            const altText = await this.describeImageWithScout(imageBase64) || "Generated image";
                            await this.postReply(currentPostObject, `${responseText}\n\nHere's the image you requested:`, imageBase64, altText);
                        } else {
                            await this.postReply(currentPostObject, `${responseText}\n\nI tried to generate an image for "${scoutResult.image_prompt}", but it didn't work out this time.`);
                        }
                    }
                } else {
                    await this.postReply(currentPostObject, responseText);
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
        let currentUri = post.uri;
        while (currentUri) {
          const { data: thread } = await this.agent.getPostThread({ uri: currentUri, depth: 0, parentHeight: 1 });
          if (!thread.thread.post) break;
          const images = thread.thread.post.record.embed?.images || thread.thread.post.record.embed?.media?.images || [];
          conversation.unshift({
            author: thread.thread.post.author.handle,
            text: thread.thread.post.record.text,
            images: images.map(img => ({ alt: img.alt, url: thread.thread.post.embed?.images?.[0]?.fullsize || thread.thread.post.embed?.images?.[0]?.thumb || img.image?.fullsize || img.image?.thumb }))
          });
          currentUri = thread.thread.parent?.post?.uri;
        }
      }
      return conversation;
    } catch (error) {
      console.error('Error fetching reply context:', error);
      return [];
    }
  }

  async postReply(post, response, imageBase64 = null, altText = "Generated image", embedRecordDetails = null) {
    try {
      RateLimit.check();
      RateLimit.check();
      RateLimit.check();
      const CHAR_LIMIT_PER_POST = 300; // Bluesky's actual limit
      const PAGE_SUFFIX_MAX_LENGTH = " ... [X/Y]".length; // Approx length of " ... [1/3]"
      const MAX_PARTS = 3;
      let textParts = [];
      const postedPartUris = []; // Initialize array to store URIs of posted parts

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

          // Embed logic: Record embed takes precedence if provided.
          // Image embed is only considered if no record embed and it's the last part.
          if (isLastPart && embedRecordDetails && embedRecordDetails.uri && embedRecordDetails.cid) {
            replyObject.embed = {
              $type: 'app.bsky.embed.record',
              record: {
                uri: embedRecordDetails.uri,
                cid: embedRecordDetails.cid
              }
            };
            console.log(`[postReply] Record embed for part ${i+1}/${totalParts} created for URI: ${embedRecordDetails.uri}`);
          } else if (isLastPart && imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
              try {
                  const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
                  if (imageBytes.length === 0) {
                      console.error('[postReply] Image byte array is empty for last part. Skipping image upload.');
                  } else {
                      const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: 'image/png' });
                      if (uploadedImage && uploadedImage.data && uploadedImage.data.blob) {
                          replyObject.embed = { $type: 'app.bsky.embed.images', images: [{ image: uploadedImage.data.blob, alt: altText }] };
                          console.log(`[postReply] Image embed for part ${i+1}/${totalParts} created with alt text: "${altText}"`);
                      } else {
                          console.error('[postReply] Uploaded image data or blob is missing. Cannot embed image for last part.');
                      }
                  }
              } catch (uploadError) { console.error(`[postReply] Error during image upload for part ${i+1}/${totalParts}:`, uploadError); }
          } else if (isLastPart && imageBase64) { // imageBase64 present but invalid, or some other case
              console.warn(`[postReply] imageBase64 was present for last part but invalid, or record embed took precedence. Skipping image embed if applicable.`);
          }

          // If only an image or only a record embed is being posted (no text parts initially)
          if (totalParts === 1 && textParts.length === 0 && (imageBase64 || embedRecordDetails)) {
            replyObject.text = replyObject.text || ""; // Ensure text is at least an empty string if there's an embed and no other text.
          }

          // If there's an embed, and the text is completely empty, Bluesky might require text to be explicitly null or not present.
          // However, the current logic sets text to "" if it was going to be empty with an embed.
          // For now, an empty string `text: ""` with an embed is generally acceptable.

          console.log(`[postReply] Attempting to post part ${i + 1}/${totalParts}. Text: "${replyObject.text.substring(0,50)}..." Embed type: ${replyObject.embed ? replyObject.embed.$type : 'none'}`);
          const result = await this.agent.post(replyObject);
          console.log(`Successfully posted part ${i + 1}/${totalParts}: ${result.uri}`);
          postedPartUris.push(result.uri); // Add successfully posted URI

          if (!isLastPart) { // For the next part, reply to the part just posted
              currentReplyTo = {
                  root: currentReplyTo.root, // Root stays the same
                  parent: { uri: result.uri, cid: result.cid }
              };
          }
      }
      this.repliedPosts.add(post.uri); // Add original post URI to replied set after all parts are sent
      return postedPartUris; // Return the array of URIs
    } catch (error) {
      console.error('Error posting multi-part reply:', error);
      this.repliedPosts.add(post.uri); // Still mark as replied to avoid loops on error
      return postedPartUris; // Return any URIs that were successfully posted before the error
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
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [ { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}` }, { role: "user", content: userPrompt } ],
          temperature: 0.90, max_tokens: 100, stream: false
        })
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
      let initialResponse = data.choices[0].message.content.trim();
      console.log(`[LlamaBot.generateStandalonePostFromContext] Initial response from nvidia/llama-3.3-nemotron-super-49b-v1: "${initialResponse}"`);

      console.log(`NIM CALL START: filterResponse for model meta/llama-4-scout-17b-16e-instruct in generateStandalonePostFromContext`);
      const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct',
          messages: [
            { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. The text is from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks that make the entire text appear as a direct quote. 3. Remove any sender attributions like 'Bot:' or 'Nemotron says:'. 4. Remove any double asterisks (`**`) used for emphasis, as they do not render correctly. 5. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear in the original text. DO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change sentence structure. Output only the processed text. This is an internal formatting step; do not mention it." },
            { role: "user", content: initialResponse }
          ],
          temperature: 0.1, // Temperature for formatting (already lowered)
          max_tokens: 100,
          stream: false
        })
      });
      console.log(`NIM CALL END: filterResponse for model meta/llama-4-scout-17b-16e-instruct in generateStandalonePostFromContext - Status: ${filterResponse.status}`);
      if (!filterResponse.ok) {
        const errorText = await filterResponse.text();
        console.error(`Nvidia NIM API error (filter model) in generateStandalonePostFromContext (${filterResponse.status}) - Text: ${errorText}`);
        return initialResponse;
      }
      const filterData = await filterResponse.json();
      if (!filterData.choices || !Array.isArray(filterData.choices) || filterData.choices.length === 0 || !filterData.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM (filter model) in generateStandalonePostFromContext:', JSON.stringify(filterData));
        return initialResponse;
      }
      const finalResponse = filterData.choices[0].message.content.trim();
      console.log(`[LlamaBot.generateStandalonePostFromContext] Final response from meta/llama-4-scout-17b-16e-instruct: "${finalResponse}"`);
      return finalResponse;
    } catch (error) {
      console.error('Error in LlamaBot.generateStandalonePostFromContext:', error);
      return null;
    }
  }

  async generateResponse(post, context) {
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

            let currentDetailReplyTarget = {
              root: storedDataForFollowUp.replyToRootUri,
              parent: { uri: summaryPostUriUserIsReplyingTo, cid: post.record.reply.parent.cid }
            };

            const detailImageBase64 = storedDataForFollowUp.imageBase64;
            const detailAltText = storedDataForFollowUp.altText;

            // The 'post' object here is the user's message like "yes, tell me more".
            // We need to reply to the bot's summary message, which is storedDataForFollowUp.summaryPostUri
            // And the root of the thread is storedDataForFollowUp.replyToRootUri

            let replyTargetForThisSequence = { // This is what each detailed point will reply to initially.
                root: { uri: storedDataForFollowUp.replyToRootUri, cid: null }, // CID of root is not critical here, URI is.
                parent: { uri: storedDataForFollowUp.summaryPostUri, cid: null } // Replying to the bot's summary post.
            };
            // The `post` object that `this.postReply` needs should be a mock or minimal representation
            // of the post we are replying to, for constructing the replyRef.
            // Let's construct a minimal 'parentPostForReply' object.
             const parentPostForReply = {
                uri: storedDataForFollowUp.summaryPostUri, // The summary post by the bot
                cid: null, // CID might not be readily available here, but URI is key for reply parent ref
                author: { did: this.agent.did, handle: this.config.BLUESKY_IDENTIFIER }, // Bot's identity
                record: {
                    // text: "summary text placeholder", // Not strictly needed for reply ref
                    reply: { // The summary post itself was a reply to the original user query
                        root: { uri: storedDataForFollowUp.replyToRootUri },
                        parent: { uri: storedDataForFollowUp.replyToRootUri } // Simplified, could be more complex
                    }
                }
            };


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

              if (postedPartsUris && postedPartsUris.length > 0) {
                // Update replyTargetForThisSequence for the *next* conceptual point
                // It should reply to the *last part* of the current conceptual point.
                replyTargetForThisSequence.parent = {
                    uri: postedPartsUris[postedPartsUris.length - 1],
                    // We don't easily get the CID back from postReply's agent.post,
                    // but URI is the critical part for the reply parent reference.
                    // The @atproto/api might handle CID resolution internally or it might be optional for reply refs.
                    cid: null // Placeholder, as postReply doesn't return CIDs of new posts.
                };
                console.log(`[FollowUp] Conceptual point ${i+1} posted. Next reply parent URI: ${replyTargetForThisSequence.parent.uri}`);
              } else {
                console.error(`[FollowUp] Failed to post conceptual detail point ${i+1}. Aborting further details.`);
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
      const userQueryText = post.record.text; // The current user's message text

      // 1. Check for search history intent first
      const searchIntent = await this.getSearchHistoryIntent(userQueryText);

      if (searchIntent.intent === "search_history") {
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
        const nimSearchResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
            messages: [
              { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${searchSystemPrompt}` },
              { role: "user", content: nemotronSearchPrompt }
            ],
            temperature: 0.5,
            max_tokens: 100, // Shorter, as it's just a confirmation if embedding
            stream: false
          })
        });
        console.log(`NIM CALL END: Search History Response - Status: ${nimSearchResponse.status}`);

        if (nimSearchResponse.ok) {
          const nimSearchData = await nimSearchResponse.json();
          if (nimSearchData.choices && nimSearchData.choices.length > 0 && nimSearchData.choices[0].message && nimSearchData.choices[0].message.content) {
            const baseResponseText = nimSearchData.choices[0].message.content.trim();

            // Scout formatting for the text part
            const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-4-scout-17b-16e-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: baseResponseText }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                })
            });

            let finalResponseText = baseResponseText; // Default to base if filter fails
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
      // If not a search history or web_search intent, proceed with existing logic
      else if (searchIntent.intent === "web_search" && searchIntent.search_query) {
        console.log(`[WebSearchFlow] Web search intent detected. Query: "${searchIntent.search_query}"`);

        const isQuerySafe = await this.isTextSafeScout(searchIntent.search_query);
        if (!isQuerySafe) {
          console.warn(`[WebSearchFlow] Web search query "${searchIntent.search_query}" deemed unsafe.`);
          const unsafeQueryResponse = "I'm sorry, but I cannot search for that topic due to safety guidelines. Please try a different query.";
          // No LLM call needed for this fixed response, but Scout formatting is good practice
           const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-4-scout-17b-16e-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: unsafeQueryResponse }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                })
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

        const searchResults = await this.performWebSearch(searchIntent.search_query);
        let nemotronWebServicePrompt = "";
        const webSearchSystemPrompt = `You are an AI assistant. The user asked a question: "${userQueryText}". You have performed a web search for "${searchIntent.search_query}".
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
        const nimWebResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
          body: JSON.stringify({
            model: 'nvidia/llama-3.3-nemotron-super-49b-v1', // Or another suitable model for synthesis
            messages: [
              { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${webSearchSystemPrompt}` },
              { role: "user", content: nemotronWebServicePrompt }
            ],
            temperature: 0.6,
            max_tokens: 250, // Allow for a slightly longer synthesized answer
            stream: false
          })
        });

        if (nimWebResponse.ok) {
          const nimWebData = await nimWebResponse.json();
          if (nimWebData.choices && nimWebData.choices.length > 0 && nimWebData.choices[0].message && nimWebData.choices[0].message.content) {
            const synthesizedResponse = nimWebData.choices[0].message.content.trim();
            // Scout formatting
            const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
                body: JSON.stringify({
                  model: 'meta/llama-4-scout-17b-16e-instruct',
                  messages: [
                    { role: "system", content: "ATTENTION: Your task is to perform MINIMAL formatting on the provided text from another AI. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY. Your ONLY allowed modifications are: 1. Ensure the final text is UNDER 300 characters for Bluesky by truncating if necessary, prioritizing whole sentences. 2. Remove any surrounding quotation marks. 3. Remove sender attributions. 4. Remove double asterisks. PRESERVE emojis. DO NOT rephrase or summarize. Output only the processed text." },
                    { role: "user", content: synthesizedResponse }
                  ],
                  temperature: 0.1, max_tokens: 100, stream: false
                })
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
        return null; // End processing for this interaction
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
      const baseInstruction = `Your response will be posted to BlueSky as a reply to the most recent message mentioning you by a bot. For detailed topics, you can generate a response up to about 870 characters; it will be split into multiple posts if needed.`;

      if (userBlueskyPostsContext && userBlueskyPostsContext.trim() !== "") {
        // Profile analysis prompt
        nemotronUserPrompt = `The user's question is: "${post.record.text}"

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
        nemotronUserPrompt = `Here's the conversation context:\n\n${conversationHistory}\nThe most recent message mentioning you is: "${post.record.text}"\nPlease respond to the request in the most recent message. ${baseInstruction}`;
      }

      console.log(`NIM CALL START: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1. Prompt type: ${userBlueskyPostsContext && userBlueskyPostsContext.trim() !== "" ? "Profile Analysis" : "Standard"}`);
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [
            { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}` },
            { role: "user", content: nemotronUserPrompt }
          ],
          temperature: 0.7, max_tokens: 350, // Increased max_tokens for Nemotron
          stream: false
        })
      });
      console.log(`NIM CALL END: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1 - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) - Text: ${errorText}`);
        try { const errorJson = JSON.parse(errorText); console.error(`Nvidia NIM API error (${response.status}) - JSON:`, errorJson); } catch (e) {}
        if (response.status === 429 || response.status === 503 || response.status === 504) {
          console.log('Rate limit or server error, retrying after delay...');
          await utils.sleep(2000);
          return this.generateResponse(post, context);
        }
        throw new Error(`Nvidia NIM API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM:', JSON.stringify(data));
        throw new Error('Invalid response format from Nvidia NIM chat completions API');
      }
      let initialResponse = data.choices[0].message.content;
      console.log(`[LlamaBot.generateResponse] Initial response from nvidia/llama-3.3-nemotron-super-49b-v1: "${initialResponse}"`);
      console.log(`NIM CALL START: filterResponse for model meta/llama-4-scout-17b-16e-instruct`);
      const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct',
          messages: [
            { role: "system", content: "ATTENTION: The input text from another AI may be structured with special bracketed labels like \"[SUMMARY FINDING WITH INVITATION]\" and \"[DETAILED ANALYSIS POINT N]\". PRESERVE THESE BRACKETED LABELS EXACTLY AS THEY APPEAR.\n\nYour task is to perform MINIMAL formatting on the text *within each section defined by these labels*, as if each section were a separate piece of text. For each section:\n1. PRESERVE THE ORIGINAL WORDING AND MEANING EXACTLY.\n2. Ensure any text content is clean and suitable for a Bluesky post (e.g., under 290 characters per logical section if possible, though final splitting is handled later).\n3. Remove any surrounding quotation marks that make an entire section appear as a direct quote.\n4. Remove any sender attributions like 'Bot:' or 'Nemotron says:'.\n5. Remove any double asterisks (`**`) used for emphasis.\n6. PRESERVE all emojis (e.g., 😄, 🤔, ❤️) exactly as they appear.\n7. Ensure any internal numbered or bulleted lists within a \"[DETAILED ANALYSIS POINT N]\" section are well-formatted and would not be awkwardly split if that section became a single post.\n\nDO NOT rephrase, summarize, add, or remove any other content beyond these specific allowed modifications. DO NOT change the overall structure or the bracketed labels. Output the entire processed text, including the preserved labels. This is an internal formatting step; do not mention it. The input text you receive might be long (up to ~870 characters or ~350 tokens)." },
            { role: "user", content: initialResponse }
          ],
          temperature: 0.1, // Temperature for formatting (already lowered)
          max_tokens: 450, // Increased max_tokens for Scout to handle longer, structured Nemotron output
          stream: false
        })
      });
      console.log(`NIM CALL END: filterResponse for model meta/llama-4-scout-17b-16e-instruct - Status: ${filterResponse.status}`);
      if (!filterResponse.ok) {
        const errorText = await filterResponse.text();
        console.error(`Nvidia NIM API error (filter model) (${filterResponse.status}) - Text: ${errorText}`);
        return initialResponse;
      }
      const filterData = await filterResponse.json();
      if (!filterData.choices || !Array.isArray(filterData.choices) || filterData.choices.length === 0 || !filterData.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM (filter model):', JSON.stringify(filterData));
        return initialResponse;
      }
      const scoutFormattedText = filterData.choices[0].message.content;
      console.log(`[LlamaBot.generateResponse] Scout formatted text (raw): "${scoutFormattedText}"`);

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
            pointTextContent = pointTextContent.replace(/^(\s*(\d+\.|\d+\)|\*|-)\s*)+/, '').trim();

            if (pointTextContent) {
                detailedPoints.push(pointTextContent);
            }

            if (endOfCurrentPoint === -1) break; // Last point processed
            textAfterSummaryMarker = textAfterSummaryMarker.substring(endOfCurrentPoint); // Move to the start of the next potential marker
            currentPointNum++;
          }

          console.log(`[LlamaBot.generateResponse] Parsed Summary: "${summaryText}"`);
          detailedPoints.forEach((p, idx) => console.log(`[LlamaBot.generateResponse] Parsed Detail Point ${idx + 1} (cleaned): "${p.substring(0,100)}..."`));

          if (summaryText) {
            // Store detailed points if any, then return only summary for initial post
            // Post the summary first. No image on summary.
            const summaryPostUrisArray = await this.postReply(post, summaryText, null, null);

            if (summaryPostUrisArray && summaryPostUrisArray.length > 0) {
              const summaryPostUri = summaryPostUrisArray[summaryPostUrisArray.length - 1]; // Get the last part's URI
              console.log(`[LlamaBot.generateResponse] Summary posted successfully. Last part URI: ${summaryPostUri}. Total parts: ${summaryPostUrisArray.length}`);
              if (detailedPoints.length > 0) {
                this.pendingDetailedAnalyses.set(post.uri, { // Keyed by original user post URI
                  points: detailedPoints,
                  timestamp: Date.now(),
                  summaryPostUri: summaryPostUri, // URI of the bot's summary post
                  replyToRootUri: post.record?.reply?.root?.uri || post.uri, // Root for threading details
                  // imageBase64 and altText from the initial query, if any.
                  // These need to be passed into generateResponse if they existed.
                  // For now, assuming they might be on `post.generatedImageForThisInteraction`
                  imageBase64: post.generatedImageForThisInteraction?.imageBase64 || null,
                  altText: post.generatedImageForThisInteraction?.altText || "Generated image for detail",
                });
                console.log(`[LlamaBot.generateResponse] Stored ${detailedPoints.length} detailed points, pending for original post URI: ${post.uri}, summary URI: ${summaryPostUri}`);
              }
              return null; // Signal that response (summary) has been handled, and details are pending.
            } else {
              console.error("[LlamaBot.generateResponse] Failed to post summary. Falling back to sending full text.");
              return scoutFormattedText; // Fallback
            }
          } else {
            console.warn("[LlamaBot.generateResponse] Profile analysis: Summary text was empty after parsing. Returning full Scout output.");
            return scoutFormattedText; // Fallback
          }
        } else {
          console.warn("[LlamaBot.generateResponse] Profile analysis: [SUMMARY FINDING WITH INVITATION] marker not found. Returning full Scout output.");
          return scoutFormattedText; // Fallback
        }
} else {
        // Standard response, not profile analysis. Return the text for monitor to post.
        // If there was an image for this standard response, it should be on `post.generatedImageForThisInteraction`
        // and `monitor` loop will pass it to `postReply`.
        return scoutFormattedText;
      }
    } // This closes the try block
    }
  catch (error) { // This is line 1520 in Render's logs
      console.error('Error in LlamaBot.generateResponse:', error);
      return null; // Ensure null is returned on error so monitor doesn't try to post it.
    }
  }

  getModelName() {
    return 'nvidia/llama-3.3-nemotron-super-49b-v1 (filtered by meta/llama-4-scout-17b-16e-instruct)'.split('/').pop();
  }

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

    const requestBody = { query: searchQuery };
    if (freshness && ["oneDay", "oneWeek", "oneMonth"].includes(freshness)) { // Basic validation for freshness
      requestBody.freshness = freshness;
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

      const data = await response.json();

      if (data.webPages && data.webPages.value && data.webPages.value.length > 0) {
        const results = data.webPages.value.slice(0, 3).map(page => ({ // Take top 3 results
          title: page.name || "No title",
          url: page.url,
          snippet: page.snippet || "No snippet available.",
          // summary: page.summary || null // If summary parameter were used and field existed
        }));
        console.log(`[WebSearch] Found ${results.length} results for query "${searchQuery}"`);
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

  async getSearchHistoryIntent(userQueryText) {
    if (!userQueryText || userQueryText.trim() === "") {
      return { intent: "none" };
    }
    const modelId = 'meta/llama-4-scout-17b-16e-instruct';
    const systemPrompt = `Your task is to analyze the user's query to determine if it's a request to find a specific item from past interactions OR a general question that could be answered by a web search.

Output a JSON object. Choose ONE of the following intent structures:

1. If searching PAST INTERACTIONS (conversation history, bot's gallery):
{
  "intent": "search_history",
  "target_type": "image" | "link" | "post" | "message" | "unknown", // REQUIRED.
  "author_filter": "user" | "bot" | "any", // REQUIRED.
  "keywords": ["keyword1", ...], // Content-specific keywords. EXCLUDE recency cues & type words. Max 5.
  "recency_cue": "textual cue for recency" | null,
  "search_scope": "bot_gallery" | "conversation" | null // REQUIRED for bot image searches. Default "conversation". Null otherwise.
}

2. If it's a GENERAL QUESTION for a WEB SEARCH:
{
  "intent": "web_search",
  "search_query": "optimized query for web search engine" // REQUIRED. The user's question, possibly rephrased for search.
}

3. If NEITHER of the above:
{
  "intent": "none"
}

IMPORTANT RULES for "search_history":
- "target_type": "image" if "image", "picture", "photo", "generated image", "drew", "pic of" mentioned. This takes precedence. "link" if "link", "URL", "site" mentioned. Else, "message" or "post".
- "author_filter": "user" (they sent/posted), "bot" (you sent/generated), or "any".
- "keywords": Core content terms. EXCLUDE recency cues (e.g., "yesterday") AND type words (e.g., "image", "link").
- "recency_cue": Time phrases (e.g., "yesterday", "last week"). Null if none.
- "search_scope": For "target_type": "image" AND "author_filter": "bot":
    - If the user is asking for an image the bot *created/generated/made*, and it's not explicitly stated it was *sent to them in a reply* or *part of a specific prior discussion point with them*, prefer "bot_gallery". (e.g., "image you made of X", "your picture of Y", "the moon image you generated yesterday", "URL for the image you created of a sunset"). The phrase "provide me" or "show me" in the current request for information does not automatically imply the image was originally part of a direct conversation.
    - If they say 'image you sent me', 'image in our chat about X', or the context clearly indicates a shared conversational item (e.g., the image was a direct reply to their previous post), then "conversation" is more suitable.
    - Default to "conversation" if truly ambiguous after these checks.
    - Null otherwise.

IMPORTANT RULES for "web_search":
- Use "web_search" for general knowledge questions, requests for current information/news, or explanations of concepts not tied to your direct prior interactions or capabilities (e.g., "What is the capital of France?", "latest advancements in AI", "how do black holes work?").
- "search_query" should be the essence of the user's question, suitable for a search engine.

PRIORITIZATION:
- If a query mentions past interactions directly (e.g., "you sent me", "we discussed", "in our chat"), prefer "search_history" with appropriate "conversation" scope.
- If a query asks about something the bot *created* or *generated* (especially images), and it's not explicitly tied to a direct back-and-forth, lean towards "search_history" with "bot_gallery" scope if applicable.
- If it's a straightforward factual question about the world, prefer "web_search".

If NEITHER intent fits, or if very unsure, use {"intent": "none"}. Output ONLY the JSON object.

Examples:
- User query: "find the image you generated for me of a cat yesterday"
  Response: {"intent": "search_history", "target_type": "image", "author_filter": "bot", "keywords": ["cat", "generated"], "recency_cue": "yesterday", "search_scope": "conversation"}
- User query: "show me a picture you made of a dog"
  Response: {"intent": "search_history", "target_type": "image", "author_filter": "bot", "keywords": ["dog"], "recency_cue": null, "search_scope": "bot_gallery"}
- User query: "can you provide me the URL for the moon image you generated yesterday"
  Response: {"intent": "search_history", "target_type": "image", "author_filter": "bot", "keywords": ["moon", "generated"], "recency_cue": "yesterday", "search_scope": "bot_gallery"}
- User query: "what was that link about dogs I sent last tuesday?"
  Response: {"intent": "search_history", "target_type": "link", "author_filter": "user", "keywords": ["dogs"], "recency_cue": "last tuesday", "search_scope": null}
- User query: "What is the tallest mountain in the world?"
  Response: {"intent": "web_search", "search_query": "tallest mountain in the world"}
- User query: "latest news about the Mars rover"
  Response: {"intent": "web_search", "search_query": "latest news Mars rover"}
- User query: "can you generate a new image of a forest?" // This is an image generation command, not a search
  Response: {"intent": "none"}
`;

    const userPrompt = `User query: '${userQueryText}'`;
    console.log(`[IntentClassifier] Calling Scout (getSearchHistoryIntent) for query: "${userQueryText}"`);

    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.2, // Low temperature for classification/extraction
          max_tokens: 150, // Enough for the JSON structure
          stream: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IntentClassifier] Scout API error (${response.status}) for intent classification (getSearchHistoryIntent). Query: "${userQueryText}". Error: ${errorText}`);
        return { intent: "none", error: `API error ${response.status}` };
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        let rawContent = data.choices[0].message.content.trim();
        console.log(`[IntentClassifier] Scout raw response (getSearchHistoryIntent) for query "${userQueryText}": "${rawContent}"`);

        // Attempt to extract JSON from potential markdown code blocks or directly
        const jsonRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
        const match = rawContent.match(jsonRegex);
        let jsonString = "";
        if (match && match[1]) {
          jsonString = match[1];
        } else if (rawContent.startsWith("{") && rawContent.endsWith("}")) {
          jsonString = rawContent;
        } else {
          // Fallback if JSON is not clearly demarcated - find first '{' and last '}'
          const firstBrace = rawContent.indexOf('{');
          const lastBrace = rawContent.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            jsonString = rawContent.substring(firstBrace, lastBrace + 1);
          }
        }

        if (jsonString) {
          try {
            const parsedJson = JSON.parse(jsonString);
            // Basic validation of the parsed structure
            if (parsedJson.intent === "search_history") {
              const validTarget = ["image", "link", "post", "message", "unknown"].includes(parsedJson.target_type);
              const validAuthor = ["user", "bot", "any"].includes(parsedJson.author_filter);
              const validKeywords = Array.isArray(parsedJson.keywords);
              let validScope = true;
              if (parsedJson.target_type === "image" && parsedJson.author_filter === "bot") {
                validScope = ["bot_gallery", "conversation", null].includes(parsedJson.search_scope);
                if (parsedJson.search_scope === undefined) parsedJson.search_scope = "conversation"; // Default if undefined
              } else {
                if (parsedJson.search_scope !== null && parsedJson.search_scope !== undefined) {
                  // Non-bot-image searches shouldn't ideally have a scope, but allow null/undefined
                }
              }
              if (!validTarget || !validAuthor || !validKeywords || !validScope) {
                console.warn(`[IntentClassifier] Scout 'search_history' response malformed: ${jsonString}. Validations: target=${validTarget}, author=${validAuthor}, keywords=${validKeywords}, scope=${validScope}`);
                // Attempt to salvage with defaults
                parsedJson.target_type = parsedJson.target_type || "unknown";
                parsedJson.author_filter = parsedJson.author_filter || "any";
                parsedJson.keywords = parsedJson.keywords || [];
                if (parsedJson.target_type === "image" && parsedJson.author_filter === "bot" && !validScope) {
                  parsedJson.search_scope = "conversation";
                }
              }
            } else if (parsedJson.intent === "web_search") {
              if (typeof parsedJson.search_query !== 'string' || !parsedJson.search_query.trim()) {
                console.warn(`[IntentClassifier] Scout 'web_search' response missing or empty 'search_query': ${jsonString}`);
                return { intent: "none", error: "Malformed web_search intent from Scout (missing search_query)." };
              }
              // Ensure other search_history fields are not present or are null for web_search intent
              parsedJson.target_type = null;
              parsedJson.author_filter = null;
              parsedJson.keywords = [];
              parsedJson.recency_cue = null;
              parsedJson.search_scope = null;
            } else if (parsedJson.intent !== "none") {
               console.warn(`[IntentClassifier] Scout response has unknown intent: ${jsonString}`);
               return { intent: "none", error: "Unknown intent from Scout."};
            }
            console.log(`[IntentClassifier] Scout parsed intent (getSearchHistoryIntent) for query "${userQueryText}":`, parsedJson);
            return parsedJson;
          } catch (e) {
            console.error(`[IntentClassifier] Error parsing JSON from Scout (getSearchHistoryIntent) for query "${userQueryText}". JSON string: "${jsonString}". Error:`, e);
            return { intent: "none", error: "JSON parsing error." };
          }
        } else {
            console.error(`[IntentClassifier] Could not extract JSON from Scout response (getSearchHistoryIntent) for query "${userQueryText}". Raw: "${rawContent}"`);
            return { intent: "none", error: "Could not extract JSON from Scout response." };
        }
      }
      console.error(`[IntentClassifier] Unexpected response format from Scout (getSearchHistoryIntent). Query: "${userQueryText}". Data:`, JSON.stringify(data));
      return { intent: "none", error: "Unexpected response format." };
    } catch (error) {
      console.error(`[IntentClassifier] Error calling Scout (getSearchHistoryIntent). Query: "${userQueryText}":`, error);
      return { intent: "none", error: "Exception during API call." };
    }
  }

  async shouldFetchProfileContext(userQueryText) {
    if (!userQueryText || userQueryText.trim() === "") {
      return false;
    }
    const modelId = 'meta/llama-4-scout-17b-16e-instruct';
    const systemPrompt = "Your task is to determine if the user's query is primarily asking for an analysis, reflection, or information about themselves, their posts, their online personality, their Bluesky account, or their life, in a way that their recent Bluesky activity could provide relevant context. Respond with only the word YES or the word NO.";
    const userPrompt = `User query: '${userQueryText}'`;

    console.log(`[IntentClassifier] Calling Scout (shouldFetchProfileContext) for query: "${userQueryText}"`);

    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 5, // Enough for "YES" or "NO"
          stream: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IntentClassifier] Scout API error (${response.status}) for intent classification (shouldFetchProfileContext). Query: "${userQueryText}". Error: ${errorText}`);
        return false;
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toUpperCase();
        console.log(`[IntentClassifier] Scout decision (shouldFetchProfileContext) for query "${userQueryText}": "${decision}"`);
        return decision === 'YES';
      }
      console.error(`[IntentClassifier] Unexpected response format from Scout (shouldFetchProfileContext). Query: "${userQueryText}". Data:`, JSON.stringify(data));
      return false;
    } catch (error) {
      console.error(`[IntentClassifier] Error calling Scout (shouldFetchProfileContext). Query: "${userQueryText}":`, error);
      return false;
    }
  }

  async isRequestingDetails(userFollowUpText) {
    if (!userFollowUpText || userFollowUpText.trim() === "") {
      return false;
    }
    const modelId = 'meta/llama-4-scout-17b-16e-instruct';
    const systemPrompt = "The user was previously asked if they wanted a detailed breakdown of a profile analysis. Does their current reply indicate they affirmatively want to see these details? Respond with only YES or NO.";
    const userPrompt = `User reply: '${userFollowUpText}'`;

    console.log(`[IntentClassifier] Calling Scout (isRequestingDetails) for follow-up: "${userFollowUpText}"`);
    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 5,
          stream: false
        })
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[IntentClassifier] Scout API error (${response.status}) for intent classification (isRequestingDetails). Follow-up: "${userFollowUpText}". Error: ${errorText}`);
        return false;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toUpperCase();
        console.log(`[IntentClassifier] Scout decision (isRequestingDetails) for follow-up "${userFollowUpText}": "${decision}"`);
        return decision === 'YES';
      }
      console.error(`[IntentClassifier] Unexpected response format from Scout (isRequestingDetails). Follow-up: "${userFollowUpText}". Data:`, JSON.stringify(data));
      return false;
    } catch (error) {
      console.error(`[IntentClassifier] Error calling Scout (isRequestingDetails). Follow-up: "${userFollowUpText}":`, error);
      return false;
    }
  }

  async generateImage(prompt) {
    const modelToUse = "black-forest-labs/FLUX.1-schnell-Free";
    const apiKey = this.config.TOGETHER_AI_API_KEY;
    if (!apiKey) { console.error('TOGETHER_AI_API_KEY is not configured. Cannot generate image.'); return null; }
    console.log(`TOGETHER AI CALL START: generateImage for model "${modelToUse}" with prompt "${prompt}"`);
    const requestBody = { model: modelToUse, prompt: prompt, n: 1, size: "1024x1024" };
    // console.log('Together AI Request Body:', JSON.stringify(requestBody)); // Reduce noise
    try {
      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody)
      });
      const responseStatus = response.status;
      const responseText = await response.text();
      console.log(`TOGETHER AI CALL END: generateImage - Status: ${responseStatus}`);
      // console.log(`TOGETHER AI CALL Full Response Text: ${responseText}`); // Reduce noise
      if (!response.ok) {
        console.error(`Together AI API error (${responseStatus}) for generateImage with prompt "${prompt}" - Full Response: ${responseText}`);
        try { const errorJson = JSON.parse(responseText); console.error(`Together AI API error (${responseStatus}) for generateImage - Parsed JSON:`, errorJson); } catch (e) {}
        return null;
      }
      const data = JSON.parse(responseText);
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
    console.log(`NIM CALL START: isTextSafeScout for model meta/llama-4-scout-17b-16e-instruct`);
    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct',
          messages: [
            { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} You are an AI safety moderator. Analyze the following user text. If the text violates any of the safety guidelines (adult content, NSFW, copyrighted material, illegal content, violence, politics), respond with "unsafe". Otherwise, respond with "safe". Only respond with "safe" or "unsafe".` },
            { role: "user", content: prompt }
          ],
          temperature: 0.1, max_tokens: 10, stream: false
        })
      });
      console.log(`NIM CALL END: isTextSafeScout for prompt "${prompt}" - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) for isTextSafeScout (prompt: "${prompt}") - Text: ${errorText}`);
        return false;
      }
      const data = await response.json();
      // console.log(`NIM CALL RESPONSE: isTextSafeScout for prompt "${prompt}" - Data:`, JSON.stringify(data)); // Reduce noise
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toLowerCase();
        console.log(`Safety check for text "${prompt}": AI decision: "${decision}"`);
        return decision === 'safe';
      }
      console.error(`Unexpected response format from Nvidia NIM for isTextSafeScout (prompt: "${prompt}"):`, JSON.stringify(data));
      return false;
    } catch (error) { console.error(`Error in LlamaBot.isTextSafeScout (prompt: "${prompt}"):`, error); return false; }
  }

  async processImagePromptWithScout(user_prompt_text) {
    console.log(`NIM CALL START: processImagePromptWithScout for model meta/llama-4-scout-17b-16e-instruct`);
    try {
      const system_instruction = `${this.config.SAFETY_SYSTEM_PROMPT} You are an AI assistant. Analyze the following user text intended as a prompt for an image generation model.
1. First, determine if the user's text is safe according to the safety guidelines. The guidelines include: no adult content, no NSFW material, no copyrighted characters or concepts unless very generic, no illegal activities, no violence, no political content.
2. If the text is unsafe, respond with a JSON object: \`{ "safe": false, "reply_text": "I cannot generate an image based on that request due to safety guidelines. Please try a different prompt." }\`.
3. If the text is safe, extract the core artistic request. Rephrase it if necessary to be a concise and effective prompt for an image generation model like Flux.1 Schnell. The prompt should be descriptive and clear.
4. If safe, respond with a JSON object: \`{ "safe": true, "image_prompt": "your_refined_image_prompt_here" }\`.
Ensure your entire response is ONLY the JSON object.`;
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct',
          messages: [ { role: "system", content: system_instruction }, { role: "user", content: user_prompt_text } ],
          temperature: 0.3, max_tokens: 150, stream: false,
        })
      });
      console.log(`NIM CALL END: processImagePromptWithScout for user_prompt_text "${user_prompt_text}" - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) for processImagePromptWithScout (user_prompt_text: "${user_prompt_text}") - Text: ${errorText}`);
        return { safe: false, reply_text: "Sorry, I encountered an issue processing your image request. Please try again later." };
      }
      const apiResponseText = await response.text();
      // console.log(`NIM CALL RESPONSE: processImagePromptWithScout for user_prompt_text "${user_prompt_text}" - API Raw Text: ${apiResponseText}`); // Reduce noise
      try {
        const apiData = JSON.parse(apiResponseText);
        if (apiData.choices && apiData.choices.length > 0 && apiData.choices[0].message && apiData.choices[0].message.content) {
          let rawContent = apiData.choices[0].message.content.trim();
          console.log(`NIM CALL RESPONSE: processImagePromptWithScout - Raw content from model: "${rawContent}"`);

          let jsonString = null;

          const markdownJsonRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
          const markdownMatch = rawContent.match(markdownJsonRegex);

          if (markdownMatch && markdownMatch[1]) {
            jsonString = markdownMatch[1].trim();
            console.log(`NIM CALL RESPONSE: processImagePromptWithScout - Extracted JSON from markdown: "${jsonString}"`);
          } else {
            const firstBrace = rawContent.indexOf('{');
            const lastBrace = rawContent.lastIndexOf('}');

            if (firstBrace !== -1 && lastBrace > firstBrace) {
                jsonString = rawContent.substring(firstBrace, lastBrace + 1);
                console.log(`NIM CALL RESPONSE: processImagePromptWithScout - Attempting to parse substring from first '{' to last '}': "${jsonString}"`);
                 try {
                    JSON.parse(jsonString);
                } catch (e) {
                    console.warn(`NIM CALL RESPONSE: processImagePromptWithScout - Substring from first '{' to last '}' is not valid JSON. Will try broader regex.`);
                    jsonString = null;
                }
            }

            if (!jsonString) {
                const embeddedJsonRegex = /(\{[\s\S]*?\})(?=\s*$|\s*\w)/;
                const embeddedMatch = rawContent.match(embeddedJsonRegex);
                 if (embeddedMatch && embeddedMatch[1]) {
                    jsonString = embeddedMatch[1].trim();
                    console.log(`NIM CALL RESPONSE: processImagePromptWithScout - Extracted embedded JSON via regex: "${jsonString}"`);
                }
            }
          }

          if (jsonString) {
            try {
              const scoutDecision = JSON.parse(jsonString);
              if (typeof scoutDecision.safe === 'boolean') {
                if (scoutDecision.safe === false && typeof scoutDecision.reply_text === 'string') {
                  return scoutDecision;
                } else if (scoutDecision.safe === true && typeof scoutDecision.image_prompt === 'string') {
                  return scoutDecision;
                }
              }
              console.error(`Unexpected JSON structure after parsing extracted string: "${jsonString}". Parsed object: ${JSON.stringify(scoutDecision)}`);
              return { safe: false, reply_text: "Sorry, the structured response I received was not in the expected format." };
            } catch (parseError) {
              console.error(`Error parsing extracted JSON string: "${jsonString}". Error: ${parseError}. Original raw content: "${rawContent}"`);
              return { safe: false, reply_text: "Sorry, I had trouble parsing the structured response for your image request." };
            }
          } else {
            console.error(`Could not extract any JSON string from Scout's response: "${rawContent}"`);
            return { safe: false, reply_text: "Sorry, I couldn't find a structured response for your image request." };
          }
        } else {
          console.error(`Unexpected API structure from Nvidia NIM for processImagePromptWithScout (missing choices/message/content): ${apiResponseText}`);
          return { safe: false, reply_text: "Sorry, I received an incomplete response while processing your image request." };
        }
      } catch (apiJsonError) {
        console.error(`Error parsing main API JSON from Nvidia NIM for processImagePromptWithScout: ${apiJsonError}. Raw API response: ${apiResponseText}`);
        return { safe: false, reply_text: "Sorry, I had trouble understanding the API response for your image request." };
      }
    } catch (error) {
      console.error(`Error in LlamaBot.processImagePromptWithScout (user_prompt_text: "${user_prompt_text}"):`, error);
      return { safe: false, reply_text: "An unexpected error occurred while processing your image request." };
    }
  }

  async describeImageWithScout(imageBase64) {
    const modelToUse = 'meta/llama-4-scout-17b-16e-instruct';
    console.log(`NIM CALL START: describeImageWithScout for model ${modelToUse}`);
    if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      console.error('describeImageWithScout: imageBase64 data is invalid or empty.');
      return null;
    }
    const mimeType = 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const systemPrompt = "You are an AI assistant. Your task is to describe the provided image for a social media post. Be descriptive, engaging, and try to capture the essence of the image. Keep your description concise, ideally under 200 characters, as it will also be used for alt text. Focus solely on describing the visual elements of the image.";
    const userPromptText = "Please describe this image.";
    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: modelToUse,
          messages: [ { role: "system", content: systemPrompt }, { role: "user", content: [ { type: "text", text: userPromptText }, { type: "image_url", image_url: { url: dataUrl } } ] } ],
          temperature: 0.5, max_tokens: 100, stream: false
        })
      });
      console.log(`NIM CALL END: describeImageWithScout - Status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) for describeImageWithScout - Text: ${errorText}`);
        try { const errorJson = JSON.parse(errorText); console.error(`Nvidia NIM API error (${response.status}) for describeImageWithScout - JSON:`, errorJson); } catch (e) { }
        return null;
      }
      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const description = data.choices[0].message.content.trim();
        console.log(`NIM CALL RESPONSE: describeImageWithScout - Description: "${description}"`);
        if (description && description.length > 5) { return description; }
        else { console.warn(`describeImageWithScout received an empty or too short description: "${description}"`); return null; }
      }
      console.error(`Unexpected response format from Nvidia NIM for describeImageWithScout:`, JSON.stringify(data));
      return null;
    } catch (error) { console.error(`Error in LlamaBot.describeImageWithScout:`, error); return null; }
  }
}

// Initialize and run the bot
async function startBots() {
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  const llamaBot = new LlamaBot({
    ...config,
    BLUESKY_IDENTIFIER: config.BLUESKY_IDENTIFIER,
    BLUESKY_APP_PASSWORD: config.BLUESKY_APP_PASSWORD,
  }, agent);
  await llamaBot.monitor().catch(console.error);
}

startBots().catch(console.error);

//end of index.js
