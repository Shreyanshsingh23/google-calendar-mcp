import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { dbService, UserTokens } from './database.js';

class AuthService {
  private oauth2Client: OAuth2Client;

  constructor() {
    this.oauth2Client = new google.auth.OAuth2();
  }

  async getAuthenticatedClient(userId: string): Promise<OAuth2Client | null> {
    try {
      const tokens = await dbService.getUserTokens(userId);
      
      if (!tokens || !tokens.access_token) {
        console.error(`No valid tokens found for user: ${userId}`);
        return null;
      }

      // Check if token is expired
      if (tokens.token_expires_at && new Date() >= tokens.token_expires_at) {
        console.log(`Token expired for user ${userId}, attempting refresh...`);
        
        if (!tokens.refresh_token) {
          console.error(`No refresh token available for user: ${userId}`);
          return null;
        }

        // Attempt to refresh the token
        const refreshedClient = await this.refreshUserToken(userId, tokens.refresh_token);
        return refreshedClient;
      }

      const client = new google.auth.OAuth2();
      client.setCredentials({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      });

      // Set up token refresh handler
      client.on('tokens', async (newTokens) => {
        if (newTokens.access_token) {
          const expiresAt = newTokens.expiry_date ? new Date(newTokens.expiry_date) : undefined;
          await dbService.updateUserTokens(
            userId, 
            newTokens.access_token, 
            newTokens.refresh_token || tokens.refresh_token,
            expiresAt
          );
          console.log(`Tokens auto-refreshed for user: ${userId}`);
        }
      });

      return client;
    } catch (error) {
      console.error(`Authentication error for user ${userId}:`, error);
      return null;
    }
  }

  private async refreshUserToken(userId: string, refreshToken: string): Promise<OAuth2Client | null> {
    try {
      const client = new google.auth.OAuth2();
      client.setCredentials({
        refresh_token: refreshToken,
      });

      const { credentials } = await client.refreshAccessToken();
      
      if (credentials.access_token) {
        const expiresAt = credentials.expiry_date ? new Date(credentials.expiry_date) : undefined;
        await dbService.updateUserTokens(
          userId,
          credentials.access_token,
          credentials.refresh_token || refreshToken,
          expiresAt
        );

        client.setCredentials(credentials);
        return client;
      }

      return null;
    } catch (error) {
      console.error(`Token refresh failed for user ${userId}:`, error);
      
      // Update calendar connection status to error
      await dbService.updateCalendarConnection(userId, {
        sync_status: 'error',
        last_sync_at: new Date()
      });
      
      return null;
    }
  }

  async validateUserAccess(userId: string): Promise<boolean> {
    try {
      const client = await this.getAuthenticatedClient(userId);
      if (!client) return false;

      // Test the token by making a simple API call
      const calendar = google.calendar({ version: 'v3', auth: client });
      await calendar.calendarList.list({ maxResults: 1 });
      
      return true;
    } catch (error) {
      console.error(`Token validation failed for user ${userId}:`, error);
      return false;
    }
  }
}

export const authService = new AuthService();
export { AuthService };
