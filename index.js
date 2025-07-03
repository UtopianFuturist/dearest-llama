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
      let lastCheckedPost = null;

      while (true) {
        try {
          const posts = await this.getRecentPosts();
          if (!posts.length) {
            await utils.sleep(this.config.CHECK_INTERVAL);
            continue;
          }
          const latestPost = posts[0];
          if (lastCheckedPost && latestPost.uri === lastCheckedPost) {
            await utils.sleep(this.config.CHECK_INTERVAL);
            continue;
          }
          lastCheckedPost = latestPost.uri;

          let isAdminCmdHandled = false;

          if (latestPost.post &&
              latestPost.post.author &&
              latestPost.post.author.handle === this.config.ADMIN_BLUESKY_HANDLE &&
              latestPost.post.record &&
              latestPost.post.record.text &&
              latestPost.post.record.text.includes('!post')) {

            const commandText = latestPost.post.record.text;
            let commandContent = "";
            let isImageCommand = false;

            let commandSearchText = commandText;
            const botMention = `@${this.config.BLUESKY_IDENTIFIER}`;
            if (commandText.startsWith(botMention)) {
                commandSearchText = commandText.substring(botMention.length).trim();
            }

            console.log(`[DEBUG_MONITOR] commandSearchText after potential mention strip: "${commandSearchText}"`);

            if (commandSearchText.startsWith("!post+image ")) {
                isImageCommand = true;
                commandContent = commandSearchText.substring("!post+image ".length).trim();
                console.log(`[DEBUG_MONITOR] Detected !post+image. Content to pass: "${commandContent}"`);
            } else if (commandSearchText.startsWith("!post ")) {
                isImageCommand = false;
                commandContent = commandSearchText.substring("!post ".length).trim();
                console.log(`[DEBUG_MONITOR] Detected !post. Content to pass: "${commandContent}"`);
            } else {
                console.log(`[MONITOR] Admin post included '!post' but not as a recognized command prefix: "${commandSearchText}". Treating as regular mention.`);
                // isAdminCmdHandled remains false, will fall through to regular reply logic
            }

            if (commandSearchText.startsWith("!post+image ") || commandSearchText.startsWith("!post ")) {
              await this.handleAdminPostCommand(latestPost.post, commandContent, isImageCommand);
              isAdminCmdHandled = true;
            }
          }

          if (!isAdminCmdHandled) {
            const alreadyReplied = await this.hasAlreadyReplied(latestPost.post);
            if (!alreadyReplied) {
              const imageRequestKeywords = [
                "generate image", "generate an image", "create a picture of",
                "draw a picture of", "create an image of", "draw an image of"
              ];
              let isImageRequest = false;
              let imagePrompt = "";

              if (latestPost && latestPost.post && latestPost.post.record && latestPost.post.record.text && typeof latestPost.post.record.text === 'string') {
                const originalText = latestPost.post.record.text;
                const lowercasedText = originalText.toLowerCase();
                for (const keyword of imageRequestKeywords) {
                  const keywordIndex = lowercasedText.indexOf(keyword);
                  if (keywordIndex !== -1) {
                    let tempPrompt = originalText.substring(keywordIndex + keyword.length).trim();
                    if (tempPrompt.toLowerCase().startsWith("of ")) {
                      tempPrompt = tempPrompt.substring(3).trim();
                    }
                    const isLengthValid = tempPrompt.length >= 5 && tempPrompt.length <= 300;
                    if (isLengthValid) {
                      imagePrompt = tempPrompt;
                      isImageRequest = true;
                      console.log(`[KeywordLoop] Valid image request. Keyword: "${keyword}". Prompt: "${imagePrompt}"`);
                      break;
                    }
                  }
                }
              }
              let standardTextResponse = null;
              if (latestPost && latestPost.post && latestPost.post.record && latestPost.post.record.text) {
                  const context = await this.getReplyContext(latestPost.post);
                  standardTextResponse = await this.generateResponse(latestPost.post, context);
              }

              if (isImageRequest && imagePrompt) {
                const scoutResult = await this.processImagePromptWithScout(imagePrompt);
                if (!scoutResult.safe) {
                  console.warn(`Image prompt "${imagePrompt}" deemed unsafe by Scout. Reply: "${scoutResult.reply_text}"`);
                  let replyText = scoutResult.reply_text;
                  if (standardTextResponse) {
                    replyText = `${standardTextResponse}\n\nRegarding your image request: ${scoutResult.reply_text}`;
                  }
                  await this.postReply(latestPost.post, replyText);
                } else {
                  console.log(`Scout deemed prompt safe. Refined prompt for Flux: "${scoutResult.image_prompt}"`);
                  const imageBase64 = await this.generateImage(scoutResult.image_prompt);
                  let finalAltText = "Generated image";
                  if (imageBase64) {
                    const imageDescriptionFromScout = await this.describeImageWithScout(imageBase64);
                    if (imageDescriptionFromScout) {
                      console.log(`Scout successfully described the image: "${imageDescriptionFromScout}"`);
                      finalAltText = imageDescriptionFromScout;
                      let combinedResponseText = `Here's the image you requested:\n\n${imageDescriptionFromScout}`;
                      await this.postReply(latestPost.post, combinedResponseText, imageBase64, finalAltText);
                    } else {
                      console.warn(`Scout failed to describe the image. Falling back to Nemotron's text (if available) and generic alt text.`);
                      let combinedResponseText = standardTextResponse ? standardTextResponse : "";
                      if (combinedResponseText) combinedResponseText += "\n\n";
                      combinedResponseText += "Here's the image you requested:";
                      await this.postReply(latestPost.post, combinedResponseText, imageBase64, finalAltText);
                    }
                  } else {
                    console.log(`Flux failed to generate image for safe prompt: "${scoutResult.image_prompt}". Generating failure message with Scout.`);
                    const fluxFailureUserPrompt = `The user asked for an image with a prompt that was deemed safe ("${scoutResult.image_prompt}"). However, the image generation model (Flux) failed to produce an image. Please craft a brief, empathetic message to the user explaining this, keeping the message under 150 characters. Do not offer to try again unless specifically part of your persona. Acknowledge their request was fine but the final step didn't work.`;
                    const fluxFailureContext = [{ author: 'system', text: 'Informing user about image generation failure.' }];
                    let fluxFailureReply = await this.generateResponse({ record: { text: fluxFailureUserPrompt } }, fluxFailureContext);
                    if (!fluxFailureReply) {
                        fluxFailureReply = "I understood your request for an image, and the prompt was safe, but unfortunately, I couldn't generate the image this time.";
                    }
                    let finalReplyText = standardTextResponse ? standardTextResponse : "";
                    if (finalReplyText) finalReplyText += "\n\n";
                    finalReplyText += fluxFailureReply;
                    await this.postReply(latestPost.post, finalReplyText);
                  }
                }
              } else if (isImageRequest && !imagePrompt) {
                console.warn(`Image request was detected, but no valid prompt could be finalized for Scout (e.g., all attempts were too short/long).`);
                let failureText = "It looks like you wanted an image, but I couldn't quite understand the details, or the description was too short/long. Please try again with a clear prompt between 5 and 300 characters, like: 'generate image of a happy cat'.";
                if (standardTextResponse) {
                    failureText = `${standardTextResponse}\n\nRegarding your image request: ${failureText}`;
                }
                await this.postReply(latestPost.post, failureText);
              } else {
                if (standardTextResponse) {
                    await this.postReply(latestPost.post, standardTextResponse);
                }
              }
            }
          }
          consecutiveErrors = 0;
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
      const { data: notifications } = await this.agent.listNotifications({ limit: 20 });
      if (!notifications || !notifications.notifications) throw new Error('No notifications returned');
      const relevantPosts = notifications.notifications
        .filter(notif => notif.reason !== 'like' && notif.author.handle !== this.config.BLUESKY_IDENTIFIER)
        .map(notif => ({ post: { uri: notif.uri, cid: notif.cid, author: notif.author, record: notif.record } }));
      return relevantPosts;
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

  async postReply(post, response, imageBase64 = null, altText = "Generated image") {
    try {
      RateLimit.check();
      RateLimit.check();
      RateLimit.check();
      const CHAR_LIMIT_PER_POST = 300; // Bluesky's actual limit
      const PAGE_SUFFIX_MAX_LENGTH = " ... [X/Y]".length; // Approx length of " ... [1/3]"
      const MAX_PARTS = 3;
      let textParts = [];

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

          if (isLastPart && imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
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
          } else if (isLastPart && imageBase64) {
              console.warn(`[postReply] imageBase64 was present for last part but invalid. Skipping image embed.`);
          }

          // If only an image is being posted (no text parts initially)
          if (totalParts === 1 && textParts.length === 0 && imageBase64) {
            replyObject.text = ""; // Ensure text is empty if only posting an image
          }


          console.log(`[postReply] Attempting to post part ${i + 1}/${totalParts}. Text: "${replyObject.text.substring(0,50)}..."`);
          const result = await this.agent.post(replyObject);
          console.log(`Successfully posted part ${i + 1}/${totalParts}: ${result.uri}`);

          if (!isLastPart) { // For the next part, reply to the part just posted
              currentReplyTo = {
                  root: currentReplyTo.root, // Root stays the same
                  parent: { uri: result.uri, cid: result.cid }
              };
          }
      }
      this.repliedPosts.add(post.uri); // Add original post URI to replied set after all parts are sent
    } catch (error) {
      console.error('Error posting multi-part reply:', error);
      this.repliedPosts.add(post.uri); // Still mark as replied to avoid loops on error
    }
  }

  getModelName() {
    return 'Unknown Model';
  }
}

