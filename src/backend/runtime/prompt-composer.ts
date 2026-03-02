import type { Message } from '../../types/agent.js';
import type { Skill } from '../../types/skill.js';
import type { AgentContext } from './tool-policy.js';
import type { GroupWithRoles } from '@openintern/repository';

/**
 * Environment context injected into prompts.
 */
export interface EnvironmentContext {
  cwd: string;
  date: string;
  repoStatus?: string;
  availableToolNames: string[];
}

/**
 * Budget reminder context.
 */
export interface BudgetContext {
  utilization: number;
  currentStep: number;
  maxSteps: number;
  compactionCount: number;
}

/**
 * Skill injection entry.
 */
export interface SkillInjection {
  skillId: string;
  name: string;
  content: string;
}

export interface PromptComposerConfig {
  /** Base system prompt override */
  basePrompt?: string;
  /** LLM provider for provider-specific patches */
  provider?: 'openai' | 'anthropic' | 'gemini' | 'mock';
}

export interface ComposeInput {
  history: Message[];
  memoryHits: Array<{ id: string; snippet: string; score: number; type: string }>;
  skills: Skill[];
  skillInjections?: SkillInjection[];
  agentContext?: AgentContext;
  environment?: EnvironmentContext;
  budget?: BudgetContext;
  /** Available groups for escalation (injected into system prompt) */
  availableGroups?: GroupWithRoles[];
  /** Max recent messages to keep in context */
  maxHistoryMessages?: number;
}

const DEFAULT_BASE_PROMPT = `You are a task-oriented coding assistant.
You can call tools to accomplish tasks.

Memory workflow:
1) Use memory_search for recall.
2) Use memory_get for full text when needed.
3) Use memory_write to store durable insights.
4) Use feishu_ingest_doc to ingest Feishu docs into archival knowledge when needed.
5) Use mineru_ingest_pdf to ingest PDF URLs or local PDF file paths into archival knowledge when needed.

Tool usage:
- Read-only tools (read_file, glob_files, grep_files, memory_search) can run in parallel.
- Write tools (write_file, replace_in_file, exec_command, memory_write, feishu_ingest_doc, mineru_ingest_pdf) run one at a time.
- When using replace_in_file, your search_block MUST be EXACTLY formatted as it appears in the file.
- To ensure a UNIQUE match, you MUST include a few lines of unchanged context BEFORE and AFTER the line you want to modify.
- Do not omit any lines or use placeholders like '...'.
- Preserve leading indentation exactly; newline and trailing spaces are normalized by runtime matching.
- If a tool fails, analyze the error and retry with corrected parameters.
- Do NOT repeat the same tool call with identical parameters.

Keep answers concise and actionable.`;

const ANTHROPIC_PATCH = `\nWhen using tools, prefer structured JSON arguments. Use tool_use blocks for tool calls.`;
const OPENAI_PATCH = `\nWhen using tools, use function calling format with proper JSON arguments.`;
const GEMINI_PATCH = `\nWhen using tools, use function calling format with proper JSON arguments.`;

/**
 * PromptComposer builds layered system prompts following the P0 design:
 *
 * 1. Base system prompt (language, style, behavior)
 * 2. Provider-specific patches (OpenAI/Anthropic differences)
 * 3. Role & tool strategy (allowed/denied/risk)
 * 4. Environment context (cwd, date, repo, available tools)
 * 4.5. Available Groups catalog (for PA escalation)
 * 5. Skill injection fragments
 * 6. Memory summary & recent conversation
 * 7. Max-step / budget warning
 */
export class PromptComposer {
  private readonly basePrompt: string;
  private readonly provider: string;

  constructor(config?: PromptComposerConfig) {
    this.basePrompt = config?.basePrompt ?? DEFAULT_BASE_PROMPT;
    this.provider = config?.provider ?? 'openai';
  }

