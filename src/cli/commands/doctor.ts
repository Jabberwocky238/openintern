/**
 * CLI Command: agent doctor
 *
 * Run diagnostics and check environment
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'child_process';
import * as output from '../utils/output.js';

const DEFAULT_PYTHON_PATH = process.platform === 'win32' ? 'python' : 'python3';

export interface DoctorOptions {
  fix: boolean;
}

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  hint?: string;
}

/**
 * Execute the doctor command
 */
export async function doctorCommand(options: DoctorOptions): Promise<void> {
  output.header('Running Diagnostics');

  const results: CheckResult[] = [];

  // Check 1: Data directory
  results.push(await checkDataDirectory(options.fix));

  // Check 2: Python MCP Server
  results.push(await checkPythonMCP());

  // Check 3: Backend Server
  results.push(await checkBackendServer());

  // Print results
  output.print('');
  for (const result of results) {
    if (result.passed) {
      output.success(result.message);
    } else {
      output.error(result.message);
      if (result.hint) {
        output.info(`  -> ${result.hint}`);
      }
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  output.print('');
  if (passed === total) {
    output.success(`All ${total} checks passed`);
  } else {
    output.warn(`${passed}/${total} checks passed`);
  }
}

/**
 * Check data directory exists and is writable
 */
async function checkDataDirectory(fix: boolean): Promise<CheckResult> {
  const dataDir = process.env['DATA_DIR'] ?? 'data';
  const absPath = path.resolve(dataDir);

  try {
    const stats = await fs.promises.stat(absPath);
    if (!stats.isDirectory()) {
      return {
        name: 'data_directory',
        passed: false,
        message: `Data directory: ${absPath} (not a directory)`,
        hint: 'Remove the file and run with --fix',
      };
    }

    // Check writable
    await fs.promises.access(absPath, fs.constants.W_OK);

    return {
      name: 'data_directory',
      passed: true,
      message: `Data directory: ${absPath} (writable)`,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (fix) {
        await fs.promises.mkdir(absPath, { recursive: true });
        return {
          name: 'data_directory',
          passed: true,
          message: `Data directory: ${absPath} (created)`,
        };
      }
      return {
        name: 'data_directory',
        passed: false,
        message: `Data directory: ${absPath} (not found)`,
        hint: 'Run with --fix to create',
      };
    }

    return {
      name: 'data_directory',
      passed: false,
      message: `Data directory: ${absPath} (${(err as Error).message})`,
    };
  }
}

/**
 * Check Python MCP Server availability
 */
async function checkPythonMCP(): Promise<CheckResult> {
  const pythonPath = process.env['PYTHON_PATH'] ?? DEFAULT_PYTHON_PATH;

  return new Promise((resolve) => {
    const proc = spawn(pythonPath, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let version = '';

    proc.stdout.on('data', (data: Buffer) => {
      version += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      version += data.toString();
    });

    proc.on('error', () => {
      resolve({
        name: 'python_mcp',
        passed: false,
        message: 'Python MCP Server: Python not found',
        hint: 'Install Python 3.8+ and ensure it is in PATH',
      });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        const ver = version.trim().replace('Python ', '');
        resolve({
          name: 'python_mcp',
          passed: true,
          message: `Python MCP Server: Available (python ${ver})`,
        });
      } else {
        resolve({
          name: 'python_mcp',
          passed: false,
          message: 'Python MCP Server: Python check failed',
          hint: 'Ensure Python is properly installed',
        });
      }
    });
  });
}

/**
 * Check Backend Server connectivity
 */
async function checkBackendServer(): Promise<CheckResult> {
  const baseUrl = process.env['AGENT_API_URL'] ?? 'http://localhost:3000';

  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });

    if (response.ok) {
      return {
        name: 'backend_server',
        passed: true,
        message: `Backend Server: Running at ${baseUrl}`,
      };
    }

    return {
      name: 'backend_server',
      passed: false,
      message: `Backend Server: HTTP ${response.status}`,
      hint: 'Check server logs for errors',
    };
  } catch {
    return {
      name: 'backend_server',
      passed: false,
      message: 'Backend Server: Not running',
      hint: 'Run "agent dev" to start',
    };
  }
}
