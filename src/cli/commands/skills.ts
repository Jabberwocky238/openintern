/**
 * CLI Command: agent skills
 *
 * List available MCP tools
 */

import { MCPClient, type MCPTool } from '../../backend/agent/mcp-client.js';
import * as output from '../utils/output.js';

const DEFAULT_PYTHON_PATH = process.platform === 'win32' ? 'python' : 'python3';

export interface SkillsListOptions {
  format: 'table' | 'json';
}

/**
 * Execute the skills list command
 */
export async function skillsListCommand(
  options: SkillsListOptions
): Promise<void> {
  const client = new MCPClient({
    pythonPath: process.env['PYTHON_PATH'] ?? DEFAULT_PYTHON_PATH,
    serverModule: 'mcp_server.server',
    cwd: 'python',
    timeout: 10000,
  });

  try {
    output.progress('Connecting to MCP Server');
    await client.start();
    output.progressDone();

    output.progress('Fetching tools');
    const tools = await client.listTools();
    output.progressDone();

    if (tools.length === 0) {
      output.warn('No tools available');
      await client.stop();
      return;
    }

    if (options.format === 'json') {
      output.json(tools);
    } else {
      printToolsTable(tools);
    }

    await client.stop();
  } catch (err) {
    output.progressFailed();
    output.error(
      `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`
    );
    output.info('Make sure Python MCP Server is available');
    output.info('Check: python -m mcp_server.server');
    process.exit(1);
  }
}

/**
 * Print tools in table format
 */
function printToolsTable(tools: MCPTool[]): void {
  output.header('Available Tools');

  const table = output.createTable(['Name', 'Description', 'Provider']);

  for (const tool of tools) {
    const description = truncate(tool.description, 40);
    table.push([tool.name, description, 'mcp:main']);
  }

  output.print(table.toString());
  output.print('');
  output.info(`Total: ${tools.length} tools`);
}

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + '...';
}
