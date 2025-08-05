import { calendar_v3 } from 'googleapis';
import { dbService } from './database.js';

export interface MemoryEntry {
  content: string;
  title: string;
  memory_type: string;
  source: string;
  tags: string[];
  metadata: {
    event_id: string;
    calendar_id: string;
    start_time: string;
    end_time?: string;
    location?: string;
    attendees: string[];
    change_type: string;
    last_modified?: string;
    recurrence?: string[];
    color_id?: string;
    creator?: string;
    status?: string;
  };
  is_private: boolean;
}

export class MemoryCalendarSync {
  private memoryVaultUrl: string;

  constructor(memoryVaultUrl: string = 'http://localhost:8000') {
    this.memoryVaultUrl = memoryVaultUrl.replace(/\/$/, '');
  }

  async processCalendarChange(
    userId: string, 
    calendarEvent: calendar_v3.Schema$Event, 
    changeType: 'created' | 'updated' | 'deleted'
  ): Promise<boolean> {
    try {
      console.log(`Processing calendar ${changeType} for user ${userId}, event: ${calendarEvent.id}`);

      if (changeType === 'deleted') {
        return await this.removeFromMemoryVault(userId, calendarEvent.id!);
      }

      // Convert calendar event to memory format
      const memoryEntry = this.convertEventToMemory(calendarEvent, changeType);
      
      // Store/update in memory vault
      if (changeType === 'updated') {
        return await this.updateInMemoryVault(userId, memoryEntry);
      } else {
        return await this.storeInMemoryVault(userId, memoryEntry);
      }

    } catch (error) {
      console.error(`Failed to process calendar change for user ${userId}:`, error);
      return false;
    }
  }

  private convertEventToMemory(event: calendar_v3.Schema$Event, changeType: string): MemoryEntry {
    const startTime = event.start?.dateTime || event.start?.date || '';
    const endTime = event.end?.dateTime || event.end?.date || '';
    const eventDate = new Date(startTime);
    
    return {
      content: this.generateMemoryContent(event),
      title: `Calendar Event: ${event.summary || 'Untitled Event'}`,
      memory_type: 'CALENDAR_EVENT',
      source: 'GOOGLE_CALENDAR',
      tags: this.generateEventTags(event, eventDate),
      metadata: {
        event_id: event.id!,
        calendar_id: event.organizer?.email || 'primary',
        start_time: startTime,
        end_time: endTime,
        location: event.location || '',
        attendees: event.attendees?.map(a => a.email!).filter(Boolean) || [],
        change_type: changeType,
        last_modified: event.updated || '',
        recurrence: event.recurrence || [],
        color_id: event.colorId || '',
        creator: event.creator?.email,
        status: event.status || ''
      },
      is_private: true
    };
  }

