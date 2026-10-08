import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_CERTIFIED_VERSION,
  CodexAppServerRpcClient,
  buildCodexAppServerArgs,
  buildSafeCodexAppServerEnv,
  classifyCodexAppServerNotification,
  parseCodexAppServerLine,
  type CodexAppServerTerminalResult,
} from '../services/codex-app-server-adapter.js';

const execFileAsync = promisify(execFile);
const smokeEnabled = process.env.VERITAS_CODEX_APP_SERVER_SMOKE === '1';

describe.runIf(smokeEnabled)('@smoke Codex app-server v0.162.0', () => {
  it(
    'runs strict-stdio MCP, completion, continuation, steering, and interruption controls',
    { timeout: 120_000 },
    async () => {
      const version = await execFileAsync('codex', ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 8 * 1024,
        shell: false,
      });
      expect(`${version.stdout}${version.stderr}`.trim()).toBe(CODEX_APP_SERVER_CERTIFIED_VERSION);

      const workspace = await mkdtemp(path.join(tmpdir(), 'veritas-app-server-smoke-'));
      const child = spawn('codex', buildCodexAppServerArgs(), {
        cwd: workspace,
        env: buildSafeCodexAppServerEnv(process.env),
        shell: false,
      });
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let processing = Promise.resolve();
      let terminal: CodexAppServerTerminalResult | undefined;
      const summaries: string[] = [];
      const methods: string[] = [];
      const completedMcpTools: string[] = [];
      const remoteControlStatuses: string[] = [];
      let ingestionError: unknown;
      let resolveTerminal: (() => void) | undefined;
      const nextTerminal = () => {
        terminal = undefined;
        return new Promise<void>((resolve) => {
          resolveTerminal = resolve;
        });
      };
      const terminalObserved = nextTerminal();
      const waitForTerminal = async (observed: Promise<void>) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            observed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Timed out waiting for Codex app-server turn completion.')),
                90_000
              );
            }),
          ]);
          await processing;
          if (ingestionError) throw ingestionError;
        } finally {
          clearTimeout(timer);
        }
      };
      const rpcClient = new CodexAppServerRpcClient({
        write(line) {
          child.stdin.write(line);
        },
        requestTimeoutMs: 20_000,
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer = `${stderrBuffer}${chunk}`.slice(-64 * 1024);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          processing = processing
            .then(async () => {
              const record = parseCodexAppServerLine(line);
              const inbound = await rpcClient.acceptRecord(record);
              methods.push(inbound.method);
              if (inbound.kind === 'server-request') {
                throw new Error(`Unhandled smoke provider request: ${JSON.stringify(record)}`);
              }
              if (inbound.kind !== 'notification') return;
              if (inbound.method === 'item/completed') {
                const item = (
                  record.params as {
                    item?: { type?: string; server?: string; tool?: string; status?: string };
                  }
                )?.item;
                if (item?.type === 'mcpToolCall' && item.status === 'completed') {
                  completedMcpTools.push(`${item.server}.${item.tool}`);
                }
              }
              if (inbound.method === 'remoteControl/status/changed') {
                const params = record.params;
                if (params && typeof params === 'object' && !Array.isArray(params)) {
                  const status = (params as Record<string, unknown>).status;
                  if (typeof status === 'string') remoteControlStatuses.push(status);
                }
              }
              const classified = classifyCodexAppServerNotification(record);
              if (classified.summary) summaries.push(classified.summary);
              if (classified.terminal) {
                terminal = classified.terminal;
                resolveTerminal?.();
              }
            })
            .catch((error) => {
              ingestionError = error;
              resolveTerminal?.();
            });
        }
      });

      try {
        await rpcClient.initialize();
        const threadId = await rpcClient.startThread({
          cwd: workspace,
          sandboxMode: 'read-only',
          mcpServers: {
            veritas_probe: {
              command: process.execPath,
              // Match the positive catalog emitted by ToolControlPlaneService.
              default_tools_approval_mode: 'approve',
              enabled_tools: ['ping'],
              args: [
                fileURLToPath(
                  new URL('./fixtures/codex/app-server-probe-mcp.mjs', import.meta.url)
                ),
              ],
            },
          },
        });
        const turnId = await rpcClient.startTurn({
          threadId,
          cwd: workspace,
          prompt:
            'Call the veritas_probe ping MCP tool. Reply with exactly the marker it returns. Do not run commands or modify files.',
        });
        expect(threadId).toBeTruthy();
        expect(turnId).toBeTruthy();
        await waitForTerminal(terminalObserved);
        expect(terminal).toMatchObject({ success: true, status: 'completed' });
        expect(summaries.join('')).toContain('VERITAS_CODEX_APP_SERVER_SMOKE_OK');
        expect(methods).toContain('remoteControl/status/changed');
        expect(remoteControlStatuses).toEqual(['disabled']);
        expect(completedMcpTools).toContain('veritas_probe.ping');

        expect(
          await rpcClient.resumeThread({ threadId, cwd: workspace, sandboxMode: 'read-only' })
        ).toBe(threadId);
        const forkId = await rpcClient.forkThread({
          threadId,
          lastTurnId: turnId,
          cwd: workspace,
          sandboxMode: 'read-only',
        });
        expect(forkId).not.toBe(threadId);
        const interrupted = nextTerminal();
        const activeTurn = await rpcClient.startTurn({
          threadId: forkId,
          cwd: workspace,
          prompt: 'Explain the previous smoke test in detail. Do not run commands or modify files.',
        });
        expect(await rpcClient.steer(forkId, activeTurn, 'Keep the explanation brief.')).toBe(
          activeTurn
        );
        await rpcClient.interrupt(forkId, activeTurn);
        await waitForTerminal(interrupted);
        expect(terminal).toMatchObject({ success: false, status: 'interrupted' });
        await rpcClient.archive(forkId);
        await rpcClient.archive(threadId);
      } finally {
        rpcClient.close();
        if (child.stdin.writable) child.stdin.end();
        await Promise.race([
          new Promise<void>((resolve) => child.once('close', () => resolve())),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
              resolve();
            }, 5_000)
          ),
        ]);
        await rm(workspace, { recursive: true, force: true });
      }

      expect(stderrBuffer).not.toMatch(/remote control/i);
    }
  );
});
