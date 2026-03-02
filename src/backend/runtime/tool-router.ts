import type { ToolDefinition, ToolResult } from '../../types/agent.js';
import type { Skill } from '../../types/skill.js';
import type { ScopeContext } from './scope.js';
import { ToolError } from '../../utils/errors.js';
import { logger } from '@openintern/utils';
import { MCPClient } from '../agent/mcp-client.js';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { EventService } from './event-service.js';
import type { FeishuSyncService } from './integrations/feishu/sync-service.js';
import type { MineruIngestService } from './integrations/mineru/ingest-service.js';
import type { MemoryService } from './memory-service.js';
import type { AgentContext } from './tool-policy.js';
import { ToolPolicy } from './tool-policy.js';
import type { SkillRegistry } from './skill/registry.js';
import type { EscalationService } from './escalation-service.js';
import type { IGroupRepository } from '@openintern/repository';
import type { RuntimeTool, ToolContext } from './tools/_helpers.js';

// ─── Tool modules ────────────────────────────────────────
import { register as registerMemoryTools } from './tools/memory/tools.js';
import { register as registerFileTools } from './tools/file/tools.js';
import { register as registerCodingTools } from './tools/coding/tools.js';
import { register as registerSkillTools } from './tools/skill/tools.js';
import { register as registerEscalationTools } from './tools/escalation/tools.js';
import { register as registerExportTools } from './tools/export/tools.js';
import { register as registerRoutingTools } from './tools/routing/tools.js';

// ─── Integration modules ────────────────────────────────
import { register as registerFeishuTools } from './integrations/feishu/tools.js';
import { register as registerMineruTools } from './integrations/mineru/tools.js';

// ─── MCP helpers ─────────────────────────────────────────

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolPayload {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
  error?: { message?: string };
}

const MCP_RETRYABLE_ERROR_MARKERS = [
  'MCP server closed',
  'MCP Client not started',
  'Request timeout:',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'stream is not writable',
  'Cannot call write after a stream was destroyed',
];

function parseFirstTextContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as { content?: Array<{ type?: string; text?: string }> };
  const first = value.content?.[0];
  if (!first || first.type !== 'text' || !first.text) return undefined;
  try { return JSON.parse(first.text) as unknown; } catch { return first.text; }
}

function parseMcpContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const payload = result as McpToolPayload;
  const parsedText = parseFirstTextContent(result);
  const hasStructured = 'structuredContent' in payload;
  if (payload.isError === true) {
    return {
      isError: true,
      ...(hasStructured ? { structuredContent: payload.structuredContent } : {}),
      ...(parsedText !== undefined ? { content: parsedText } : {}),
    };
  }
  if (hasStructured) return payload.structuredContent;
  if (parsedText !== undefined) return parsedText;
  return result;
}

function isMcpErrorPayload(value: unknown): value is McpToolPayload & { isError: true } {
  return Boolean(value && typeof value === 'object' && (value as McpToolPayload).isError === true);
}

