import { AtpAgent } from '@atproto/api';
import { Anthropic } from '@anthropic-ai/sdk';
import config from './config.js';
import fetch from 'node-fetch';
import { fal } from "@fal-ai/client";
import sharp from 'sharp';
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

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
});

// Initialize fal client explicitly
fal.config({
  credentials: process.env.FAL_API_KEY,
});

console.log('FAL client configured with credentials');

// Initialize Replied Posts List
const repliedPosts = new Set();

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

// Function to authenticate with Bluesky
async function authenticate() {
  try {
    await agent.login({
      identifier: config.BLUESKY_IDENTIFIER,
      password: config.BLUESKY_APP_PASSWORD,
    });
    console.log('Successfully authenticated with Bluesky');
  } catch (error) {
    console.error('Authentication failed:', error);
    throw error;
  }
}

// Function to get recent posts from the monitored handle
async function getRecentPosts() {
  try {
    const { data: notifications } = await agent.listNotifications({
      limit: 20
    });
    
    if (!notifications || !notifications.notifications) {
      throw new Error('No notifications returned');
    }
    
    // Filter for mention notifications, excluding self-mentions
    const relevantPosts = notifications.notifications
      .filter(notif => {
        // Check if it's a mention
        if (notif.reason !== 'mention') return false;
        
        // Prevent self-replies
        return notif.author.handle !== config.BLUESKY_IDENTIFIER;
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
async function getReplyContext(post) {
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
          const quotedPostResponse = await agent.getPost({
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
        const { data: thread } = await agent.getPostThread({
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

async function generateClaudeResponse(post, context) {
  try {
    let messages = [{ 
      role: 'user', 
      content: [
        {
          type: 'text',
          text: `You are part of a bot designed to respond to a conversation on Bluesky. You will write a reply, and another part fo the bot will post it. Here's the context, with the oldest message first:\n\n`
        }
      ]
    }];

    // Add context messages with images
    if (context && context.length > 0) {
      for (const msg of context) {
        let content = [{
          type: 'text',
          text: `${msg.author}: ${msg.text}`
        }];
        
        // Add images if present
        if (msg.images && msg.images.length > 0) {
          console.log(`Processing ${msg.images.length} images for message`);
          for (const image of msg.images) {
            console.log(`Converting image to base64: ${image.url}`);
            const base64Image = await utils.imageUrlToBase64(image.url);
            if (base64Image) {
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg', // Adjust based on actual image type if needed
                  data: base64Image
                }
              });
              if (image.alt) {
                content.push({
                  type: 'text',
                  text: `[Image description: ${image.alt}]`
                });
              }
            }
          }
        }
        
        messages[0].content.push(...content);
      }
    }
    
    console.log('Final messages object:', JSON.stringify(messages, null, 2));
    
    // Add the final message
    messages[0].content.push({
      type: 'text',
      text: `\nThe most recent message mentioning you is: "${post.record.text}"\n\nPlease respond to the request in the most recent message in 300 characters or less. Your response will be posted to BlueSky as a reply to the most recent message mentioning you by a bot. `
    });

    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 150,
      messages: messages
    });

    return message.content[0].text;
  } catch (error) {
    console.error('Error generating Claude response:', error);
    return null;
  }
}

// Modify the postReply function
async function postReply(post, response) {
  try {
    RateLimit.check();
    
    // Generate image prompt using Claude Haiku
    const promptMessage = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Create a prompt for an image model based on the following question and answer. If the prompt doesn't already have animals in it, add cats.\n\nQ: ${post.record.text}\nA: ${response}`
      }]
    });

    const imagePrompt = promptMessage.content[0].text;
    console.log('Generated image prompt:', imagePrompt);

    // Generate image using Fal
    const falResult = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt: imagePrompt,
        image_size: {
          width: 512,
          height: 512
        }
      },
      logs: true
    });
    
    console.log('FAL.ai response:', falResult);
    const imageUrl = falResult.data.images[0].url;

    // Fetch the image directly
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = await imageResponse.buffer();

    // Process image just to ensure correct format and size
    const processedImageBuffer = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Upload directly to Bluesky
    const uploadResult = await agent.uploadBlob(processedImageBuffer, {
      encoding: 'image/jpeg'
    });

    // Create detailed alt text
    const altText = [
      'Response Model: Claude 3.5 Sonnet',
      'Response Prompt: Text and images upthread of this comment',
      'Image Prompt Model: Claude 3.5 Haiku',
      `Image Prompt: ${imagePrompt}`,
      'Image Generation Model: Fal AI Flux/Schnell'
    ].join('\n');

    const replyObject = {
      text: utils.truncateResponse(response),
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{
          alt: altText,
          image: uploadResult.data.blob
        }]
      },
      reply: {
        root: post.record?.reply?.root || { uri: post.uri, cid: post.cid },
        parent: { uri: post.uri, cid: post.cid }
      }
    };

    const result = await agent.post(replyObject);
    console.log('Successfully posted reply:', result.uri);
    repliedPosts.add(post.uri);
  } catch (error) {
    console.error('Error posting reply:', error);
    repliedPosts.add(post.uri); // Prevent retries
  }
}

// Function to check if we've already replied to a post
async function hasAlreadyReplied(post) {
  try {
    // First check our local Set
    if (repliedPosts.has(post.uri)) {
      console.log('Found post in local reply history');
      return true;
    }

    console.log(`Checking for existing replies to post: ${post.uri}`);
    const { data: thread } = await agent.getPostThread({
      uri: post.uri,
      depth: 1,
      parentHeight: 1
    });

    console.log(`Thread data:`, JSON.stringify(thread, null, 2));

    if (thread.thread.replies && thread.thread.replies.length > 0) {
      const hasReply = thread.thread.replies.some(reply => 
        reply.post.author.handle === config.BLUESKY_IDENTIFIER
      );
      if (hasReply) {
        // Add to our Set if we find an existing reply
        repliedPosts.add(post.uri);
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

// Main monitoring loop
async function monitor() {
  let consecutiveErrors = 0;
  const MAX_RETRIES = 5;
  const BACKOFF_DELAY = 60000; // 1 minute

  try {
    await authenticate();
    
    console.log('Starting monitoring...');

    let lastCheckedPost = null;

    while (true) {
      try {
        const posts = await getRecentPosts();
        
        if (!posts.length) {
          console.log('No posts found');
          await utils.sleep(config.CHECK_INTERVAL);
          continue;
        }

        const latestPost = posts[0];
        
        if (lastCheckedPost && latestPost.uri === lastCheckedPost) {
          console.log('Already processed this post, skipping...');
          await utils.sleep(config.CHECK_INTERVAL);
          continue;
        }
        
        lastCheckedPost = latestPost.uri;

        if (latestPost.post?.record?.text?.includes(config.BLUESKY_IDENTIFIER)) {
          const alreadyReplied = await hasAlreadyReplied(latestPost.post);
          
          if (!alreadyReplied) {
            console.log('Generating and posting response...');
            const context = await getReplyContext(latestPost.post);
            const response = await generateClaudeResponse(latestPost.post, context);
            
            if (response) {
              await postReply(latestPost.post, response);
              // Add rate limiting delay after posting
              await utils.sleep(2000);
            }
          }
        }

        consecutiveErrors = 0; // Reset error counter on success
        await utils.sleep(config.CHECK_INTERVAL);

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

// Start the bot
monitor().catch(console.error);