// Llama-specific implementation
class LlamaBot extends BaseBot {
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

            const detailImageBase64 = storedDataForFollowUp.imageBase64; // Get stored image data
            const detailAltText = storedDataForFollowUp.altText;

            for (let i = 0; i < storedDataForFollowUp.points.length; i++) {
              const pointText = storedDataForFollowUp.points[i];
              const isLastDetailPart = i === storedDataForFollowUp.points.length - 1;

              let detailPostText = pointText;
              // Suffix is added for all detail parts, even if only one detail part.
              detailPostText = `${pointText.trim()} ... [${i + 1}/${storedDataForFollowUp.points.length}]`;

              const replyObject = {
                text: utils.truncateResponse(detailPostText, 300),
                reply: currentDetailReplyTarget
              };

              if (isLastDetailPart && detailImageBase64) {
                 try {
                  const imageBytes = Uint8Array.from(Buffer.from(detailImageBase64, 'base64'));
                  if (imageBytes.length > 0) {
                    const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: 'image/png' });
                    if (uploadedImage?.data?.blob) {
                      replyObject.embed = { $type: 'app.bsky.embed.images', images: [{ image: uploadedImage.data.blob, alt: detailAltText }] };
                       console.log(`[FollowUp] Attached image to detail part ${i+1}`);
                    }
                  }
                } catch (imgErr) { console.error("[FollowUp] Error attaching image to detail post:", imgErr); }
              }

              console.log(`[FollowUp] Posting detail ${i+1}/${storedDataForFollowUp.points.length}: "${replyObject.text.substring(0,50)}..." replying to ${currentDetailReplyTarget.parent.uri}`);
              const result = await this.agent.post(replyObject);
              console.log(`[FollowUp] Successfully posted detail part ${i+1}: ${result.uri}`);

              if (!isLastDetailPart) {
                currentDetailReplyTarget.parent = { uri: result.uri, cid: result.cid };
              }
              if (storedDataForFollowUp.points.length > 1 && i < storedDataForFollowUp.points.length -1) {
                 await utils.sleep(1000);
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
    try {
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
      // const userPostTextLower = post.record.text.toLowerCase(); // No longer needed for keywords
      // const profileKeywords = ["my profile", "about me", "what do you think of me", "my posts", "my feed"]; // Remove keywords

      const fetchContextDecision = await this.shouldFetchProfileContext(post.record.text);

      if (fetchContextDecision) {
        console.log(`[Context] Scout determined profile context should be fetched for DID: ${post.author.did}. Query: "${post.record.text}"`);
        try {
          let fetchedPostsCount = 0;
          let authorFeedCursor = undefined;
          const maxPostsToFetch = 100;
          let postsLimitPerCall = 50; // Max per call is often 100, but 50 is safe.

          const collectedPosts = [];

          while (fetchedPostsCount < maxPostsToFetch) {
            if (maxPostsToFetch - fetchedPostsCount < postsLimitPerCall) {
                postsLimitPerCall = maxPostsToFetch - fetchedPostsCount;
            }
            if (postsLimitPerCall <= 0) break;

            console.log(`[Context] Fetching posts for ${post.author.did}, limit: ${postsLimitPerCall}, cursor: ${authorFeedCursor}`);
            const authorFeed = await this.agent.api.app.bsky.feed.getAuthorFeed({
              actor: post.author.did,
              limit: postsLimitPerCall,
              cursor: authorFeedCursor,
              filter: 'posts_with_replies' // or 'posts_no_replies' / 'posts_and_author_threads'
            });

            if (authorFeed.success && authorFeed.data.feed.length > 0) {
              for (const feedItem of authorFeed.data.feed) {
                if (feedItem.post && feedItem.post.record) {
                  let postText = feedItem.post.record.text || "";
                  const postAuthorHandle = feedItem.post.author.handle;
                  const userWhoseFeedIsBeingFetched = post.author.handle; // Assuming 'post' here is the original post that triggered the bot

                  let postDetail = "";
                  const snippetMaxLength = 75; // Max length for text snippets in context
                  const truncateText = (text, maxLength) => {
                    if (!text) return "";
                    return text.length > maxLength ? text.substring(0, maxLength - 3) + "..." : text;
                  };

                  if (feedItem.reason && feedItem.reason.$type === 'app.bsky.feed.defs#reasonRepost') {
                    // This is a repost BY THE USER whose feed we are fetching
                    // The feedItem.post is the post that was reposted.
                    const originalAuthorHandle = feedItem.post.author.handle;
                    const originalPostText = truncateText(feedItem.post.record.text, snippetMaxLength);
                    postDetail = `User (${userWhoseFeedIsBeingFetched}) reposted from @${originalAuthorHandle}: "${originalPostText}"`;
                  } else if (postAuthorHandle === userWhoseFeedIsBeingFetched) {
                    // This is an original action by the user (post, reply, quote post)
                    if (feedItem.post.record.reply) {
                      const parentAuthorHandle = feedItem.reply?.parent?.author?.handle || 'another user';
                      postDetail = `User (${userWhoseFeedIsBeingFetched}) replied to @${parentAuthorHandle}: "${truncateText(postText, snippetMaxLength)}"`;
                    } else if (feedItem.post.record.embed && feedItem.post.record.embed.$type === 'app.bsky.embed.record') {
                      // This is a quote post by the user
                      const quotedRecord = feedItem.post.record.embed.record;
                      // The 'quotedRecord' could be a full post object or a more minimal reference.
                      // We need to fetch the actual quoted post's content if it's just a reference,
                      // but for simplicity in context, we'll try to get text if available directly.
                      // A full implementation might require another fetch for `quotedRecord.uri` if text isn't readily available.
                      let quotedTextSnippet = "a post";
                      let quotedAuthor = "another user";
                      if (quotedRecord && quotedRecord.value && quotedRecord.value.text) { // Ideal case: full record embedded
                          quotedTextSnippet = truncateText(quotedRecord.value.text, snippetMaxLength);
                          quotedAuthor = quotedRecord.author?.handle || quotedAuthor;
                      } else if (quotedRecord && quotedRecord.uri) {
                          // If only URI, we could fetch it, but let's keep it simple for now.
                          // This part might need enhancement if full quoted text is critical.
                          quotedTextSnippet = `a post (URI: ${quotedRecord.uri.split('/').pop()})`;
                          // Attempt to get author from URI if possible, otherwise use a generic term
                          const didMatch = quotedRecord.uri.match(/at:\/\/(did:[^/]+)/);
                          if (didMatch && didMatch[1] && didMatch[1] !== post.author.did) { // Avoid self-quotes being confusingly attributed
                            // Ideally, resolve DID to handle here, but that's another API call.
                            // For now, we'll just note the DID or a generic term.
                            // This is a simplification; resolving DID to handle would be better.
                            // For now, we assume `feedItem.post.record.embed.record.author.handle` might exist if it's a resolved embed.
                            quotedAuthor = feedItem.post.record.embed.record.author?.handle || `user (${didMatch[1].substring(0,10)}...)`;
                          }
                      }
                      postDetail = `User (${userWhoseFeedIsBeingFetched}) quote posted (commenting on @${quotedAuthor}'s post): "${truncateText(postText, snippetMaxLength)}" which quoted: "${quotedTextSnippet}"`;
                    } else {
                      // Original post by the user
                      postDetail = `User (${userWhoseFeedIsBeingFetched}) posted: "${truncateText(postText, snippetMaxLength)}"`;
                    }
                  } else {
                    // This case should ideally not happen if getAuthorFeed is working as expected for 'userWhoseFeedIsBeingFetched'
                    // It means a post in the feed is not by the user and not a repost by the user.
                    // However, to be safe, we can log it or create a generic entry.
                    console.log(`[Context] Encountered unexpected item in feed for ${userWhoseFeedIsBeingFetched}: Post by ${postAuthorHandle}`);
                    postDetail = `Feed item concerning @${userWhoseFeedIsBeingFetched}: A post by @${postAuthorHandle}: "${truncateText(postText, snippetMaxLength)}"`;
                  }

                  if (postDetail) {
                    collectedPosts.push(postDetail);
                    fetchedPostsCount++;
                    if (fetchedPostsCount >= maxPostsToFetch) break;
                  }
                }
              }
              authorFeedCursor = authorFeed.data.cursor;
              if (!authorFeedCursor || authorFeed.data.feed.length < postsLimitPerCall || fetchedPostsCount >= maxPostsToFetch) {
                console.log("[Context] No more posts or cursor from getAuthorFeed.");
                break;
              }
            } else {
              console.log("[Context] No posts found in this batch or API call failed.");
              break;
            }
          }

          if (collectedPosts.length > 0) {
            userBlueskyPostsContext = "\n\nHere are some of the user's recent Bluesky posts for additional context:\n" + collectedPosts.join("\n---\n") + "\n\n";
            console.log(`[Context] Added ${collectedPosts.length} posts to Nemotron context.`);
          } else {
            console.log(`[Context] No posts were fetched for ${post.author.did} to add to context.`);
          }
        } catch (error) {
          console.error(`[Context] Error fetching Bluesky posts for ${post.author.did}:`, error);
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
Each point must start with an exact marker: "[DETAILED ANALYSIS POINT 1]", then "[DETAILED ANALYSIS POINT 2]", etc.
Each detailed point should be written as a complete, standalone message (under 290 characters), suitable for a separate Bluesky post. Ensure any internal lists (e.g., "1. Sub-point A, 2. Sub-point B") are well-formed within each point.
Analyze themes, common topics, or aspects of their online presence as reflected in their posts, replies, quote posts, and attributed reposts.

USER'S RECENT BLUESKY ACTIVITY:
${userBlueskyPostsContext}
---
${conversationHistory ? `\nBrief conversation history for immediate interaction context (less critical than the Bluesky Activity for this specific analysis):\n${conversationHistory}\n---` : ''}
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
          if (nextDetailPointIndex === -1) { // Maybe no detail points, or marker format issue
            summaryText = textAfterSummaryMarker.trim(); // Assume all remaining text is summary
          } else {
            summaryText = textAfterSummaryMarker.substring(0, nextDetailPointIndex).trim();
            textAfterSummaryMarker = textAfterSummaryMarker.substring(nextDetailPointIndex); // Remaining text has detail points
          }

          // Extract detailed points
          let currentPoint = 1;
          while (true) {
            const currentDetailMarker = `${detailMarkerBase}${currentPoint}]`;
            const nextDetailMarker = `${detailMarkerBase}${currentPoint + 1}]`;

            const startOfCurrentPoint = textAfterSummaryMarker.indexOf(currentDetailMarker);
            if (startOfCurrentPoint === -1) break; // No more points with this number

            let endOfCurrentPoint = textAfterSummaryMarker.indexOf(nextDetailMarker, startOfCurrentPoint + currentDetailMarker.length);
            let pointText;

            if (endOfCurrentPoint === -1) { // This is the last detail point
              pointText = textAfterSummaryMarker.substring(startOfCurrentPoint + currentDetailMarker.length).trim();
            } else {
              pointText = textAfterSummaryMarker.substring(startOfCurrentPoint + currentDetailMarker.length, endOfCurrentPoint).trim();
            }

            if (pointText) detailedPoints.push(pointText);
            if (endOfCurrentPoint === -1 || detailedPoints.length >= 3) break; // Max 3 detail points

            currentPoint++;
          }

          console.log(`[LlamaBot.generateResponse] Parsed Summary: "${summaryText}"`);
          detailedPoints.forEach((p, idx) => console.log(`[LlamaBot.generateResponse] Parsed Detail Point ${idx + 1}: "${p}"`));

          if (summaryText) {
            // Store detailed points if any, then return only summary for initial post
            // Post the summary first. No image on summary.
            const summaryPostedUris = await this.postReply(post, summaryText, null, null);

            if (summaryPostedUris && summaryPostedUris.length > 0) {
              const summaryPostUri = summaryPostedUris[0];
              console.log(`[LlamaBot.generateResponse] Summary posted successfully: ${summaryPostUri}`);
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
    } catch (error) {
      console.error('Error in LlamaBot.generateResponse:', error);
      return null; // Ensure null is returned on error so monitor doesn't try to post it.
    }
  }

  getModelName() {
    return 'nvidia/llama-3.3-nemotron-super-49b-v1 (filtered by meta/llama-4-scout-17b-16e-instruct)'.split('/').pop();
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