  private generateMemoryContent(event: calendar_v3.Schema$Event): string {
    const startTime = new Date(event.start?.dateTime || event.start?.date || '');
    const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : null;
    
    let content = `📅 Calendar Event: ${event.summary || 'Untitled Event'}\n\n`;
    
    // Time information
    content += `🕐 Start: ${startTime.toLocaleString()}\n`;
    if (endTime) {
      content += `🕐 End: ${endTime.toLocaleString()}\n`;
    }
    
    // Duration calculation
    if (endTime) {
      const duration = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60));
      if (duration > 0) {
        const hours = Math.floor(duration / 60);
        const minutes = duration % 60;
        content += `⏱️ Duration: ${hours > 0 ? `${hours}h ` : ''}${minutes > 0 ? `${minutes}m` : ''}\n`;
      }
    }
    
    // Location
    if (event.location) {
      content += `📍 Location: ${event.location}\n`;
    }
    
    // Description
    if (event.description) {
      content += `📝 Description: ${event.description}\n`;
    }
    
    // Attendees
    if (event.attendees && event.attendees.length > 0) {
      const attendeeEmails = event.attendees
        .map(a => a.email)
        .filter(Boolean)
        .join(', ');
      content += `👥 Attendees: ${attendeeEmails}\n`;
    }
    
    // Recurrence
    if (event.recurrence && event.recurrence.length > 0) {
      content += `🔄 Recurring: ${event.recurrence.join(', ')}\n`;
    }
    
    // Meeting link (common in descriptions)
    if (event.description && (event.description.includes('meet.google.com') || event.description.includes('zoom.us'))) {
      content += `🔗 Online meeting details in description\n`;
    }
    
    // Status
    if (event.status && event.status !== 'confirmed') {
      content += `📊 Status: ${event.status}\n`;
    }
    
    return content.trim();
  }

  private generateEventTags(event: calendar_v3.Schema$Event, eventDate: Date): string[] {
    const tags = ['calendar', 'event', 'schedule'];
    
    // Time-based tags
    const year = eventDate.getFullYear();
    const month = eventDate.getMonth() + 1;
    const day = eventDate.getDate();
    const hour = eventDate.getHours();
    
    tags.push(
      `year_${year}`,
      `month_${month}`,
      `day_${day}`,
      `hour_${hour}`
    );
    
    // Day of week
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    tags.push(dayNames[eventDate.getDay()]);
    
    // Time of day
    if (hour < 6) tags.push('early_morning');
    else if (hour < 12) tags.push('morning');
    else if (hour < 17) tags.push('afternoon');
    else if (hour < 21) tags.push('evening');
    else tags.push('night');
    
    // Event type analysis
    const summary = (event.summary || '').toLowerCase();
    const description = (event.description || '').toLowerCase();
    const combined = `${summary} ${description}`;
    
    // Meeting types
    if (event.attendees && event.attendees.length > 1) tags.push('meeting');
    if (event.attendees && event.attendees.length === 1) tags.push('one_on_one');
    if (!event.attendees || event.attendees.length === 0) tags.push('personal');
    
    // Location types
    if (event.location) {
      tags.push('in_person');
      if (event.location.toLowerCase().includes('home')) tags.push('home');
      if (event.location.toLowerCase().includes('office')) tags.push('office');
    }
    
    // Online meeting detection
    if (combined.includes('zoom') || combined.includes('meet') || combined.includes('teams')) {
      tags.push('online_meeting');
    }
    
    // Recurrence
    if (event.recurrence && event.recurrence.length > 0) {
      tags.push('recurring');
      if (event.recurrence.some(r => r.includes('DAILY'))) tags.push('daily');
      if (event.recurrence.some(r => r.includes('WEEKLY'))) tags.push('weekly');
      if (event.recurrence.some(r => r.includes('MONTHLY'))) tags.push('monthly');
    }
    
    // Content-based tags
    const workKeywords = ['meeting', 'standup', 'review', 'project', 'client', 'work', 'office'];
    const personalKeywords = ['doctor', 'dentist', 'gym', 'workout', 'personal', 'family', 'birthday'];
    const eventKeywords = ['party', 'dinner', 'lunch', 'coffee', 'social', 'event'];
    
    if (workKeywords.some(k => combined.includes(k))) tags.push('work');
    if (personalKeywords.some(k => combined.includes(k))) tags.push('personal');
    if (eventKeywords.some(k => combined.includes(k))) tags.push('social');
    
    // Reminder-like events
    if (summary.toLowerCase().includes('reminder') || summary.toLowerCase().includes('todo')) {
      tags.push('reminder', 'task');
    }
    
    // All-day events
    if (event.start?.date && !event.start?.dateTime) {
      tags.push('all_day');
    }
    
    return [...new Set(tags)]; // Remove duplicates
  }

  private async storeInMemoryVault(userId: string, memoryEntry: MemoryEntry): Promise<boolean> {
    try {
      const response = await fetch(`${this.memoryVaultUrl}/memories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: memoryEntry.content,
          title: memoryEntry.title,
          memory_type: memoryEntry.memory_type,
          source: memoryEntry.source,
          tags: memoryEntry.tags,
          metadata: memoryEntry.metadata,
          is_private: memoryEntry.is_private,
          user_id: userId
        }),
      });

      if (response.ok) {
        console.log(`✅ Calendar memory stored for user ${userId}, event: ${memoryEntry.metadata.event_id}`);
        return true;
      } else {
        console.error(`❌ Failed to store calendar memory: ${response.status} ${response.statusText}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error storing calendar memory:`, error);
      return false;
    }
  }

  private async updateInMemoryVault(userId: string, memoryEntry: MemoryEntry): Promise<boolean> {
    try {
      // First, find existing memory by event_id
      const searchResponse = await fetch(
        `${this.memoryVaultUrl}/memories/search?user_id=${userId}&query=event_id:${memoryEntry.metadata.event_id}&limit=1`,
        {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (searchResponse.ok) {
        const searchResult = await searchResponse.json();
        
        if (searchResult.memories && searchResult.memories.length > 0) {
          const existingMemory = searchResult.memories[0];
          
          // Update existing memory
          const updateResponse = await fetch(`${this.memoryVaultUrl}/memories/${existingMemory.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: memoryEntry.content,
              title: memoryEntry.title,
              tags: memoryEntry.tags,
              metadata: memoryEntry.metadata,
              user_id: userId
            }),
          });

          if (updateResponse.ok) {
            console.log(`✅ Calendar memory updated for user ${userId}, event: ${memoryEntry.metadata.event_id}`);
            return true;
          }
        }
      }
      
      // If not found or update failed, create new
      return await this.storeInMemoryVault(userId, memoryEntry);
      
    } catch (error) {
      console.error(`❌ Error updating calendar memory:`, error);
      return false;
    }
  }

  private async removeFromMemoryVault(userId: string, eventId: string): Promise<boolean> {
    try {
      // Find existing memory by event_id
      const searchResponse = await fetch(
        `${this.memoryVaultUrl}/memories/search?user_id=${userId}&query=event_id:${eventId}&limit=1`,
        {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (searchResponse.ok) {
        const searchResult = await searchResponse.json();
        
        if (searchResult.memories && searchResult.memories.length > 0) {
          const existingMemory = searchResult.memories[0];
          
          const deleteResponse = await fetch(`${this.memoryVaultUrl}/memories/${existingMemory.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
          });

          if (deleteResponse.ok) {
            console.log(`✅ Calendar memory deleted for user ${userId}, event: ${eventId}`);
            return true;
          }
        } else {
          console.log(`ℹ️ No memory found to delete for event: ${eventId}`);
          return true; // Already doesn't exist
        }
      }
      
      return false;
      
    } catch (error) {
      console.error(`❌ Error removing calendar memory:`, error);
      return false;
    }
  }
}