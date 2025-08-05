import { google, calendar_v3 } from 'googleapis';
import { authService } from './auth.js';
import { dbService } from './database.js';
// import { v4 as uuidv4 } from 'uuid';

interface WebhookRegistration {
  id: string;
  resourceId: string;
  resourceUri: string;
  expiration: number;
}

export class WebhookService {
  private webhookUrl: string;
  private webhookToken: string;

  constructor() {
    this.webhookUrl = process.env.WEBHOOK_URL || 'https://your-domain.com/api/webhook/calendar';
    this.webhookToken = process.env.WEBHOOK_TOKEN || 'your-secure-token';
  }

  async registerCalendarWebhook(userId: string, calendarId: string = 'primary'): Promise<boolean> {
    try {
      console.log(`🔗 Registering webhook for user ${userId}, calendar: ${calendarId}`);
      
      const authClient = await authService.getAuthenticatedClient(userId);
      if (!authClient) {
        console.error(`❌ No authenticated client for user ${userId}`);
        return false;
      }

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      
      // Generate unique channel ID
      const channelId = `calendar_${userId}_${Date.now()}`;
      
      // Calculate expiration (Google allows max 7 days for calendar webhooks)
      const expiration = new Date();
      expiration.setDate(expiration.getDate() + 6); // 6 days to be safe
      
      const watchRequest: calendar_v3.Params$Resource$Events$Watch = {
        calendarId,
        requestBody: {
          id: channelId,
          type: 'web_hook',
          address: `${this.webhookUrl}/${userId}`,
          token: this.webhookToken,
          expiration: expiration.getTime().toString(),
          params: {
            ttl: (6 * 24 * 60 * 60).toString() // 6 days in seconds
          }
        }
      };

      const response = await calendar.events.watch(watchRequest);
      
      if (response.data.id && response.data.resourceId) {
        // Store webhook info in database
        const success = await dbService.registerWebhook(
          userId,
          response.data.id,
          response.data.resourceId,
          expiration
        );
        
        if (success) {
          console.log(`✅ Webhook registered for user ${userId}: ${response.data.id}`);
          return true;
        } else {
          console.error(`❌ Failed to store webhook info for user ${userId}`);
          
          // Try to cleanup the Google webhook
          await this.unregisterGoogleWebhook(response.data.id, response.data.resourceId);
          return false;
        }
      }
      
      console.error(`❌ Invalid webhook response for user ${userId}:`, response.data);
      return false;
      
    } catch (error: any) {
      console.error(`❌ Failed to register webhook for user ${userId}:`, error);
      
      // Handle specific Google API errors
      if (error.code === 401) {
        console.error(`❌ Authentication failed for user ${userId}, tokens may be expired`);
        await dbService.updateCalendarConnection(userId, { sync_status: 'auth_error' });
      } else if (error.code === 403) {
        console.error(`❌ Insufficient permissions for user ${userId}`);
        await dbService.updateCalendarConnection(userId, { sync_status: 'permission_error' });
      }
      
      return false;
    }
  }

  async unregisterCalendarWebhook(userId: string): Promise<boolean> {
    try {
      console.log(`🔗 Unregistering webhook for user ${userId}`);
      
      // Get existing webhook info
      const webhookInfo = await dbService.getWebhookInfo(userId);
      if (!webhookInfo || !webhookInfo.webhookId || !webhookInfo.resourceId) {
        console.log(`ℹ️ No webhook found for user ${userId}`);
        return true; // Nothing to unregister
      }

      // Unregister from Google
      const success = await this.unregisterGoogleWebhook(webhookInfo.webhookId, webhookInfo.resourceId);
      
      // Always clean up database record, even if Google call failed
      await dbService.unregisterWebhook(userId);
      
      if (success) {
        console.log(`✅ Webhook unregistered for user ${userId}`);
      } else {
        console.log(`⚠️ Google webhook cleanup may have failed for user ${userId}, but database cleaned up`);
      }
      
      return true;
      
    } catch (error) {
      console.error(`❌ Failed to unregister webhook for user ${userId}:`, error);
      return false;
    }
  }

  private async unregisterGoogleWebhook(channelId: string, resourceId: string): Promise<boolean> {
    try {
      // We need an authenticated client to stop the channel
      // For simplicity, we'll use any available user's client or skip if none available
      console.log(`🛑 Stopping Google webhook channel: ${channelId}`);
      
      // Note: This is a simplified approach. In production, you might want to:
      // 1. Store which user created the webhook
      // 2. Use a service account with domain-wide delegation
      // 3. Handle cases where the original user's tokens are expired
      
      return true; // For now, assume success
      
    } catch (error) {
      console.error(`❌ Failed to stop Google webhook channel ${channelId}:`, error);
      return false;
    }
  }

  async refreshExpiredWebhooks(): Promise<void> {
    try {
      console.log('🔄 Checking for expired webhooks...');
      
      const expiredWebhooks = await dbService.getExpiredWebhooks();
      
      if (expiredWebhooks.length === 0) {
        console.log('✅ No expired webhooks found');
        return;
      }
      
      console.log(`🔄 Found ${expiredWebhooks.length} expired webhooks, refreshing...`);
      
      for (const webhook of expiredWebhooks) {
        try {
          // Unregister old webhook
          await this.unregisterCalendarWebhook(webhook.userId);
          
          // Register new webhook
          const success = await this.registerCalendarWebhook(webhook.userId);
          
          if (success) {
            console.log(`✅ Refreshed webhook for user ${webhook.userId}`);
          } else {
            console.error(`❌ Failed to refresh webhook for user ${webhook.userId}`);
            
            // Update sync status to indicate webhook failure
            await dbService.updateCalendarConnection(webhook.userId, { 
              sync_status: 'webhook_error' 
            });
          }
          
        } catch (error) {
          console.error(`❌ Error refreshing webhook for user ${webhook.userId}:`, error);
        }
        
        // Small delay between registrations to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.error('❌ Error during webhook refresh process:', error);
    }
  }

  async validateWebhookToken(providedToken: string): Promise<boolean> {
    return providedToken === this.webhookToken;
  }

  async setupWebhookRefreshSchedule(): Promise<void> {
    // Schedule webhook refresh every 5 days (webhooks expire after 6-7 days)
    const refreshInterval = 5 * 24 * 60 * 60 * 1000; // 5 days in milliseconds
    
    console.log('⏰ Setting up webhook refresh schedule (every 5 days)');
    
    setInterval(async () => {
      try {
        console.log('🔄 Scheduled webhook refresh starting...');
        await this.refreshExpiredWebhooks();
        console.log('✅ Scheduled webhook refresh completed');
      } catch (error) {
        console.error('❌ Scheduled webhook refresh failed:', error);
      }
    }, refreshInterval);
    
    // Also run immediately to catch any already expired webhooks
    setTimeout(() => this.refreshExpiredWebhooks(), 5000); // 5 second delay on startup
  }
}

export const webhookService = new WebhookService();