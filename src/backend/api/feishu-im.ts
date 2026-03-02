import { Router, type Request, type Response } from 'express';
import { AgentError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

interface FeishuImWebhookResult {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface FeishuImWebhookHandler {
  handleWebhook(payload: unknown): Promise<FeishuImWebhookResult>;
}

export interface FeishuImRouterConfig {
  webhookHandler: FeishuImWebhookHandler;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof AgentError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error('Feishu IM webhook error', {
    error: message,
  });
  res.status(500).json({ code: 500, msg: message });
}

export function createFeishuImRouter(config: FeishuImRouterConfig): Router {
  const router = Router();
  const { webhookHandler } = config;

  // POST /api/feishu/im/webhook
  router.post('/feishu/im/webhook', (req: Request, res: Response) => {
    void (async () => {
      try {
        const result = await webhookHandler.handleWebhook(req.body);
        res.status(result.statusCode).json(result.body);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  return router;
}
