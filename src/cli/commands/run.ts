/**
 * CLI Command: agent run
 *
 * Create and execute a new run
 */

import type { CreateRunResponse } from '@openintern/types/api.js';
import { loadConfig } from '../../config/loader.js';
import * as output from '../utils/output.js';

export interface RunOptions {
  session: string;
  wait: boolean;
  stream: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
}

interface ScopePayload {
  org_id: string;
  user_id: string;
  project_id?: string;
}

function resolveScope(): ScopePayload {
  const orgId = process.env['AGENT_ORG_ID'] ?? 'org_default';
  const userId = process.env['AGENT_USER_ID'] ?? 'user_default';
  const projectId = process.env['AGENT_PROJECT_ID'];
  return {
    org_id: orgId,
    user_id: userId,
    ...(projectId ? { project_id: projectId } : {}),
  };
}

function scopeHeaders(scope: ScopePayload): Record<string, string> {
  return {
    'x-org-id': scope.org_id,
    'x-user-id': scope.user_id,
    ...(scope.project_id ? { 'x-project-id': scope.project_id } : {}),
  };
}

/**
 * Execute the run command
 */
export async function runCommand(
  text: string,
  options: RunOptions
): Promise<void> {
  const baseUrl = process.env['AGENT_API_URL'] ?? 'http://localhost:3000';
  const sessionKey = options.session.startsWith('s_')
    ? options.session
    : `s_${options.session}`;
  const scope = resolveScope();

  try {
    // Load config file + env vars
    const agentConfig = await loadConfig();

    // Build request body
    const requestBody: Record<string, unknown> = {
      ...scope,
      session_key: sessionKey,
      input: text,
    };

    // LLM config: CLI options override config file
    if (options.provider) {
      requestBody.llm_config = {
        provider: options.provider,
        model: options.model,
        ...(options.baseUrl ? { base_url: options.baseUrl } : {}),
      };
    } else if (agentConfig.llm?.provider) {
      const llmReq: Record<string, unknown> = {
        provider: agentConfig.llm.provider,
      };
      if (agentConfig.llm.model) llmReq.model = agentConfig.llm.model;
      if (agentConfig.llm.baseUrl) llmReq.base_url = agentConfig.llm.baseUrl;
      if (agentConfig.llm.temperature !== undefined) llmReq.temperature = agentConfig.llm.temperature;
      if (agentConfig.llm.maxTokens !== undefined) llmReq.max_tokens = agentConfig.llm.maxTokens;
      requestBody.llm_config = llmReq;
    }

    // Create run via API
    output.progress('Creating run');
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...scopeHeaders(scope),
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      output.progressFailed();
      const errorData = (await response.json()) as {
        error?: { message?: string };
      };
      throw new Error(
        errorData.error?.message ?? `HTTP ${response.status}`
      );
    }

    output.progressDone();
    const data = (await response.json()) as CreateRunResponse;

    output.print('');
    output.keyValue('Run ID', data.run_id);
    output.keyValue('Session', sessionKey);
    output.keyValue('Scope', `${scope.org_id}/${scope.user_id}${scope.project_id ? `/${scope.project_id}` : ''}`);
    output.keyValue('Status', data.status);
    output.print('');

    // Stream mode
    if (options.stream) {
      await streamEvents(baseUrl, data.run_id, scope);
      return;
    }

    // Wait mode
    if (options.wait) {
      await waitForCompletion(baseUrl, data.run_id, scope);
      return;
    }
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err.message.includes('fetch') || err.message.includes('ECONNREFUSED'))
    ) {
      output.error('Backend server not running');
      output.info('Run "agent dev" first to start the server');
      process.exit(1);
    }
    output.error(
      `Failed to create run: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

/**
 * Stream events from SSE endpoint
 */
async function streamEvents(baseUrl: string, runId: string, scope: ScopePayload): Promise<void> {
  output.info('Streaming events (Ctrl+C to stop)...');
  output.print('');

  try {
    const response = await fetch(`${baseUrl}/api/runs/${runId}/stream`, {
      headers: scopeHeaders(scope),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';

    // Use async iterator for the stream
    for await (const chunk of response.body) {
      const bytes = chunk as Uint8Array;
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const event = JSON.parse(data) as {
              ts: string;
              type: string;
              step_id?: string;
              payload?: Record<string, unknown>;
            };
            output.print(output.formatEvent(event));

            // Exit on completion
            if (
              event.type === 'run.completed' ||
              event.type === 'run.failed'
            ) {
              return;
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    }
  } catch (err) {
    output.error(
      `Stream error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Wait for run completion by polling
 */
async function waitForCompletion(
  baseUrl: string,
  runId: string,
  scope: ScopePayload
): Promise<void> {
  output.info('Waiting for completion...');

  const startTime = Date.now();
  const pollInterval = 1000;
  const maxWait = 300000; // 5 minutes

  while (Date.now() - startTime < maxWait) {
    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`, {
        headers: scopeHeaders(scope),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { status: string };

      if (data.status === 'completed') {
        const duration = output.formatDuration(Date.now() - startTime);
        output.success(`Run completed in ${duration}`);
        return;
      }

      if (data.status === 'failed') {
        output.error('Run failed');
        process.exit(1);
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (err) {
      output.error(
        `Poll error: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  }

  output.warn('Timeout waiting for completion');
}
