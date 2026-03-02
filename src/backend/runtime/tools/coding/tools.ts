import { execFile } from 'node:child_process';
import type { RuntimeTool, ToolContext } from '../_helpers.js';
import { extractString, resolveWithinWorkDir } from '../_helpers.js';
import { ToolError } from '../../../../utils/errors.js';

export function register(ctx: ToolContext): RuntimeTool[] {
  return [
    {
      name: 'exec_command',
      description: 'Execute a shell command in the workspace directory',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default: 30000)' },
          cwd: { type: 'string', description: 'Working directory relative to workspace' },
        },
        required: ['command'],
      },
      source: 'builtin',
      metadata: { risk_level: 'high', mutating: true, supports_parallel: false },
      handler: async (params) => {
        const command = extractString(params['command']);
        if (!command) throw new ToolError('command is required', 'exec_command');
        const timeoutMs = typeof params['timeout_ms'] === 'number' ? params['timeout_ms'] : 30000;
        const cwdRel = extractString(params['cwd']);
        const cwd = cwdRel ? resolveWithinWorkDir(ctx.workDir, cwdRel, 'exec_command') : ctx.workDir;
        return new Promise((resolve) => {
          execFile('sh', ['-c', command], {
            cwd,
            timeout: Math.min(timeoutMs, 120000),
            maxBuffer: 1024 * 1024,
          }, (err, stdout, stderr) => {
            let exitCode = 0;
            if (err) {
              // child_process error: status holds the numeric exit code,
              // code may be a string error code like 'ERR_CHILD_PROCESS_STDIO_FINAL_CLOSE'
              const status = (err as NodeJS.ErrnoException & { status?: number }).status;
              exitCode = typeof status === 'number' ? status : 1;
            }
            resolve({
              exit_code: exitCode,
              stdout: stdout.slice(0, 50000),
              stderr: stderr.slice(0, 10000),
            });
          });
        });
      },
    },
  ];
}

