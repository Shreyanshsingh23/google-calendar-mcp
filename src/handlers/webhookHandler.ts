import { Request, Response } from 'express';
import { google, calendar_v3 } from 'googleapis';
import { authService } from '../services/auth.js';
import { dbService } from '../services/database.js';
import { MemoryCalendarSync } from '../services/memoryCalendarSync.js';

interface GoogleWebhookHeaders {
  resourceId: string;
  resourceUri: string;
  channelId: string;
  channelToken?: string;
  channelExpiration?: string;
}

interface CalendarChange {
  event: calendar_v3.Schema$Event;
  changeType: 'created' | 'updated' | 'deleted';
}

export class WebhookHandler {
  private memorySync: MemoryCalendarSync;
  private processingQueue: Map<string, Promise<void>> = new Map();

  constructor() {
    this.memorySync = new MemoryCalendarSync();
  }

  async handleCalendarWebhook(req: Request, res: Response): Promise<void> {
    const userId = req.params.userId;
    
    if (!userId) {
      console.error('❌ No userId provided in webhook');
      res.status(400).send('Bad Request: userId required');
      return;
    }

    try {
      // Extract Google webhook headers
      const googleHeaders = this.extractGoogleHeaders(req);
      console.log(`📥 Calendar webhook received for user ${userId}`);
      
      // Acknowledge webhook immediately to prevent timeout
      res.status(200).send('OK');
      
      // Process webhook asynchronously to avoid blocking
      this.processWebhookAsync(userId, googleHeaders);
      
    } catch (error) {
      console.error(`❌ Webhook processing error for user ${userId}:`, error);
      // Still acknowledge to Google to prevent retries
      res.status(200).send('OK');
    }
  }

  private extractGoogleHeaders(req: Request): GoogleWebhookHeaders {
    return {
      resourceId: req.headers['x-goog-resource-id'] as string,
      resourceUri: req.headers['x-goog-resource-uri'] as string,
      channelId: req.headers['x-goog-channel-id'] as string,
      channelToken: req.headers['x-goog-channel-token'] as string,
      channelExpiration: req.headers['x-goog-channel-expiration'] as string,
    };
  }

  private async processWebhookAsync(userId: string, headers: GoogleWebhookHeaders): Promise<void> {
    const processingKey = `${userId}_${headers.channelId}`;
    
    // Prevent duplicate processing of the same webhook
    if (this.processingQueue.has(processingKey)) {
      console.log(`⏭️ Webhook already being processed for ${processingKey}`);
      return;
    }

    const processingPromise = this.doProcessWebhook(userId, headers);
    this.processingQueue.set(processingKey, processingPromise);
    
    try {
      await processingPromise;
    } finally {
      this.processingQueue.delete(processingKey);
    }
  }

  private async doProcessWebhook(userId: string, headers: GoogleWebhookHeaders): Promise<void> {
    try {
      console.log(`🔄 Processing webhook for user ${userId}, channel: ${headers.channelId}`);
      
      // Fetch calendar changes with retry logic
      const changes = await this.fetchIncrementalChanges(userId, headers);
      
      if (changes.length === 0) {
        console.log(`ℹ️ No changes found for user ${userId}`);
        return;
      }

      console.log(`📊 Found ${changes.length} calendar changes for user ${userId}`);
      
      // Process each change and sync to memory vault
      let successCount = 0;
      for (const change of changes) {
        const success = await this.memorySync.processCalendarChange(
          userId, 
          change.event, 
          change.changeType
        );
        
        if (success) {
          successCount++;
        } else {
          console.error(`❌ Failed to sync event ${change.event.id} for user ${userId}`);
          // TODO: Add to retry queue
        }
      }
      
      // Update last sync timestamp
      await dbService.updateCalendarConnection(userId, {
        last_sync_at: new Date(),
        sync_status: successCount === changes.length ? 'synced' : 'partial_sync'
      });
      
      console.log(`✅ Synced ${successCount}/${changes.length} calendar changes to memory vault for user ${userId}`);
      
    } catch (error) {
      console.error(`❌ Webhook processing failed for user ${userId}:`, error);
      
      // Update sync status to error
      await dbService.updateCalendarConnection(userId, {
        last_sync_at: new Date(),
        sync_status: 'error'
      });
      
      // Schedule full sync as fallback
      await this.scheduleFullSync(userId);
    }
  }