function extractMcpErrorMessage(value: McpToolPayload & { isError: true }): string {
  const directError = value.error?.message;
  if (typeof directError === 'string' && directError.trim()) return directError.trim();
  const structured = value.structuredContent;
  if (structured && typeof structured === 'object') {
    const message = (structured as { message?: unknown })['message'];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  const content = value.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (content && typeof content === 'object') {
    const message = (content as { message?: unknown })['message'];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return 'MCP tool returned isError=true';
}

// ─── Config ──────────────────────────────────────────────

export interface RuntimeToolRouterConfig {
  scope: ScopeContext;
  memoryService: MemoryService;
  eventService: EventService;
  feishuSyncService?: FeishuSyncService;
  mineruIngestService?: MineruIngestService;
  workDir: string;
  mcp?: {
    enabled: boolean;
    pythonPath?: string;
    serverModule?: string;
    cwd?: string;
    timeoutMs?: number;
  };
  timeoutMs?: number;
  skillRegistry?: SkillRegistry;
  escalationService?: EscalationService;
  groupRepository?: IGroupRepository;
  runRepository?: import('./').IRunRepository;
  roleRepository?: import('./').IRoleRepository;
  runQueue?: { enqueue(runId: string): Promise<void> | void };
  currentRunId?: string;
  currentSessionKey?: string;
}

const DEFAULT_TIMEOUT_MS = 30000;

export type ToolArgsValidationResult =
  | { ok: true }
  | { ok: false; message: string; errors: ErrorObject[] };

// ─── Router class ────────────────────────────────────────

export class RuntimeToolRouter {
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly timeoutMs: number;
  private readonly mcpClient: MCPClient | null;
  private readonly toolPolicy: ToolPolicy;
  private readonly ajv: Ajv;
  private readonly validatorCache = new Map<string, ValidateFunction<Record<string, unknown>>>();
  private readonly ctx: ToolContext;

  constructor(private readonly config: RuntimeToolRouterConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.toolPolicy = new ToolPolicy();
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
    });

    // Build shared mutable context for tool modules
    this.ctx = {
      memoryService: config.memoryService,
      eventService: config.eventService,
      feishuSyncService: config.feishuSyncService,
      mineruIngestService: config.mineruIngestService,
      workDir: config.workDir,
      escalationService: config.escalationService,
      groupRepository: config.groupRepository,
      runRepository: config.runRepository,
      roleRepository: config.roleRepository,
      runQueue: config.runQueue,
      skillRegistry: config.skillRegistry ?? null,
      scope: config.scope,
      currentRunId: config.currentRunId ?? null,
      currentSessionKey: config.currentSessionKey ?? null,
      currentAgentContext: null,
    };

    this.mcpClient = config.mcp?.enabled
      ? new MCPClient({
          ...(config.mcp.pythonPath ? { pythonPath: config.mcp.pythonPath } : {}),
          ...(config.mcp.serverModule ? { serverModule: config.mcp.serverModule } : {}),
          ...(config.mcp.cwd ? { cwd: config.mcp.cwd } : {}),
          timeout: config.mcp.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
      : null;

    this.registerBuiltinTools();
  }

  // ─── State setters ───────────────────────────────────

  setScope(scope: ScopeContext): void {
    this.ctx.scope = scope;
  }

  setRunContext(runId: string, sessionKey: string): void {
    this.ctx.currentRunId = runId;
    this.ctx.currentSessionKey = sessionKey;
  }

  setAgentContext(agentContext: AgentContext | null): void {
    this.ctx.currentAgentContext = agentContext;
  }

  setSkillRegistry(skillRegistry: SkillRegistry | null): void {
    this.ctx.skillRegistry = skillRegistry;
  }

  // ─── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    if (!this.mcpClient) return;
    await this.mcpClient.start();
    await this.refreshMcpTools();
  }

  async stop(): Promise<void> {
    if (this.mcpClient) await this.mcpClient.stop();
  }

  // ─── Query ───────────────────────────────────────────

  listTools(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters, metadata }) => ({
      name,
      description,
      parameters,
      ...(metadata
        ? {
            metadata: {
              risk_level: metadata.risk_level ?? 'low',
              mutating: metadata.mutating ?? false,
              supports_parallel: metadata.supports_parallel ?? true,
              ...(metadata.timeout_ms !== undefined ? { timeout_ms: metadata.timeout_ms } : {}),
            },
          }
        : {}),
    }));
  }

  listSkills(): Skill[] {
    return this.ctx.skillRegistry?.listSkills() ?? [];
  }

  // ─── Dispatch ────────────────────────────────────────

  async callTool(
    name: string,
    params: Record<string, unknown>,
    agentContext?: AgentContext
  ): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool not found: ${name}`, duration: Date.now() - started };
    }

    if (agentContext) {
      const policyResult = this.checkPolicy(name, tool, agentContext);
      if (!policyResult.allowed) {
        if (policyResult.decision === 'ask') {
          logger.info('Tool call requires approval', {
            tool: name, agentId: agentContext.agentId,
            roleId: agentContext.roleId, reason: policyResult.reason,
          });
          return {
            success: false,
            error: `Requires approval: ${policyResult.reason}`,
            duration: Date.now() - started,
            requiresApproval: true,
            policyReason: policyResult.reason,
            riskLevel: this.getToolRiskLevel(name, tool),
          };
        }
        logger.warn('Tool call blocked by policy', {
          tool: name, agentId: agentContext.agentId,
          roleId: agentContext.roleId, reason: policyResult.reason,
        });
        return {
          success: false,
          error: `Blocked: ${policyResult.reason}`,
          duration: Date.now() - started,
          blocked: true,
        };
      }
    }

    try {
      const result = await Promise.race([tool.handler(params), this.timeout(name)]);
      if (tool.source === 'mcp' && isMcpErrorPayload(result)) {
        return {
          success: false, result,
          error: extractMcpErrorMessage(result),
          duration: Date.now() - started,
        };
      }
      // Propagate requiresSuspension from tool return value to ToolResult level
      const isSuspension = result && typeof result === 'object' && (result as Record<string, unknown>)['requiresSuspension'] === true;
      return {
        success: !isSuspension,
        result,
        duration: Date.now() - started,
        ...(isSuspension ? { requiresSuspension: true } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message, duration: Date.now() - started };
    }
  }

  validateToolArgs(
    toolName: string,
    args: Record<string, unknown>
  ): ToolArgsValidationResult {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        ok: false,
        message: `Tool not found: ${toolName}`,
        errors: [],
      };
    }

    let validator: ValidateFunction<Record<string, unknown>>;
    try {
      validator = this.getOrCompileValidator(toolName, tool);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `Tool schema compile failed: ${message}`,
        errors: [],
      };
    }

    const valid = validator(args);
    if (valid) return { ok: true };

    const errors = validator.errors ?? [];
    return {
      ok: false,
      message: this.formatValidationErrors(errors),
      errors,
    };
  }

  // ─── Policy ──────────────────────────────────────────

  private checkPolicy(
    toolName: string,
    tool: RuntimeTool,
    agent: AgentContext
  ): { allowed: boolean; decision: import('./tool-policy.js').PolicyDecision; reason: string } {
    const toolMeta = this.ctx.skillRegistry?.getToolMeta(toolName) ?? {
      name: toolName,
      riskLevel: 'low' as const,
      source: tool.source,
    };
    if (agent.delegatedPermissions) {
      return this.toolPolicy.checkWithDelegated(agent, toolMeta);
    }
    return this.toolPolicy.check(agent, toolMeta);
  }

  private getToolRiskLevel(toolName: string, tool: RuntimeTool): string {
    const toolMeta = this.ctx.skillRegistry?.getToolMeta(toolName);
    if (toolMeta) return toolMeta.riskLevel;
    return tool.metadata?.risk_level ?? 'low';
  }

  private getOrCompileValidator(
    toolName: string,
    tool: RuntimeTool
  ): ValidateFunction<Record<string, unknown>> {
    const cached = this.validatorCache.get(toolName);
    if (cached) return cached;
    const validator = this.ajv.compile<Record<string, unknown>>(tool.parameters);
    this.validatorCache.set(toolName, validator);
    return validator;
  }

  private formatValidationErrors(errors: ErrorObject[]): string {
    if (errors.length === 0) return 'Invalid tool arguments';
    return errors
      .slice(0, 5)
      .map((error) => {
        const path = error.instancePath || '/';
        const message = error.message ?? 'is invalid';
        return `${path} ${message}`;
      })
      .join('; ');
  }

  // ─── Builtin registration ───────────────────────────

  private registerBuiltinTools(): void {
    const registrars = [
      registerMemoryTools,
      registerFileTools,
      registerCodingTools,
      registerSkillTools,
      registerEscalationTools,
      registerExportTools,
      registerRoutingTools,
      registerFeishuTools,
      registerMineruTools,
    ];
    for (const register of registrars) {
      for (const tool of register(this.ctx)) {
        this.tools.set(tool.name, tool);
        this.validatorCache.delete(tool.name);
      }
    }
  }

  // ─── MCP ─────────────────────────────────────────────

  private timeout(toolName: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new ToolError(`Tool timed out after ${this.timeoutMs}ms`, toolName));
      }, this.timeoutMs);
    });
  }

  private async callMcpTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.mcpClient) throw new ToolError('MCP client is not enabled', name);
    try {
      const result = await this.mcpClient.callTool(name, params);
      return parseMcpContent(result);
    } catch (error) {
      if (!this.isRecoverableMcpError(error)) throw error;
      logger.warn('MCP call failed, retrying after reconnect', {
        toolName: name, error: error instanceof Error ? error.message : String(error),
      });
      await this.reconnectMcpClient();
      const result = await this.mcpClient.callTool(name, params);
      return parseMcpContent(result);
    }
  }

  private async reconnectMcpClient(): Promise<void> {
    if (!this.mcpClient) throw new Error('MCP client is not enabled');
    await this.mcpClient.stop().catch(() => undefined);
    await this.mcpClient.start();
    await this.refreshMcpTools();
  }

  private async refreshMcpTools(): Promise<void> {
    if (!this.mcpClient) return;
    const tools = (await this.mcpClient.listTools()) as MCPToolDefinition[];
    const seen = new Set<string>();
    const builtinOrLocalNames = new Set(
      [...this.tools.entries()]
        .filter(([, tool]) => tool.source !== 'mcp')
        .map(([name]) => name)
    );
    for (const tool of tools) {
      const sanitizedBaseName = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const sanitizedName = builtinOrLocalNames.has(sanitizedBaseName)
        ? `mcp__${sanitizedBaseName}`
        : sanitizedBaseName;
      seen.add(sanitizedName);
      this.tools.set(sanitizedName, {
        name: sanitizedName,
        description: tool.description,
        parameters: tool.inputSchema,
        source: 'mcp',
        handler: async (params) => this.callMcpTool(tool.name, params),
      });
      this.validatorCache.delete(sanitizedName);
    }
    for (const [name, tool] of this.tools.entries()) {
      if (tool.source === 'mcp' && !seen.has(name)) {
        this.tools.delete(name);
        this.validatorCache.delete(name);
      }
    }
    logger.info('MCP tools registered', { count: tools.length });
  }

  private isRecoverableMcpError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return MCP_RETRYABLE_ERROR_MARKERS.some((marker) => message.includes(marker));
  }
}







