import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import { webhookHandler } from '../handlers/webhookHandler.js';
import { webhookService } from '../services/webhookService.js';

export interface HttpTransportConfig {
  port?: number;
  host?: string;
}

export class HttpTransportHandler {
  private server: McpServer;
  private config: HttpTransportConfig;

  constructor(server: McpServer, config: HttpTransportConfig = {}) {
    this.server = server;
    this.config = config;
  }

  async connect(): Promise<void> {
    const port = this.config.port || 3000;
    const host = this.config.host || '127.0.0.1';
    
    // Configure transport for stateless mode to allow multiple initialization cycles
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // Stateless mode - allows multiple initializations
    });

    await this.server.connect(transport);
    
    // Create HTTP server to handle the StreamableHTTP transport
    const httpServer = http.createServer(async (req, res) => {
      // Validate Origin header to prevent DNS rebinding attacks (MCP spec requirement)
      const origin = req.headers.origin;
      const allowedOrigins = [
        'http://localhost',
        'http://127.0.0.1',
        'https://localhost', 
        'https://127.0.0.1'
      ];
      
      // For requests with Origin header, validate it
      if (origin && !allowedOrigins.some(allowed => origin.startsWith(allowed))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Forbidden: Invalid origin',
          message: 'Origin header validation failed'
        }));
        return;
      }

      // Basic request size limiting (prevent DoS)
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      const maxRequestSize = 10 * 1024 * 1024; // 10MB limit
      if (contentLength > maxRequestSize) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Payload Too Large',
          message: 'Request size exceeds maximum allowed size'
        }));
        return;
      }

      // Handle CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Validate Accept header for MCP requests (spec requirement)
      if (req.method === 'POST' || req.method === 'GET') {
        const acceptHeader = req.headers.accept;
        if (acceptHeader && !acceptHeader.includes('application/json') && !acceptHeader.includes('text/event-stream') && !acceptHeader.includes('*/*')) {
          res.writeHead(406, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Not Acceptable',
            message: 'Accept header must include application/json or text/event-stream'
          }));
          return;
        }
      }

      // Handle health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          server: 'google-calendar-mcp',
          version: '1.3.0',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // Handle webhook endpoints
      if (req.url?.startsWith('/webhook/')) {
        await this.handleWebhookRequest(req, res);
        return;
      }

      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        process.stderr.write(`Error handling request: ${error instanceof Error ? error.message : error}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          }));
        }
      }
    });

    httpServer.listen(port, host, () => {
      process.stderr.write(`Google Calendar MCP Server listening on http://${host}:${port}\n`);
      
      // Start webhook refresh schedule
      webhookService.setupWebhookRefreshSchedule();
    });
  }

  private async handleWebhookRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const pathParts = url.pathname.split('/').filter(Boolean); // ['webhook', ...]
      
      if (pathParts.length < 2) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      const action = pathParts[1]; // 'register', 'unregister', 'calendar', 'full-sync'
      
      switch (action) {
        case 'register':
          await this.handleWebhookRegister(req, res);
          break;
          
        case 'unregister':
          await this.handleWebhookUnregister(req, res);
          break;
          
        case 'calendar':
          if (pathParts.length >= 3) {
            const userId = pathParts[2];
            // Simulate Express-like request object
            const mockReq = { 
              ...req, 
              params: { userId },
              headers: req.headers 
            };
            const mockRes = {
              status: (code: number) => ({
                send: (data: any) => {
                  res.writeHead(code, { 'Content-Type': 'application/json' });
                  res.end(typeof data === 'string' ? data : JSON.stringify(data));
                }
              })
            };
            await webhookHandler.handleCalendarWebhook(mockReq as any, mockRes as any);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User ID required' }));
          }
          break;
          
        case 'full-sync':
          if (pathParts.length >= 3) {
            const userId = pathParts[2];
            await this.handleFullSync(userId, res);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User ID required' }));
          }
          break;
          
        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Webhook endpoint not found' }));
      }
      
    } catch (error) {
      console.error('Webhook handling error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private async handleWebhookRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.parseRequestBody(req);
      const { user_id } = body;
      
      if (!user_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'user_id is required' }));
        return;
      }
      
      const success = await webhookService.registerCalendarWebhook(user_id);
      
      if (success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'success', 
          message: 'Webhook registered successfully',
          user_id 
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Failed to register webhook',
          user_id 
        }));
      }
      
    } catch (error) {
      console.error('Webhook registration error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private async handleWebhookUnregister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.parseRequestBody(req);
      const { user_id } = body;
      
      if (!user_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'user_id is required' }));
        return;
      }
      
      const success = await webhookService.unregisterCalendarWebhook(user_id);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'success', 
        message: success ? 'Webhook unregistered successfully' : 'No webhook found to unregister',
        user_id 
      }));
      
    } catch (error) {
      console.error('Webhook unregistration error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private async handleFullSync(userId: string, res: http.ServerResponse): Promise<void> {
    try {
      const success = await webhookHandler.performFullSync(userId);
      
      if (success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'success', 
          message: 'Full sync completed successfully',
          user_id: userId 
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Full sync failed',
          user_id: userId 
        }));
      }
      
    } catch (error) {
      console.error('Full sync error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private parseRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }
} 