  private async fetchIncrementalChanges(userId: string, headers: GoogleWebhookHeaders): Promise<CalendarChange[]> {
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        const authClient = await authService.getAuthenticatedClient(userId);
        if (!authClient) {
          throw new Error(`Failed to get authenticated client for user ${userId}`);
        }

        const calendar = google.calendar({ version: 'v3', auth: authClient });
        
        // Get sync token from database
        const calendarId = this.extractCalendarIdFromResourceUri(headers.resourceUri);
        const lastSyncToken = await dbService.getSyncToken(userId, calendarId);
        
        const listParams: calendar_v3.Params$Resource$Events$List = {
          calendarId,
          showDeleted: true,
          singleEvents: true,
          maxResults: 250,
        };

        // Use sync token for incremental sync, or timeMin for initial sync
        if (lastSyncToken) {
          listParams.syncToken = lastSyncToken;
        } else {
          // For initial sync, get events from last 30 days
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          listParams.timeMin = thirtyDaysAgo.toISOString();
        }

        console.log(`🔍 Fetching changes for calendar ${calendarId}, sync token: ${lastSyncToken ? 'present' : 'none'}`);
        
        const response = await calendar.events.list(listParams);
        
        // Update sync token for next time
        if (response.data.nextSyncToken) {
          await dbService.updateSyncToken(userId, calendarId, response.data.nextSyncToken);
        }
        
        // Convert events to change objects
        const changes: CalendarChange[] = (response.data.items || []).map(event => ({
          event,
          changeType: this.determineChangeType(event)
        }));
        
        return changes;
        
      } catch (error: any) {
        attempt++;
        
        // Handle specific Google API errors
        if (error.code === 410 || (error.message && error.message.includes('Sync token is no longer valid'))) {
          console.log(`🔄 Sync token expired for user ${userId}, performing full sync`);
          
          // Clear invalid sync token and retry without it
          await dbService.updateSyncToken(userId, this.extractCalendarIdFromResourceUri(headers.resourceUri), null);
          
          if (attempt < maxRetries) {
            continue; // Retry without sync token
          }
        }
        
        if (attempt >= maxRetries) {
          throw error;
        }
        
        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⏳ Retry ${attempt}/${maxRetries} after ${delay}ms for user ${userId}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return [];
  }

  private determineChangeType(event: calendar_v3.Schema$Event): 'created' | 'updated' | 'deleted' {
    if (event.status === 'cancelled') {
      return 'deleted';
    }
    
    if (event.created === event.updated) {
      return 'created';
    }
    
    return 'updated';
  }

  private extractCalendarIdFromResourceUri(resourceUri: string): string {
    // Resource URI format: https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events
    const match = resourceUri.match(/calendars\/([^\/]+)\/events/);
    return match ? decodeURIComponent(match[1]) : 'primary';
  }

  private async scheduleFullSync(userId: string): Promise<void> {
    try {
      console.log(`📋 Scheduling full sync for user ${userId}`);
      
      // Update sync status
      await dbService.updateCalendarConnection(userId, {
        sync_status: 'scheduled_full_sync',
        last_sync_at: new Date()
      });
      
      // TODO: Add to background job queue for full sync
      // For now, we'll just log it
      console.log(`✅ Full sync scheduled for user ${userId}`);
      
    } catch (error) {
      console.error(`❌ Failed to schedule full sync for user ${userId}:`, error);
    }
  }

  async performFullSync(userId: string): Promise<boolean> {
    try {
      console.log(`🔄 Starting full sync for user ${userId}`);
      
      const authClient = await authService.getAuthenticatedClient(userId);
      if (!authClient) {
        throw new Error(`Failed to get authenticated client for user ${userId}`);
      }

      const calendar = google.calendar({ version: 'v3', auth: authClient });
      
      // Get all calendars for the user
      const calendarList = await calendar.calendarList.list();
      
      if (!calendarList.data.items) {
        console.log(`ℹ️ No calendars found for user ${userId}`);
        return true;
      }

      let totalSynced = 0;
      
      for (const calendarItem of calendarList.data.items) {
        const calendarId = calendarItem.id!;
        console.log(`📅 Syncing calendar ${calendarId} for user ${userId}`);
        
        try {
          // Get events from last 30 days and next 365 days
          const pastDate = new Date();
          pastDate.setDate(pastDate.getDate() - 30);
          
          const futureDate = new Date();
          futureDate.setDate(futureDate.getDate() + 365);
          
          let pageToken: string | undefined;
          
          do {
            const response = await calendar.events.list({
              calendarId,
              timeMin: pastDate.toISOString(),
              timeMax: futureDate.toISOString(),
              maxResults: 250,
              singleEvents: true,
              orderBy: 'startTime',
              pageToken
            });
            
            const events = response.data.items || [];
            
            for (const event of events) {
              const success = await this.memorySync.processCalendarChange(
                userId, 
                event, 
                'created' // Treat all as new during full sync
              );
              
              if (success) {
                totalSynced++;
              }
            }
            
            pageToken = response.data.nextPageToken || undefined;
            
          } while (pageToken);
          
          // Update sync token for this calendar
          const syncResponse = await calendar.events.list({
            calendarId,
            maxResults: 1
          });
          
          if (syncResponse.data.nextSyncToken) {
            await dbService.updateSyncToken(userId, calendarId, syncResponse.data.nextSyncToken);
          }
          
        } catch (error) {
          console.error(`❌ Failed to sync calendar ${calendarId} for user ${userId}:`, error);
        }
      }
      
      // Update sync status
      await dbService.updateCalendarConnection(userId, {
        sync_status: 'synced',
        last_sync_at: new Date()
      });
      
      console.log(`✅ Full sync completed for user ${userId}, synced ${totalSynced} events`);
      return true;
      
    } catch (error) {
      console.error(`❌ Full sync failed for user ${userId}:`, error);
      
      await dbService.updateCalendarConnection(userId, {
        sync_status: 'error',
        last_sync_at: new Date()
      });
      
      return false;
    }
  }
}

export const webhookHandler = new WebhookHandler();