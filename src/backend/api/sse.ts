/**
 * SSE Manager - Server-Sent Events for real-time event streaming
 *
 * Features:
 * - Real-time event push to clients
 * - Support for reconnection (Last-Event-ID)
 * - Heartbeat mechanism (ping every 30 seconds)
 * - Multiple clients per run support
 * - Proper resource cleanup on disconnect
 */

import type { Response } from 'express';
import type { Event } from '@openintern/types/events.js';
import type { SSEMessage } from '@openintern/types/api.js';
import { logger } from '@openintern/utils';

/**
 * SSE client connection
 */
interface SSEClient {
  id: string;
  runId: string;
  response: Response;
  lastEventId: string | null;
  connectedAt: Date;
}

/**
 * SSE Manager configuration
 */
export interface SSEManagerConfig {
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
  /** Maximum clients per run (0 = unlimited) */
  maxClientsPerRun: number;
}

const DEFAULT_CONFIG: SSEManagerConfig = {
  heartbeatIntervalMs: 30000, // 30 seconds
  maxClientsPerRun: 100,
};

/**
 * SSE Manager class for managing event streams
 */
export class SSEManager {
  private clients: Map<string, SSEClient> = new Map();
  private runClients: Map<string, Set<string>> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private config: SSEManagerConfig;
  private eventCounter = 0;

  constructor(config: Partial<SSEManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the heartbeat timer
   */
  startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    logger.info('SSE heartbeat started', {
      intervalMs: this.config.heartbeatIntervalMs,
    });
  }

  /**
   * Stop the heartbeat timer
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('SSE heartbeat stopped');
    }
  }

  /**
   * Generate a unique client ID
   */
  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Add a new SSE client connection
   */
  addClient(runId: string, response: Response, lastEventId?: string): string {
    // Check client limit per run
    const runClientSet = this.runClients.get(runId);
    if (
      this.config.maxClientsPerRun > 0 &&
      runClientSet &&
      runClientSet.size >= this.config.maxClientsPerRun
    ) {
      throw new Error(
        `Maximum clients reached for run ${runId} (max: ${this.config.maxClientsPerRun})`
      );
    }

    const clientId = this.generateClientId();

    // Set SSE headers
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    response.flushHeaders();

    // Create client record
    const client: SSEClient = {
      id: clientId,
      runId,
      response,
      lastEventId: lastEventId ?? null,
      connectedAt: new Date(),
    };

    this.clients.set(clientId, client);

    // Track client by run
    if (!this.runClients.has(runId)) {
      this.runClients.set(runId, new Set());
    }
    this.runClients.get(runId)?.add(clientId);

    // Send connected event
    this.sendToClient(client, {
      event: 'connected',
      data: { clientId, runId, ts: new Date().toISOString() },
    });

    logger.info('SSE client connected', {
      clientId,
      runId,
      totalClients: this.clients.size,
    });

    return clientId;
  }

  /**
   * Remove a client connection
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    // Remove from run tracking
    const runClientSet = this.runClients.get(client.runId);
    if (runClientSet) {
      runClientSet.delete(clientId);
      if (runClientSet.size === 0) {
        this.runClients.delete(client.runId);
      }
    }

    // Remove client
    this.clients.delete(clientId);

    logger.info('SSE client disconnected', {
      clientId,
      runId: client.runId,
      totalClients: this.clients.size,
    });
  }

  /**
   * Send a message to a specific client
   */
  private sendToClient(client: SSEClient, message: SSEMessage): boolean {
    try {
      const eventId = message.id ?? `evt_${++this.eventCounter}`;
      let sseData = '';

      if (message.id) {
        sseData += `id: ${message.id}\n`;
      }
      sseData += `event: ${message.event}\n`;
      sseData += `data: ${JSON.stringify(message.data)}\n\n`;

      client.response.write(sseData);
      client.lastEventId = eventId;
      return true;
    } catch (error) {
      logger.warn('Failed to send SSE message', {
        clientId: client.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Broadcast an event to all clients subscribed to a run
   */
  broadcastToRun(runId: string, event: Event): void {
    const clientIds = this.runClients.get(runId);
    if (!clientIds || clientIds.size === 0) {
      return;
    }

    const message: SSEMessage = {
      event: 'run.event',
      data: event,
      id: event.span_id,
    };

    const failedClients: string[] = [];

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client) {
        const success = this.sendToClient(client, message);
        if (!success) {
          failedClients.push(clientId);
        }
      }
    }

    // Clean up failed clients
    for (const clientId of failedClients) {
      this.removeClient(clientId);
    }

    logger.debug('SSE broadcast sent', {
      runId,
      eventType: event.type,
      clientCount: clientIds.size - failedClients.length,
    });
  }

  /**
   * Send heartbeat to all clients
   */
  private sendHeartbeat(): void {
    const message: SSEMessage = {
      event: 'ping',
      data: { ts: new Date().toISOString() },
    };

    const failedClients: string[] = [];

    for (const [clientId, client] of this.clients) {
      const success = this.sendToClient(client, message);
      if (!success) {
        failedClients.push(clientId);
      }
    }

    // Clean up failed clients
    for (const clientId of failedClients) {
      this.removeClient(clientId);
    }

    if (this.clients.size > 0) {
      logger.debug('SSE heartbeat sent', {
        clientCount: this.clients.size - failedClients.length,
      });
    }
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of clients for a specific run
   */
  getRunClientCount(runId: string): number {
    return this.runClients.get(runId)?.size ?? 0;
  }

  /**
   * Check if a run has any connected clients
   */
  hasClients(runId: string): boolean {
    return (this.runClients.get(runId)?.size ?? 0) > 0;
  }

  /**
   * Close all connections and cleanup
   */
  shutdown(): void {
    this.stopHeartbeat();

    for (const [clientId, client] of this.clients) {
      try {
        client.response.end();
      } catch {
        // Ignore errors during shutdown
      }
      this.clients.delete(clientId);
    }

    this.runClients.clear();
    logger.info('SSE manager shutdown complete');
  }
}

