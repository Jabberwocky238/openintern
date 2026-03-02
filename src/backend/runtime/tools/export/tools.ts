import type { RuntimeTool, ToolContext } from '../_helpers.js';
import { extractString } from '../_helpers.js';
import { ToolError } from '../../../../utils/errors.js';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'export_trace',
      description: 'Export run events trace as JSON payload',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          limit: { type: 'number', default: 2000 },
        },
        required: ['run_id'],
      },
      source: 'builtin',
      metadata: { risk_level: 'low', mutating: false, supports_parallel: true },
      handler: async (params) => {
        const runId = extractString(params['run_id']);
        if (!runId) throw new ToolError('run_id is required', 'export_trace');
        const limitRaw = params['limit'];
        const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
          ? Math.max(1, Math.floor(limitRaw))
          : 2000;
        const page = await ctx.eventService.list(runId, ctx.scope, undefined, limit);
        return { run_id: runId, next_cursor: page.next_cursor, events: page.events };
      },
    },
  ];
}