  /**
   * Compose the full message array for the LLM call.
   */
  compose(input: ComposeInput): Message[] {
    const systemContent = this.buildSystemPrompt(input);
    const maxHistory = input.maxHistoryMessages ?? 12;
    const slicedHistory = input.history.slice(-maxHistory);
    const alignedHistory = this.alignToFirstUserBoundary(slicedHistory);
    const trimmedHistory = this.repairToolCallIntegrity(alignedHistory);
    return [{ role: 'system', content: systemContent }, ...trimmedHistory];
  }

  private alignToFirstUserBoundary(history: Message[]): Message[] {
    const firstUserIndex = history.findIndex((msg) => msg.role === 'user');
    if (firstUserIndex > 0) {
      return history.slice(firstUserIndex);
    }
    return history;
  }

  /**
   * Remove orphaned tool messages and unresolved assistant tool_calls after history slicing.
   * This prevents provider-side validation errors (notably Anthropic tool_result/tool_use pairing).
   */
  private repairToolCallIntegrity(history: Message[]): Message[] {
    if (history.length === 0) {
      return history;
    }

    const announced = new Set<string>();
    const resolved = new Set<string>();

    for (const msg of history) {
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          announced.add(tc.id);
        }
        continue;
      }
      if (msg.role === 'tool' && msg.toolCallId && announced.has(msg.toolCallId)) {
        resolved.add(msg.toolCallId);
      }
    }

    const repaired: Message[] = [];
    for (const msg of history) {
      if (msg.role === 'tool') {
        if (msg.toolCallId && resolved.has(msg.toolCallId)) {
          repaired.push(msg);
        }
        continue;
      }

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const keptToolCalls = msg.toolCalls.filter((tc) => resolved.has(tc.id));
        if (keptToolCalls.length === 0) {
          const text = typeof msg.content === 'string' ? msg.content.trim() : '';
          if (text.length > 0) {
            repaired.push({ ...msg, toolCalls: undefined });
          }
          continue;
        }
        repaired.push({ ...msg, toolCalls: keptToolCalls });
        continue;
      }

      repaired.push(msg);
    }

    return repaired;
  }

  private buildSystemPrompt(input: ComposeInput): string {
    const sections: string[] = [];

    // Layer 1: Base prompt
    sections.push(this.basePrompt);

    // Layer 2: Provider patch
    sections.push(this.buildProviderPatch());

    // Layer 3: Role & tool strategy
    sections.push(this.buildRolePolicy(input.agentContext));

    // Layer 4: Environment context
    if (input.environment) {
      sections.push(this.buildEnvironmentContext(input.environment));
    }

    // Layer 4.5: Available Groups catalog
    if (input.availableGroups && input.availableGroups.length > 0) {
      sections.push(this.buildGroupCatalog(input.availableGroups));
    }

    // Layer 5: Skill injection
    sections.push(this.buildSkillSection(input.skills, input.skillInjections));

    // Layer 6: Memory summary
    sections.push(this.buildMemorySummary(input.memoryHits));

    // Layer 7: Budget / step warning
    if (input.budget) {
      sections.push(this.buildBudgetReminder(input.budget));
    }

    return sections.filter(Boolean).join('\n\n');
  }

  private buildProviderPatch(): string {
    if (this.provider === 'anthropic') return ANTHROPIC_PATCH.trim();
    if (this.provider === 'openai') return OPENAI_PATCH.trim();
    if (this.provider === 'gemini') return GEMINI_PATCH.trim();
    return '';
  }

  private buildRolePolicy(agentContext?: AgentContext): string {
    if (!agentContext) {
      return 'Role tool policy:\nAllowed list: (not restricted)\nDenied list: (none)';
    }
    return [
      'Role tool policy:',
      `Allowed list: ${agentContext.allowedTools.join(', ') || '(none)'}`,
      `Denied list: ${agentContext.deniedTools.join(', ') || '(none)'}`,
    ].join('\n');
  }

  private buildEnvironmentContext(env: EnvironmentContext): string {
    const lines = [
      'Environment:',
      `Working directory: ${env.cwd}`,
      `Date: ${env.date}`,
    ];
    if (env.repoStatus) {
      lines.push(`Repo status: ${env.repoStatus}`);
    }
    if (env.availableToolNames.length > 0) {
      lines.push(`Available tools: ${env.availableToolNames.join(', ')}`);
    }
    return lines.join('\n');
  }

  private buildGroupCatalog(groups: GroupWithRoles[]): string {
    // Limit to first 5 groups in system prompt to avoid bloat
    const displayed = groups.slice(0, 5);
    const lines: string[] = ['Available Groups:'];
    lines.push('You have access to the following specialized groups for complex tasks:');
    lines.push('');

    for (let i = 0; i < displayed.length; i++) {
      const group = displayed[i]!;
      const memberNames = group.members
        .map((m) => `${m.role_name}(${m.role_id})`)
        .join(', ') || '(none)';
      lines.push(`${i + 1}. ${group.name} (${group.id})`);
      if (group.description) {
        lines.push(`   Description: ${group.description}`);
      }
      lines.push(`   Members: ${memberNames}`);
    }

    if (groups.length > 5) {
      lines.push('');
      lines.push(`(${groups.length - 5} more groups available. Use list_available_groups to see all.)`);
    }

    lines.push('');
    lines.push('To escalate a task to a group, use the escalate_to_group tool. You can either:');
    lines.push('- Specify a group_id explicitly if you know which group to use');
    lines.push('- Let the system auto-select by only providing the goal');
    lines.push('- Use list_available_groups to see all available groups first');

    return lines.join('\n');
  }

  private buildSkillSection(skills: Skill[], injections?: SkillInjection[]): string {
    const lines: string[] = ['Skill catalog:'];

    if (skills.length === 0 && (!injections || injections.length === 0)) {
      lines.push('(none)');
      return lines.join('\n');
    }

    for (const skill of skills.slice(0, 20)) {
      const toolNames = skill.tools.map((t) => t.name).join(', ') || '(none)';
      const implicit = skill.allow_implicit_invocation ? ' [auto]' : '';
      lines.push(`- ${skill.id} [${skill.provider}/${skill.risk_level}]${implicit} ${skill.name}: ${toolNames}`);
    }

    if (injections && injections.length > 0) {
      lines.push('');
      lines.push('Loaded skill content:');
      for (const inj of injections) {
        lines.push(`--- ${inj.name} (${inj.skillId}) ---`);
        lines.push(inj.content);
        lines.push('--- end ---');
      }
    }

    lines.push('');
    lines.push('If you need full details for a skill, call skills_get(skill_id).');
    lines.push('To load a skill into context, call skill_load(name).');

    return lines.join('\n');
  }

  private buildMemorySummary(
    hits: Array<{ id: string; snippet: string; score: number; type: string }>
  ): string {
    if (hits.length === 0) {
      return 'Retrieved memory summaries:\n(none)';
    }
    const lines = hits.map(
      (item, i) => `${i + 1}. [${item.id}] (${item.type},${item.score.toFixed(3)}): ${item.snippet}`
    );
    return `Retrieved memory summaries:\n${lines.join('\n')}`;
  }

  private buildBudgetReminder(budget: BudgetContext): string {
    const lines: string[] = [];
    const stepsLeft = budget.maxSteps - budget.currentStep;

    if (budget.utilization > 0.85) {
      lines.push(`ï¿?Context budget: ${(budget.utilization * 100).toFixed(0)}% used. Be concise. Avoid large tool outputs.`);
    }
    if (stepsLeft <= 3) {
      lines.push(`ï¿?Steps remaining: ${stepsLeft}/${budget.maxSteps}. Wrap up or produce a final answer soon.`);
    }
    if (budget.compactionCount > 0) {
      lines.push(`Context was compacted ${budget.compactionCount} time(s). Some earlier details may be summarized.`);
    }

    return lines.length > 0 ? lines.join('\n') : '';
  }
}


