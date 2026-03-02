import type { FeishuChunkingConfig } from '../../../../types/feishu.js';
import type { RuntimeTool, ToolContext } from '../../tools/_helpers.js';
import { extractString, extractBoolean } from '../../tools/_helpers.js';
import { ToolError } from '../../../../utils/errors.js';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'feishu_ingest_doc',
      description: 'Ingest one Feishu document into archival knowledge memory',
      parameters: {
        type: 'object',
        properties: {
          doc_token: { type: 'string', description: 'Feishu doc token (or wiki token)' },
          doc_url: { type: 'string', description: 'Feishu document URL; token will be parsed from path' },
          title: { type: 'string', description: 'Optional title override' },
          source_key: { type: 'string', description: 'Optional stable source key, default: docx:<document_id>' },
          chunking: {
            type: 'object',
            properties: {
              target_tokens: { type: 'number' },
              max_tokens: { type: 'number' },
              min_tokens: { type: 'number' },
              media_context_blocks: { type: 'number' },
            },
          },
          project_shared: { type: 'boolean', default: true },
          metadata: { type: 'object' },
        },
      },
      source: 'builtin',
      metadata: { risk_level: 'medium', mutating: true, supports_parallel: false },
      handler: async (params) => {
        const service = ctx.feishuSyncService;
        if (!service) {
          throw new ToolError('feishu sync service is not configured', 'feishu_ingest_doc');
        }
        const docToken = extractString(params['doc_token']);
        const docUrl = extractString(params['doc_url']);
        if (!docToken && !docUrl) {
          throw new ToolError('doc_token or doc_url is required', 'feishu_ingest_doc');
        }
        const title = extractString(params['title']);
        const sourceKey = extractString(params['source_key']);
        const chunkingRaw = params['chunking'];
        const chunking = typeof chunkingRaw === 'object' && chunkingRaw !== null
          ? (chunkingRaw as Partial<FeishuChunkingConfig>)
          : undefined;
        const metadataRaw = params['metadata'];
        const metadata = typeof metadataRaw === 'object' && metadataRaw !== null
          ? (metadataRaw as Record<string, unknown>)
          : undefined;
        const projectShared = extractBoolean(params['project_shared']);

        return service.ingestDoc({
          scope: {
            orgId: ctx.scope.orgId,
            userId: ctx.scope.userId,
            projectId: ctx.scope.projectId,
          },
          ...(docToken ? { doc_token: docToken } : {}),
          ...(docUrl ? { doc_url: docUrl } : {}),
          ...(title ? { title } : {}),
          ...(sourceKey ? { source_key: sourceKey } : {}),
          ...(chunking ? { chunking } : {}),
          ...(projectShared !== null ? { project_shared: projectShared } : {}),
          ...(metadata ? { metadata } : {}),
        });
      },
    },
  ];
}

