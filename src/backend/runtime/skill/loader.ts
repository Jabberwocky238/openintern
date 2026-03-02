import fs from 'node:fs';
import path from 'node:path';
import type { Skill, SkillSourceType } from '../../../types/skill.js';
import { logger } from '@openintern/utils';

/**
 * Parsed SKILL.md frontmatter and content.
 */
export interface ParsedSkillFile {
  id: string;
  name: string;
  description: string;
  content: string;
  entryPath: string;
  sourceType: SkillSourceType;
  allowImplicit: boolean;
  dependencies: {
    tools: string[];
    env_vars: string[];
  };
}

/**
 * SkillLoader discovers, parses, and loads skill definitions
 * from local directories (repo/.skills, user home, system paths).
 */
export class SkillLoader {
  private readonly cache = new Map<string, ParsedSkillFile>();

  /**
   * Discover skills from multiple directory paths.
   * Scans each path for SKILL.md files (one level deep).
   */
  async discover(paths: string[]): Promise<ParsedSkillFile[]> {
    const results: ParsedSkillFile[] = [];

    for (const basePath of paths) {
      try {
        const resolved = path.resolve(basePath);
        const stat = await fs.promises.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const entries = await fs.promises.readdir(resolved, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const skillDir = path.join(resolved, entry.name);
          const skillFile = path.join(skillDir, 'SKILL.md');

          const exists = await fs.promises.stat(skillFile).catch(() => null);
          if (!exists?.isFile()) continue;

          try {
            const parsed = await this.parseSkillFile(skillFile, this.inferSourceType(basePath));
            results.push(parsed);
            this.cache.set(parsed.id, parsed);
          } catch (err) {
            logger.warn('Failed to parse skill file', {
              path: skillFile,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.warn('Failed to scan skill directory', {
          path: basePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Skill discovery complete', { count: results.length });
    return results;
  }

  /**
   * Parse a single SKILL.md file into a structured skill definition.
   * Supports YAML-like frontmatter between --- delimiters.
   */
  async parseSkillFile(filePath: string, sourceType: SkillSourceType = 'local'): Promise<ParsedSkillFile> {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const dirName = path.basename(path.dirname(filePath));

    let frontmatter: Record<string, unknown> = {};
    let content = raw;

    // Extract frontmatter if present
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) {
      const frontmatterText = fmMatch[1];
      const markdownContent = fmMatch[2];
      if (frontmatterText !== undefined) {
        frontmatter = this.parseSimpleYaml(frontmatterText);
      }
      if (markdownContent !== undefined) {
        content = markdownContent.trim();
      }
    }

    const name = String(frontmatter['name'] ?? dirName);
    const id = String(frontmatter['id'] ?? `skill_${dirName}`);
    const description = String(frontmatter['description'] ?? content.slice(0, 200));
    const allowImplicit = frontmatter['allow_implicit_invocation'] === true
      || frontmatter['allow_implicit'] === true;

    const deps = frontmatter['dependencies'] as Record<string, unknown> | undefined;
    const tools = Array.isArray(deps?.['tools']) ? deps['tools'].map(String) : [];
    const envVars = Array.isArray(deps?.['env_vars']) ? deps['env_vars'].map(String) : [];

    return {
      id,
      name,
      description,
      content,
      entryPath: filePath,
      sourceType,
      allowImplicit,
      dependencies: { tools, env_vars: envVars },
    };
  }

  /**
   * Load skill content by ID (from cache or re-read from disk).
   */
  async loadSkillContent(skillId: string): Promise<string | null> {
    const cached = this.cache.get(skillId);
    if (!cached) return null;

    // Re-read from disk to get latest content
    try {
      const raw = await fs.promises.readFile(cached.entryPath, 'utf-8');
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const markdownContent = fmMatch?.[1];
      return markdownContent !== undefined ? markdownContent.trim() : raw;
    } catch {
      return cached.content;
    }
  }

  /**
   * Convert discovered skills to Skill objects for the registry.
   */
  toSkills(parsed: ParsedSkillFile[]): Skill[] {
    return parsed.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      tools: [{ name: `skill_load`, description: `Load ${p.name} skill content`, parameters: {} }],
      risk_level: 'low' as const,
      provider: 'builtin' as const,
      health_status: 'healthy' as const,
      entry_path: p.entryPath,
      source_type: p.sourceType,
      allow_implicit_invocation: p.allowImplicit,
      dependencies: p.dependencies,
    }));
  }

  /**
   * Find a skill by mention text (name or $skill-name pattern).
   */
  findByMention(mention: string): ParsedSkillFile | undefined {
    const normalized = mention.replace(/^\$/, '').toLowerCase();
    for (const skill of this.cache.values()) {
      if (skill.id.toLowerCase() === normalized || skill.name.toLowerCase() === normalized) {
        return skill;
      }
    }
    return undefined;
  }

  /**
   * List skills that allow implicit invocation.
   */
  listImplicitSkills(): ParsedSkillFile[] {
    return [...this.cache.values()].filter((s) => s.allowImplicit);
  }

  private inferSourceType(basePath: string): SkillSourceType {
    if (basePath.includes('.skills') || basePath.includes('skills')) return 'repo';
    if (basePath.includes('home') || basePath.includes('~')) return 'system';
    return 'local';
  }

  /**
   * Minimal YAML-like frontmatter parser (key: value pairs, no nesting).
   */
  private parseSimpleYaml(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const line of text.split('\n')) {
      const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      const rawValue = match[2];
      if (key === undefined || rawValue === undefined) {
        continue;
      }
      const value = rawValue.trim();
      if (value === 'true') result[key] = true;
      else if (value === 'false') result[key] = false;
      else if (/^\d+$/.test(value)) result[key] = parseInt(value, 10);
      else if (value.startsWith('[') && value.endsWith(']')) {
        result[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      } else {
        result[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }
    return result;
  }
}

