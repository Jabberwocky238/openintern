import type { LLMConfig, Message } from '@openintern/types/agent.js';
import { createLLMClient } from '../../agent/llm-client.js';
import { PlanValidationError } from './plan-validator.js';

const MAX_TASKS = 12;

export interface PlannerRoleProfile {
  id: string;
  name: string;
  description: string;
}

export interface GeneratePlanInput {
  modelConfig: LLMConfig;
  userInput: string;
  roles: PlannerRoleProfile[];
  signal?: AbortSignal;
}

function buildPlannerMessages(input: GeneratePlanInput): Message[] {
  const rolesBlock = input.roles
    .map((role) => `- ${role.id}: ${role.name} | ${role.description}`)
    .join('\n');

  const systemPrompt = [
    'You are a strict planning model for a plan-and-execute runtime.',
    'Return ONLY valid JSON without markdown fences.',
    'Output schema:',
    '{"tasks":[{"id":"t1","task":"...","role_id":"...","depends_on":["t0"],"context":"...","acceptance":"..."}]}',
    'Rules:',
    `- Create at most ${MAX_TASKS} tasks.`,
    '- id must be unique.',
    '- depends_on must reference existing ids only.',
    '- Do not include cyclic dependencies.',
    '- role_id must be selected from provided roles.',
    '- Keep each task atomic and executable.',
  ].join('\n');

  const userPrompt = [
    'User goal:',
    input.userInput,
    '',
    'Available roles:',
    rolesBlock,
    '',
    'Return the JSON plan now.',
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.startsWith('```') ? trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '') : trimmed;
  const firstBrace = fenced.indexOf('{');
  const lastBrace = fenced.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new PlanValidationError('Planner response did not contain a JSON object');
  }
  const jsonText = fenced.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch (error) {
    throw new PlanValidationError(
      `Planner response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function generatePlanOutput(input: GeneratePlanInput): Promise<Record<string, unknown>> {
  const llmClient = createLLMClient(input.modelConfig);
  const response = await llmClient.chat(
    buildPlannerMessages(input),
    undefined,
    input.signal ? { signal: input.signal } : undefined
  );
  return extractJsonObject(response.content);
}

