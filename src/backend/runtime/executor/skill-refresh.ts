import { logger } from '../../../utils/logger.js';
import { SkillRegistry } from '../skill/registry.js';
import type { ISkillRepository } from '@openintern/repository';
import type { RuntimeToolRouter } from '../tool-router.js';

export const BUILTIN_TOOL_RISK_LEVELS: Record<string, 'low' | 'medium' | 'high'> = {
  memory_search: 'low',
  memory_get: 'low',
  memory_write: 'medium',
  feishu_ingest_doc: 'medium',
  mineru_ingest_pdf: 'medium',
  read_file: 'low',
  write_file: 'medium',
  list_files: 'low',
  glob_files: 'low',
  grep_files: 'low',
  exec_command: 'high',
  replace_in_file: 'medium',
  export_trace: 'low',
  skills_list: 'low',
  skills_get: 'low',
  escalate_to_group: 'medium',
  list_available_groups: 'low',
};

export async function refreshSkillRegistry(
  router: RuntimeToolRouter,
  skillRepository: ISkillRepository
): Promise<void> {
  const availableTools = router.listTools().map((t) => t.name);
  const registry = new SkillRegistry();

  const builtinToolNames = availableTools.filter((name) =>
    Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_RISK_LEVELS, name)
  );
  registry.registerBuiltinTools(builtinToolNames, BUILTIN_TOOL_RISK_LEVELS);

  try {
    const persistedSkills = await skillRepository.list();
    for (const skill of persistedSkills) {
      registry.register(skill);
    }
  } catch (error) {
    logger.error('Failed to load persisted skills for runtime registry', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Ensure all available tools are represented in the skill catalog.
  const unresolvedTools = availableTools.filter(
    (toolName) => registry.getToolMeta(toolName) === null
  );
  if (unresolvedTools.length > 0) {
    const unresolvedBuiltin = unresolvedTools.filter((name) =>
      Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_RISK_LEVELS, name)
    );
    const unresolvedMcp = unresolvedTools.filter((name) =>
      !Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_RISK_LEVELS, name)
    );

    if (unresolvedBuiltin.length > 0) {
      registry.register({
        id: 'runtime_builtin_auto',
        name: 'Runtime Builtin (auto)',
        description: 'Automatically discovered builtin tools.',
        tools: unresolvedBuiltin.map((name) => ({ name, description: '', parameters: {} })),
        risk_level: 'low',
        provider: 'builtin',
        health_status: 'healthy',
        allow_implicit_invocation: false,
      });
    }

    if (unresolvedMcp.length > 0) {
      registry.register({
        id: 'runtime_mcp_auto',
        name: 'Runtime MCP (auto)',
        description: 'Automatically discovered MCP tools.',
        tools: unresolvedMcp.map((name) => ({ name, description: '', parameters: {} })),
        risk_level: 'low',
        provider: 'mcp',
        health_status: 'healthy',
        allow_implicit_invocation: false,
      });
    }
  }

  router.setSkillRegistry(registry);
}







