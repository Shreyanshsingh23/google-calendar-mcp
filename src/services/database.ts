import { Pool, PoolClient } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

interface UserTokens {
  access_token: string;
  refresh_token: string;
  token_expires_at: Date | null;
  email: string;
}

interface CalendarConnection {
  id: string;
  user_id: string;
  calendar_connected: boolean;
  primary_calendar_id: string | null;
  sync_enabled: boolean;
  last_sync_at: Date | null;
  sync_status: string;
  webhook_id: string | null;
  webhook_resource_id: string | null;
  webhook_expiration: Date | null;
}

class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
    });
  }

  async getUserTokens(userId: string): Promise<UserTokens | null> {
    try {
      const result = await this.pool.query(
        'SELECT access_token, refresh_token, token_expires_at, email FROM users WHERE user_id = $1 AND access_token IS NOT NULL',
        [userId]
      );
      
      if (result.rows.length === 0) {
        console.error(`No user found or no tokens available for: ${userId}`);
        return null;
      }
      
      return result.rows[0];
    } catch (error) {
      console.error('Database error getting user tokens:', error);
      throw error;
    }
  }

  async updateUserTokens(userId: string, accessToken: string, refreshToken: string, expiresAt?: Date): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE users SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = NOW() WHERE user_id = $4',
        [accessToken, refreshToken, expiresAt, userId]
      );
      console.log(`Tokens updated for user: ${userId}`);
    } catch (error) {
      console.error('Error updating tokens:', error);
      throw error;
    }
  }

  async getCalendarConnection(userId: string): Promise<CalendarConnection | null> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM user_calendar_connections WHERE user_id = $1',
        [userId]
      );
      
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error getting calendar connection:', error);
      throw error;
    }
  }

  async createCalendarConnection(userId: string, connectionId: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO user_calendar_connections 
         (id, user_id, calendar_connected, sync_status, connected_at) 
         VALUES ($1, $2, TRUE, 'active', NOW())`,
        [connectionId, userId]
      );
      console.log(`Calendar connection created for user: ${userId}`);
    } catch (error) {
      console.error('Error creating calendar connection:', error);
      throw error;
    }
  }

  async updateCalendarConnection(userId: string, updates: Partial<CalendarConnection>): Promise<void> {
    try {
      const setClause = Object.keys(updates)
        .map((key, index) => `${key} = $${index + 2}`)
        .join(', ');
      
      const values = [userId, ...Object.values(updates)];
      
      await this.pool.query(
        `UPDATE user_calendar_connections SET ${setClause}, updated_at = NOW() WHERE user_id = $1`,
        values
      );
    } catch (error) {
      console.error('Error updating calendar connection:', error);
      throw error;
    }
  }

  async isUserCalendarConnected(userId: string): Promise<boolean> {
    try {
      const connection = await this.getCalendarConnection(userId);
      return !!(connection && connection.calendar_connected === true && connection.sync_status === 'active');
    } catch (error) {
      console.error('Error checking calendar connection:', error);
      return false;
    }
  }

  async getSyncToken(userId: string, calendarId: string): Promise<string | null> {
    try {
      const result = await this.pool.query(
        'SELECT sync_token FROM calendar_sync_tokens WHERE user_id = $1 AND calendar_id = $2',
        [userId, calendarId]
      );
      
      return result.rows.length > 0 ? result.rows[0].sync_token : null;
    } catch (error) {
      console.error('Error getting sync token:', error);
      return null;
    }
  }

  async updateSyncToken(userId: string, calendarId: string, syncToken: string | null): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `INSERT INTO calendar_sync_tokens (id, user_id, calendar_id, sync_token, updated_at) 
         VALUES (gen_random_uuid(), $1, $2, $3, NOW()) 
         ON CONFLICT (user_id, calendar_id) 
         DO UPDATE SET sync_token = $3, updated_at = NOW()`,
        [userId, calendarId, syncToken]
      );
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('Error updating sync token:', error);
      return false;
    }
  }

  async registerWebhook(
    userId: string, 
    webhookId: string, 
    resourceId: string, 
    expiration: Date
  ): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `UPDATE user_calendar_connections 
         SET webhook_id = $2, webhook_resource_id = $3, webhook_expiration = $4, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, webhookId, resourceId, expiration]
      );
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('Error registering webhook:', error);
      return false;
    }
  }

  async unregisterWebhook(userId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `UPDATE user_calendar_connections 
         SET webhook_id = NULL, webhook_resource_id = NULL, webhook_expiration = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('Error unregistering webhook:', error);
      return false;
    }
  }

  async getWebhookInfo(userId: string): Promise<{
    webhookId: string | null;
    resourceId: string | null;
    expiration: Date | null;
  } | null> {
    try {
      const result = await this.pool.query(
        'SELECT webhook_id, webhook_resource_id, webhook_expiration FROM user_calendar_connections WHERE user_id = $1',
        [userId]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        webhookId: row.webhook_id,
        resourceId: row.webhook_resource_id,
        expiration: row.webhook_expiration ? new Date(row.webhook_expiration) : null
      };
    } catch (error) {
      console.error('Error getting webhook info:', error);
      return null;
    }
  }

  async getExpiredWebhooks(): Promise<Array<{
    userId: string;
    webhookId: string;
    resourceId: string;
  }>> {
    try {
      const result = await this.pool.query(
        `SELECT user_id, webhook_id, webhook_resource_id 
         FROM user_calendar_connections 
         WHERE webhook_expiration IS NOT NULL 
         AND webhook_expiration < NOW() 
         AND webhook_id IS NOT NULL`
      );
      
      return result.rows.map(row => ({
        userId: row.user_id,
        webhookId: row.webhook_id,
        resourceId: row.webhook_resource_id
      }));
    } catch (error) {
      console.error('Error getting expired webhooks:', error);
      return [];
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const dbService = new DatabaseService();
export { UserTokens, CalendarConnection, DatabaseService };
