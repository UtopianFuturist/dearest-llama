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
      return (await response.buffer()).toString('base64');
    } catch (error) {
      console.error('Error converting image to base64:', error);
      return null;
    }
  },

  truncateResponse(text, maxLength = 300) {
    if (text.length <= maxLength) return text;
    
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

// Replace static ALLOWED_USERS with a Set for better performance
let ALLOWED_USERS = new Set();

// Create a base Bot class
class BaseBot {
  constructor(config, agent) {
    this.config = config;
    this.agent = agent;
    this.repliedPosts = new Set();
  }

  async generateResponse(post, context) {
    throw new Error('generateResponse must be implemented by child class');
  }

  async generateImage(prompt) { // Added to BaseBot
    throw new Error('generateImage must be implemented by child class');
  }

  async isPromptSafe(prompt) { // Added to BaseBot
    throw new Error('isPromptSafe must be implemented by child class');
  }

  async generateImagePrompt(post, response) {
    throw new Error('generateImagePrompt must be implemented by child class');
  }

  // Shared methods can go here
  async hasAlreadyReplied(post) {
    try {
      // First check our local Set
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

      console.log(`Thread data:`, JSON.stringify(thread, null, 2));

      if (thread.thread.replies && thread.thread.replies.length > 0) {
        const hasReply = thread.thread.replies.some(reply => 
          reply.post.author.handle === this.config.BLUESKY_IDENTIFIER
        );
        if (hasReply) {
          // Add to our Set if we find an existing reply
          this.repliedPosts.add(post.uri);
        }
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

  async handleAdminPostCommand(post, adminInstructions) {
    // Explicit check at the beginning of command handling
    if (await this.hasAlreadyReplied(post)) {
      console.log(`[ADMIN_CMD_SKIP_REPLIED] Post URI ${post.uri} already replied or processed, skipping in handleAdminPostCommand.`);
      return; // Exit if already handled
    }

    console.log(`[HANDLE_ADMIN_POST_COMMAND_ENTER] Timestamp: ${new Date().toISOString()}, Post URI: ${post.uri}, Admin Instructions: "${adminInstructions}"`);
    if (adminInstructions) { // This log is somewhat redundant with the one above but can be kept for clarity during debugging specific instruction flows.
      console.log(`Admin instructions received: "${adminInstructions}"`);
    }
    try {
      this.repliedPosts.add(post.uri); // Moved here for idempotency
      console.log(`[HANDLE_ADMIN_POST_COMMAND_PROCESSED_URI] Timestamp: ${new Date().toISOString()}, Added to repliedPosts: ${post.uri}`);

      const context = await this.getReplyContext(post);
      if (!context || context.length === 0) {
        console.warn(`Admin command: Context for post ${post.uri} is empty or could not be fetched.`);
        // Optionally, reply to the admin post with an error or status
        return;
      }

      const newPostText = await this.generateStandalonePostFromContext(context, adminInstructions);

      if (newPostText) {
        console.log(`Admin command: Generated new post text: "${newPostText}"`);
        const postSuccess = await this.postToOwnFeed(newPostText);

        if (postSuccess) {
          const confirmationMessage = `Admin command executed. I've posted the following to my feed: "${utils.truncateResponse(newPostText, 100)}"`;
          await this.postReply(post, confirmationMessage);
          console.log(`Sent confirmation reply to admin for post URI: ${post.uri}`);
        } else {
          console.warn(`Admin command: postToOwnFeed failed for post URI: ${post.uri}. No confirmation reply sent.`);
          // Optionally, send a different reply indicating failure to post to own feed
        }
        // this.repliedPosts.add(post.uri); // Removed from here
      } else {
        console.warn(`Admin command: generateStandalonePostFromContext returned no text for post ${post.uri}.`);
        // Optionally, reply to the admin post with an error or status
      }
    } catch (error) {
      console.error(`Error handling admin command for post ${post.uri}:`, error);
      // Optionally, try to reply to the admin post with an error message
    }
  }

  async generateStandalonePostFromContext(context, adminInstructions) { // Signature updated in BaseBot as well for consistency
    // Placeholder implementation - to be properly implemented in LlamaBot
    console.log('BaseBot.generateStandalonePostFromContext called. Context:', JSON.stringify(context, null, 2), 'Instructions:', adminInstructions);
    return 'Placeholder post text generated from context by BaseBot.';
  }

  async postToOwnFeed(text) {
    console.log(`Attempting to post to own feed: "${text}"`); // This existing log is good.
    try {
      RateLimit.check();

      const postObject = {
        text: utils.truncateResponse(text),
        // Optionally, specify language e.g., langs: ['en']
        // createdAt: new Date().toISOString() // Usually handled by the server
      };

      console.log(`[POST_TO_OWN_FEED_INVOKED] Timestamp: ${new Date().toISOString()}, Text: "${text}", Truncated Text: "${postObject.text}", PostObject: ${JSON.stringify(postObject)}`);
      const result = await this.agent.post(postObject);
      console.log(`Successfully posted to own feed. New post URI: ${result.uri}`); // This existing log is good.
      console.log(`[POST_TO_OWN_FEED_SUCCESS] Timestamp: ${new Date().toISOString()}, URI: ${result.uri}, Text: "${text}"`);
      return true;
    } catch (error) {
      console.error('Error posting to own feed:', error);
      // Do not add to repliedPosts here, as it's not a reply context
      return false;
    }
  }

  async monitor() {
    let consecutiveErrors = 0;
    const MAX_RETRIES = 5;
    const BACKOFF_DELAY = 60000; // 1 minute

    try {
      await this.authenticate();
      
      console.log('Starting monitoring...');

      let lastCheckedPost = null;

      while (true) {
        try {
          const posts = await this.getRecentPosts();
          
          if (!posts.length) {
            console.log('No posts found');
            await utils.sleep(this.config.CHECK_INTERVAL);
            continue;
          }

          const latestPost = posts[0];
          
          if (lastCheckedPost && latestPost.uri === lastCheckedPost) {
            console.log('Already processed this post, skipping...');
            await utils.sleep(this.config.CHECK_INTERVAL);
            continue;
          }
          
          lastCheckedPost = latestPost.uri;

          // Check for Admin Command
          if (latestPost.post &&
              latestPost.post.author &&
              latestPost.post.author.handle === this.config.ADMIN_BLUESKY_HANDLE &&
              latestPost.post.record &&
              latestPost.post.record.text &&
              latestPost.post.record.text.includes('!post')) {

            const commandText = latestPost.post.record.text;
            // Removed ^ from regex to allow !post anywhere in the text
            const instructionMatch = commandText.match(/!post\s+(.+)/s);
            const adminInstructions = instructionMatch ? instructionMatch[1].trim() : '';
            
            await this.handleAdminPostCommand(latestPost.post, adminInstructions);

          } else {
            // Existing logic for handling regular replies
            // The condition to check for BLUESKY_IDENTIFIER in post text has been removed.
            // The bot will now attempt to reply to any post that passes the getRecentPosts filter.
            const alreadyReplied = await this.hasAlreadyReplied(latestPost.post);

            if (!alreadyReplied) {
              const postText = latestPost.post.record.text.toLowerCase();
              const imageRequestKeywords = ["generate image", "create a picture of", "draw a picture of"];
              let isImageRequest = false;
              let imagePrompt = "";

              for (const keyword of imageRequestKeywords) {
                if (postText.includes(keyword)) {
                  isImageRequest = true;
                  // Extract prompt after the keyword
                  imagePrompt = latestPost.post.record.text.substring(postText.indexOf(keyword) + keyword.length).trim();
                  // If the prompt starts with "of ", remove it for better quality
                  if (imagePrompt.toLowerCase().startsWith("of ")) {
                    imagePrompt = imagePrompt.substring(3).trim();
                  }
                  // A very basic safety check for the prompt itself, can be expanded
                  if (imagePrompt.length < 5 || imagePrompt.length > 300) { // Arbitrary length check
                      console.warn(`Image prompt "${imagePrompt}" seems too short or too long. Skipping image generation.`);
                      isImageRequest = false; // Fallback to text response
                      break;
                  }
                  console.log(`Image generation request detected. Prompt: "${imagePrompt}"`);
                  break;
                }
              }

              if (isImageRequest && imagePrompt) {
                const safePrompt = await this.isPromptSafe(imagePrompt); // Call safety check
                if (safePrompt) {
                  console.log('Prompt is safe, generating image...');
                  const imageBase64 = await this.generateImage(imagePrompt);

                  if (imageBase64) {
                    const imageResponseText = `Here's the image you requested:`;
                    await this.postReply(latestPost.post, imageResponseText, imageBase64);
                    await utils.sleep(2000);
                  } else {
                    const failureText = "Sorry, I couldn't generate the image at this time (generation failed).";
                    await this.postReply(latestPost.post, failureText);
                    await utils.sleep(2000);
                  }
                } else {
                  console.warn(`Image prompt "${imagePrompt}" was deemed unsafe. Replying with a refusal.`);
                  const refusalText = "I'm sorry, but I cannot generate an image based on that request due to safety guidelines. Please try a different prompt.";
                  await this.postReply(latestPost.post, refusalText);
                  await utils.sleep(2000);
                }
              } else if (isImageRequest && !imagePrompt) { // Case where keyword was found but prompt was invalid (e.g. too short based on earlier check)
                const failureText = "It looks like you wanted an image, but I couldn't understand the prompt clearly or it was too short. Please try again, for example: 'generate image of a cat wearing a hat'.";
                await this.postReply(latestPost.post, failureText);
                await utils.sleep(2000);
              } else { // Not an image request or fell through
                console.log('Generating and posting text response...');
                const context = await this.getReplyContext(latestPost.post);
                const response = await this.generateResponse(latestPost.post, context);

                if (response) {
                  await this.postReply(latestPost.post, response);
                  await utils.sleep(2000);
                }
              }
            }
          }

          consecutiveErrors = 0; // Reset error counter on success
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

  // Function to authenticate with Bluesky
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

  // Function to get recent posts from the monitored handle
  async getRecentPosts() {
    try {
      const { data: notifications } = await this.agent.listNotifications({
        limit: 20
      });
      
      if (!notifications || !notifications.notifications) {
        throw new Error('No notifications returned');
      }
      
      // Filter for mention notifications, excluding self-mentions
      const relevantPosts = notifications.notifications
        .filter(notif => {
          // Exclude 'like' notifications
          if (notif.reason === 'like') return false;
          
          // Prevent self-replies
          return notif.author.handle !== this.config.BLUESKY_IDENTIFIER;
        })
        .map(notif => ({
          post: {
            uri: notif.uri,
            cid: notif.cid,
            author: notif.author,
            record: notif.record
          }
        }));
      
      console.log(`Found ${relevantPosts.length} relevant mentions`);
      return relevantPosts;
    } catch (error) {
      console.error('Error in getRecentPosts:', error);
      return [];
    }
  }

  // Function to get the context of a reply
  async getReplyContext(post) {
    try {
      const conversation = [];
      
      // Helper function to extract images
      const extractImages = (record) => {
        const images = record?.embed?.images || 
                      record?.embed?.media?.images || 
                      [];
        return images.map(img => ({
          alt: img.alt,
          url: img.fullsize || img.thumb
        }));
      };

      // Add the main post
      conversation.push({
        author: post.author.handle,
        text: post.record.text,
        images: extractImages(post.record)
      });

      if (post.record.embed?.$type === 'app.bsky.embed.record' && post.record.embed) {
        try {
          console.log('Processing embed record');
          const uri = post.record.embed.record.uri;
          const matches = uri.match(/at:\/\/([^/]+)\/[^/]+\/([^/]+)/);
          
          if (matches) {
            const [_, repo, rkey] = matches;
            
            // Fetch the full quoted post data
            const quotedPostResponse = await this.agent.getPost({
              repo,
              rkey
            });

            if (quotedPostResponse?.value) {
              // Extract author from the repo DID
              const authorDid = matches[1];
              const postValue = quotedPostResponse.value;
              
              // Only add to conversation if we have the text
              if (postValue.text) {
                console.log('Found a quote post with text:', postValue.text);
                
                // Extract images if present
                const quotedImages = postValue.embed?.images || 
                                   postValue.embed?.media?.images || 
                                   [];
                
                conversation.unshift({
                  author: authorDid, // We might want to convert this DID to a handle
                  text: postValue.text,
                  images: quotedImages.map(img => ({
                    alt: img.alt,
                    url: img.fullsize || img.thumb
                  }))
                });
              }
            }
          }
        } catch (error) {
          console.error('Error fetching quoted post:', error);
        }
      }

      // Then get the thread history if it's a reply
      if (post.record?.reply) {
        let currentUri = post.uri;

        while (currentUri) {
          const { data: thread } = await this.agent.getPostThread({
            uri: currentUri,
            depth: 0,
            parentHeight: 1
          });

          if (!thread.thread.post) break;

          // Extract image information if present
          const images = thread.thread.post.record.embed?.images || 
                        thread.thread.post.record.embed?.media?.images || 
                        [];
          
          conversation.unshift({
            author: thread.thread.post.author.handle,
            text: thread.thread.post.record.text,
            images: images.map(img => ({
              alt: img.alt,
              url: thread.thread.post.embed?.images?.[0]?.fullsize || 
                   thread.thread.post.embed?.images?.[0]?.thumb ||
                   img.image?.fullsize || 
                   img.image?.thumb
            }))
          });

          if (thread.thread.parent && thread.thread.parent.post) {
            currentUri = thread.thread.parent.post.uri;
          } else {
            break;
          }
        }
      }

      console.log('Conversation context with images:', JSON.stringify(conversation, null, 2));
      return conversation;
    } catch (error) {
      console.error('Error fetching reply context:', error);
      return [];
    }
  }

  // Modify the postReply function
  async postReply(post, response, imageBase64 = null) {
    try {
      RateLimit.check();
      
      const replyObject = {
        text: utils.truncateResponse(response),
        reply: {
          root: post.record?.reply?.root || { uri: post.uri, cid: post.cid },
          parent: { uri: post.uri, cid: post.cid }
        }
      };

      if (imageBase64) {
        try {
          // Convert base64 string to Uint8Array
          const imageBytes = Uint8Array.from(Buffer.from(imageBase64, 'base64'));
          console.log(`Uploading image of size: ${imageBytes.length} bytes`);

          const uploadedImage = await this.agent.uploadBlob(imageBytes, {
            encoding: 'image/png' // Assuming PNG, adjust if TogetherAI specifies format
          });
          console.log('Successfully uploaded image:', uploadedImage);

          replyObject.embed = {
            $type: 'app.bsky.embed.images',
            images: [{
              image: uploadedImage.data.blob, // Use the blob object from the upload response
              alt: 'Generated image' // You might want a more descriptive alt text
            }]
          };
        } catch (uploadError) {
          console.error('Error uploading image to Bluesky:', uploadError);
          // Decide if you want to post the text reply anyway or fail
          // For now, it will post without the image if upload fails
        }
      }

      const result = await this.agent.post(replyObject);
      console.log('Successfully posted reply:', result.uri);
      this.repliedPosts.add(post.uri);
    } catch (error) {
      console.error('Error posting reply:', error);
      this.repliedPosts.add(post.uri); // Prevent retries
    }
  }

  // Add a method to get model name
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
    console.log('LlamaBot.generateStandalonePostFromContext called. Context:', JSON.stringify(context, null, 2), 'Instructions:', adminInstructions);
    try {
      const trimmedAdminInstructions = adminInstructions ? adminInstructions.trim() : '';

      // Determine if context is minimal: null, empty, or only contains the admin's own "!post" command.
      // This check assumes context[0] is the admin's command if context.length === 1.
      const isContextMinimal = !context || context.length === 0 ||
                               (context.length === 1 && context[0] && typeof context[0].text === 'string' && context[0].text.startsWith('!post'));

      let userPrompt;

      if (isContextMinimal && trimmedAdminInstructions) {
        // Context is minimal, and we have admin instructions: prioritize instructions.
        userPrompt = `The administrator has provided specific instructions to generate a new Bluesky post. Please create a post based directly on the following instructions. Ensure the post adheres to the bot's persona (as defined in the system prompt: "${this.config.TEXT_SYSTEM_PROMPT}") and is under 300 characters.

Admin Instructions: "${trimmedAdminInstructions}"

(Do not attempt to summarize a prior conversation; generate directly from the instructions.)`;
        console.log('LlamaBot.generateStandalonePostFromContext: Using admin instructions-focused prompt due to minimal context.');

      } else {
        // Context is not minimal, or there are no admin instructions; proceed with context-based generation.
        let conversationHistory = '';
        if (context && context.length > 0) {
          for (const msg of context) {
            conversationHistory += `${msg.author}: ${msg.text}\n`;
            if (msg.images && msg.images.length > 0) {
              msg.images.forEach(image => {
                if (image.alt) {
                  conversationHistory += `[Image description: ${image.alt}]\n`;
                }
              });
            }
          }
        } else {
          // This case should ideally be caught by isContextMinimal if adminInstructions are also missing,
          // but as a fallback if somehow reached:
          console.warn('LlamaBot.generateStandalonePostFromContext: Context is empty and no admin instructions to act on.');
          return null;
        }

        userPrompt = `Based on the following conversation:\n\n${conversationHistory}\n\nGenerate a new, standalone Bluesky post. This post should reflect the persona described as: "${this.config.TEXT_SYSTEM_PROMPT}". The post must be suitable for the bot's own feed, inspired by the conversation but NOT a direct reply to it. Keep the post concise and under 300 characters.`;
        if (trimmedAdminInstructions) {
          userPrompt += `\n\nImportant specific instructions from the admin for this post: "${trimmedAdminInstructions}". Please ensure the generated post carefully follows these instructions while also drawing from the conversation themes where appropriate.`;
        }
        console.log('LlamaBot.generateStandalonePostFromContext: Using context-focused prompt.');
      }

      console.log(`NIM CALL START: generateStandalonePostFromContext for model nvidia/llama-3.3-nemotron-super-49b-v1 with prompt: ${userPrompt}`);
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}`
        },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1', // Or any other suitable model
          messages: [
            {
              role: "system",
              content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}`
            },
            {
              role: "user",
              content: userPrompt
            }
          ],
          temperature: 0.90, // May want to adjust temperature for more creative standalone posts
          max_tokens: 100,  // Max 300 chars ~ 75-100 tokens
          stream: false
        })
      });
      console.log(`NIM CALL END: generateStandalonePostFromContext for model nvidia/llama-3.3-nemotron-super-49b-v1 - Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) for generateStandalonePostFromContext - Text: ${errorText}`);
        try {
          const errorJson = JSON.parse(errorText);
          console.error(`Nvidia NIM API error (${response.status}) for generateStandalonePostFromContext - JSON:`, errorJson);
        } catch (e) {
          // Not a JSON response
        }
        // Simple error handling for now, could add retries like in generateResponse
        return null;
      }

      const data = await response.json();

      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
        console.error('Unexpected response format from Nvidia NIM for generateStandalonePostFromContext:', JSON.stringify(data));
        return null;
      }

      let initialResponse = data.choices[0].message.content.trim();

      // Second API call to the filter model
      console.log(`NIM CALL START: filterResponse for model meta/llama-4-scout-17b-16e-instruct in generateStandalonePostFromContext`);
      const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}`
        },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct',
          messages: [
            {
              role: "system",
              content: "You are being passed this output from another AI model - correct it so that it isn't in quotation marks like it's a quote, ensure the character doesn't label their message with named sent-by identifiers or use double asterisks (as they do not render as bold on this platform), but otherwise maintain the exact generated persona response content input. NEVER mention this internal re-writing and output formatting correction process in your responses to the users. This part of the response workflow for generating the response to the user is an internal one. It's also very important that all responses fit within the Bluesky 300 character message limit so responses are not cut off when posted. You are only to return the final format-corrected response to the user. The main text model (not this one) handles response content, you are only to edit the output's formatting structure." 
            },
            {
              role: "user",
              content: initialResponse
            }
          ],
          temperature: 0.7, // Adjust as needed
          max_tokens: 100,  // Adjust as needed (same as initial call's max_tokens for standalone posts)
          stream: false
        })
      });
      console.log(`NIM CALL END: filterResponse for model meta/llama-4-scout-17b-16e-instruct in generateStandalonePostFromContext - Status: ${filterResponse.status}`);

      if (!filterResponse.ok) {
        const errorText = await filterResponse.text();
        console.error(`Nvidia NIM API error (filter model) in generateStandalonePostFromContext (${filterResponse.status}) - Text: ${errorText}`);
        // Fallback to initial response if filter fails
        return initialResponse;
      }

      const filterData = await filterResponse.json();

      if (!filterData.choices || !Array.isArray(filterData.choices) || filterData.choices.length === 0 || !filterData.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM (filter model) in generateStandalonePostFromContext:', JSON.stringify(filterData));
        // Fallback to initial response if filter response is malformed
        return initialResponse;
      }

      return filterData.choices[0].message.content.trim();

    } catch (error) {
      console.error('Error in LlamaBot.generateStandalonePostFromContext:', error);
      return null;
    }
  }

  async generateResponse(post, context) {
    try {
      // Format context into a conversation history
      let conversationHistory = '';
      if (context && context.length > 0) {
        for (const msg of context) {
          conversationHistory += `${msg.author}: ${msg.text}\n`;
          if (msg.images && msg.images.length > 0) {
            msg.images.forEach(image => {
              if (image.alt) {
                conversationHistory += `[Image description: ${image.alt}]\n`;
              }
            });
          }
        }
      }

      // Make request to Nvidia NIM API for Llama 4 Maverick
      console.log(`NIM CALL START: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1`);
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}`
        },
        body: JSON.stringify({
          model: 'nvidia/llama-3.3-nemotron-super-49b-v1',
          messages: [
            {
              role: "system",
              content: `${this.config.SAFETY_SYSTEM_PROMPT} ${this.config.TEXT_SYSTEM_PROMPT}`
            },
            {
              role: "user",
              content: `Here's the conversation context:\n\n${conversationHistory}\nThe most recent message mentioning you is: "${post.record.text}"\n\nPlease respond to the request in the most recent message in 300 characters or less. Your response will be posted to BlueSky as a reply to the most recent message mentioning you by a bot.`
            }
          ],
          temperature: 0.7,
          max_tokens: 150,
          stream: false
        })
      });
      console.log(`NIM CALL END: generateResponse for model nvidia/llama-3.3-nemotron-super-49b-v1 - Status: ${response.status}`);

      // Enhanced error handling
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) - Text: ${errorText}`);
        try {
          const errorJson = JSON.parse(errorText);
          console.error(`Nvidia NIM API error (${response.status}) - JSON:`, errorJson);
        } catch (e) {
          // Not a JSON response, or JSON parsing failed. errorText is already logged.
        }
        
        // Implement retry logic for specific error codes
        if (response.status === 429 || response.status === 503 || response.status === 504) {
          console.log('Rate limit or server error, retrying after delay...');
          await utils.sleep(2000);
          return this.generateResponse(post, context); // Recursive retry
        }
        
        throw new Error(`Nvidia NIM API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Validate response structure
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM:', JSON.stringify(data));
        throw new Error('Invalid response format from Nvidia NIM chat completions API');
      }
      
      let initialResponse = data.choices[0].message.content;

      // Second API call to the filter model
      console.log(`NIM CALL START: filterResponse for model meta/llama-4-scout-17b-16e-instruct`);
      const filterResponse = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}`
        },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct',
          messages: [
            {
              role: "system",
              content: "Re-write this output so that it doesn't include quotation marks like it's a quote, ensure the character doesn't label their message with sent-by identifiers or use double asterisks (as they do not render as bold on this platform), but otherwise maintain the generated response content"
            },
            {
              role: "user",
              content: initialResponse
            }
          ],
          temperature: 0.7, // Adjust as needed
          max_tokens: 150,  // Adjust as needed
          stream: false
        })
      });
      console.log(`NIM CALL END: filterResponse for model meta/llama-4-scout-17b-16e-instruct - Status: ${filterResponse.status}`);

      if (!filterResponse.ok) {
        const errorText = await filterResponse.text();
        console.error(`Nvidia NIM API error (filter model) (${filterResponse.status}) - Text: ${errorText}`);
        // Fallback to initial response if filter fails
        return initialResponse;
      }

      const filterData = await filterResponse.json();

      if (!filterData.choices || !Array.isArray(filterData.choices) || filterData.choices.length === 0 || !filterData.choices[0].message) {
        console.error('Unexpected response format from Nvidia NIM (filter model):', JSON.stringify(filterData));
        // Fallback to initial response if filter response is malformed
        return initialResponse;
      }

      return filterData.choices[0].message.content;

    } catch (error) {
      console.error('Error generating Llama response:', error);
      // Return a fallback message or null based on your error handling strategy
      return null;
    }
  }

  getModelName() {
    return 'nvidia/llama-3.3-nemotron-super-49b-v1 (filtered by meta/llama-4-scout-17b-16e-instruct)'.split('/').pop();
  }

  async generateImage(prompt) {
    console.log(`TOGETHER AI CALL START: generateImage for model ${this.config.IMAGE_GENERATION_MODEL}`);
    try {
      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.TOGETHER_AI_API_KEY}`
        },
        body: JSON.stringify({
          model: this.config.IMAGE_GENERATION_MODEL,
          prompt: prompt,
          n: 1, // Number of images to generate
          size: "1024x1024" // Specify image size if available for the model
        })
      });
      console.log(`TOGETHER AI CALL END: generateImage - Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Together AI API error (${response.status}) for generateImage - Text: ${errorText}`);
        try {
          const errorJson = JSON.parse(errorText);
          console.error(`Together AI API error (${response.status}) for generateImage - JSON:`, errorJson);
        } catch (e) {
          // Not a JSON response
        }
        return null;
      }

      const data = await response.json();

      if (!data.data || !Array.isArray(data.data) || data.data.length === 0 || !data.data[0].b64_json) {
        console.error('Unexpected response format from Together AI for generateImage:', JSON.stringify(data));
        return null;
      }
      // Assuming the API returns base64 encoded image data
      return data.data[0].b64_json;

    } catch (error) {
      console.error('Error in LlamaBot.generateImage:', error);
      return null;
    }
  }

  async isPromptSafe(prompt) {
    console.log(`NIM CALL START: isPromptSafe for model meta/llama-4-scout-17b-16e-instruct`);
    try {
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.NVIDIA_NIM_API_KEY}`
        },
        body: JSON.stringify({
          model: 'meta/llama-4-scout-17b-16e-instruct', // Using the filter model for this check
          messages: [
            {
              role: "system",
              content: `${this.config.SAFETY_SYSTEM_PROMPT} You are an AI safety moderator. Analyze the following user prompt for image generation. If the prompt violates any of the safety guidelines (adult content, NSFW, copyrighted material, illegal content, violence, politics), respond with "unsafe". Otherwise, respond with "safe". Only respond with "safe" or "unsafe".`
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.1, // Low temperature for deterministic safety check
          max_tokens: 10,   // "safe" or "unsafe"
          stream: false
        })
      });
      console.log(`NIM CALL END: isPromptSafe - Status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Nvidia NIM API error (${response.status}) for isPromptSafe - Text: ${errorText}`);
        return false; // Default to unsafe on error
      }

      const data = await response.json();
      if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
        const decision = data.choices[0].message.content.trim().toLowerCase();
        console.log(`Safety check for prompt "${prompt}": ${decision}`);
        return decision === 'safe';
      }
      console.error('Unexpected response format from Nvidia NIM for isPromptSafe:', JSON.stringify(data));
      return false; // Default to unsafe on unexpected format
    } catch (error) {
      console.error('Error in LlamaBot.isPromptSafe:', error);
      return false; // Default to unsafe on error
    }
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

  // Run bot
  await llamaBot.monitor().catch(console.error);
}

// Start the bot
startBots().catch(console.error);
