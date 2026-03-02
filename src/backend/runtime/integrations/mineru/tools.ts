import type { MineruExtractOptions } from '../../../../types/mineru.js';
import type { RuntimeTool, ToolContext } from '../../tools/_helpers.js';
import { extractString, extractBoolean, extractNumber, resolveWithinWorkDir } from '../../tools/_helpers.js';
import { ToolError } from '../../../../utils/errors.js';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'mineru_ingest_pdf',
      description: 'Ingest one PDF (URL or local file path) via MinerU into archival knowledge memory',
      parameters: {
        type: 'object',
        properties: {
          file_url: { type: 'string', description: 'Publicly accessible PDF URL' },
          file_path: { type: 'string', description: 'Local PDF absolute path' },
          title: { type: 'string', description: 'Optional title override' },
          source_key: { type: 'string', description: 'Optional stable source key' },
          options: {
            type: 'object',
            properties: {
              model_version: { type: 'string', enum: ['pipeline', 'vlm', 'MinerU-HTML'] },
              is_ocr: { type: 'boolean' },
              enable_formula: { type: 'boolean' },
              enable_table: { type: 'boolean' },
              language: { type: 'string' },
              page_ranges: { type: 'string' },
              no_cache: { type: 'boolean' },
              cache_tolerance: { type: 'number' },
              data_id: { type: 'string' },
            },
          },
          project_shared: { type: 'boolean', default: true },
          metadata: { type: 'object' },
        },
      },
      source: 'builtin',
      metadata: { risk_level: 'medium', mutating: true, supports_parallel: false },
      handler: async (params) => {
        const service = ctx.mineruIngestService;
        if (!service) {
          throw new ToolError('mineru ingest service is not configured', 'mineru_ingest_pdf');
        }
        const fileUrl = extractString(params['file_url']);
        const filePath = extractString(params['file_path']);
        if (!fileUrl && !filePath) {
          throw new ToolError('one of file_url or file_path is required', 'mineru_ingest_pdf');
        }
        if (fileUrl && filePath) {
          throw new ToolError('file_url and file_path cannot both be set', 'mineru_ingest_pdf');
        }
        const resolvedFilePath = filePath ? resolveWithinWorkDir(ctx.workDir, filePath) : null;

        const title = extractString(params['title']);
        const sourceKey = extractString(params['source_key']);
        const projectShared = extractBoolean(params['project_shared']);
        const metadataRaw = params['metadata'];
        const metadata = typeof metadataRaw === 'object' && metadataRaw !== null
          ? (metadataRaw as Record<string, unknown>)
          : undefined;

        const options = parseOptions(params['options']);

        return service.ingestPdf({
          scope: {
            orgId: ctx.scope.orgId,
            userId: ctx.scope.userId,
            projectId: ctx.scope.projectId,
          },
          ...(fileUrl ? { file_url: fileUrl } : {}),
          ...(resolvedFilePath ? { file_path: resolvedFilePath } : {}),
          ...(title ? { title } : {}),
          ...(sourceKey ? { source_key: sourceKey } : {}),
          ...(projectShared !== null ? { project_shared: projectShared } : {}),
          ...(metadata ? { metadata } : {}),
          ...(options ? { options } : {}),
        });
      },
    },
  ];
}

function parseOptions(raw: unknown): MineruExtractOptions | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const mv = extractString(o['model_version']);
  const modelVersion = mv && ['pipeline', 'vlm', 'MinerU-HTML'].includes(mv)
    ? (mv as 'pipeline' | 'vlm' | 'MinerU-HTML')
    : null;
  return {
    ...(modelVersion ? { model_version: modelVersion } : {}),
    ...(extractBoolean(o['is_ocr']) !== null ? { is_ocr: extractBoolean(o['is_ocr']) as boolean } : {}),
    ...(extractBoolean(o['enable_formula']) !== null ? { enable_formula: extractBoolean(o['enable_formula']) as boolean } : {}),
    ...(extractBoolean(o['enable_table']) !== null ? { enable_table: extractBoolean(o['enable_table']) as boolean } : {}),
    ...(extractString(o['language']) ? { language: extractString(o['language']) as string } : {}),
    ...(extractString(o['page_ranges']) ? { page_ranges: extractString(o['page_ranges']) as string } : {}),
    ...(extractBoolean(o['no_cache']) !== null ? { no_cache: extractBoolean(o['no_cache']) as boolean } : {}),
    ...(extractNumber(o['cache_tolerance']) !== null ? { cache_tolerance: extractNumber(o['cache_tolerance']) as number } : {}),
    ...(extractString(o['data_id']) ? { data_id: extractString(o['data_id']) as string } : {}),
  };
}

