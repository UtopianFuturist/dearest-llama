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

          if (latestPost.post?.record?.text?.includes(this.config.BLUESKY_IDENTIFIER)) {
            const alreadyReplied = await this.hasAlreadyReplied(latestPost.post);
            
            if (!alreadyReplied) {
              console.log('Generating and posting response...');
              const context = await this.getReplyContext(latestPost.post);
              const response = await this.generateResponse(latestPost.post, context);
              
              if (response) {
                await this.postReply(latestPost.post, response);
                // Add rate limiting delay after posting
                await utils.sleep(2000);
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
          // Check if it's a mention
          if (notif.reason !== 'mention') return false;
          
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
  async postReply(post, response) {
    try {
      RateLimit.check();
      
      const replyObject = {
        text: utils.truncateResponse(response),
        reply: {
          root: post.record?.reply?.root || { uri: post.uri, cid: post.cid },
          parent: { uri: post.uri, cid: post.cid }
        }
      };

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
      console.log(`NIM CALL START: generateResponse for model meta/llama-4-scout-17b-16e-instruct`);
      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
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
              content: this.config.TEXT_SYSTEM_PROMPT
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
      console.log(`NIM CALL END: generateResponse for model meta/llama-4-scout-17b-16e-instruct - Status: ${response.status}`);

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
      
      return data.choices[0].message.content;
    } catch (error) {
      console.error('Error generating Llama response:', error);
      // Return a fallback message or null based on your error handling strategy
      return null;
    }
  }

  getModelName() {
    return 'meta/llama-4-scout-17b-16e-instruct'.split('/').pop();
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
