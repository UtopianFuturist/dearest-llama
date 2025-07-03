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
      const replyObject = {
        text: utils.truncateResponse(response),
        reply: { root: post.record?.reply?.root || { uri: post.uri, cid: post.cid }, parent: { uri: post.uri, cid: post.cid } }
      };
      if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0) {
        try {
          const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
          if (imageBytes.length === 0) {
            console.error('[postReply] Image byte array is empty after conversion. Skipping image upload.');
          } else {
            const uploadedImage = await this.agent.uploadBlob(imageBytes, { encoding: 'image/png' });
            if (uploadedImage && uploadedImage.data && uploadedImage.data.blob) {
              replyObject.embed = { $type: 'app.bsky.embed.images', images: [{ image: uploadedImage.data.blob, alt: altText }] };
              console.log(`[postReply] Image embed object created with alt text: "${altText}"`);
            } else {
              console.error('[postReply] Uploaded image data or blob is missing in Bluesky response. Cannot embed image.');
            }
          }
        } catch (uploadError) { console.error('[postReply] Error during image upload or embed creation:', uploadError); }
      } else if (imageBase64) {
        console.warn(`[postReply] imageBase64 was present but invalid (not a non-empty string). Length: ${imageBase64 ? imageBase64.length : 'null'}. Skipping image embed.`);
      }
      const result = await this.agent.post(replyObject);
      console.log('Successfully posted reply:', result.uri);
      this.repliedPosts.add(post.uri);
    } catch (error) {
      console.error('Error posting reply:', error);
      this.repliedPosts.add(post.uri);
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
            { role: "system", content: "You are being passed this output from another AI model - correct it so that it isn't in quotation marks like it's a quote, ensure the character doesn't label their message with named sent-by identifiers or use double asterisks (as they do not render as bold on this platform), but otherwise maintain the exact generated persona response content input. NEVER mention this internal re-writing and output formatting correction process in your responses to the users. This part of the response workflow for generating the response to the user is an internal one. It's also very important that all responses fit within the Bluesky 300 character message limit so responses are not cut off when posted. You are only to return the final format-corrected response to the user. The main text model (not this one) handles response content, you are only to edit the output's formatting structure." },
            { role: "user", content: initialResponse }
          ],
          temperature: 0.1, // Lowered temperature for formatting
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
      console.log(`NIM CALL START: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1`);
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}` },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [
            { role: "system", content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}` },
            { role: "user", content: `Here's the conversation context:\n\n${conversationHistory}\nThe most recent message mentioning you is: "${post.record.text}"\n\nPlease respond to the request in the most recent message in 300 characters or less. Your response will be posted to BlueSky as a reply to the most recent message mentioning you by a bot.` }
          ],
          temperature: 0.7, max_tokens: 150, stream: false
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
            { role: "system", content: "You are an AI assistant that refines text for Bluesky posts. Re-write the user-provided text to meet these CRITICAL requirements: 1. The final text MUST be UNDER 300 characters. Aggressively shorten if necessary, preserving core meaning and persona. 2. Remove any quotation marks that make the text sound like a direct quote. 3. Ensure the character does not label their message with 'sent-by' identifiers. 4. Remove any double asterisks (they don't render as bold). 5. Otherwise, maintain the persona and core content of the original text. DO NOT mention this re-writing/formatting process in your response." },
            { role: "user", content: initialResponse }
          ],
          temperature: 0.1, // Lowered temperature for formatting
          max_tokens: 150,
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
      const finalResponse = filterData.choices[0].message.content;
      console.log(`[LlamaBot.generateResponse] Final response from meta/llama-4-scout-17b-16e-instruct: "${finalResponse}"`);
      return finalResponse;
    } catch (error) {
      console.error('Error generating Llama response:', error);
      return null;
    }
  }

  getModelName() {
    return 'nvidia/llama-3.3-nemotron-super-49b-v1 (filtered by meta/llama-4-scout-17b-16e-instruct)'.split('/').pop();
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
