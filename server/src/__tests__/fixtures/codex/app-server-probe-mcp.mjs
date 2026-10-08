// Credential-free MCP fixture used only by the opt-in native app-server smoke.
import { createInterface } from 'node:readline';
import process from 'node:process';

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'veritas-app-server-probe', version: '1.0.0' },
    };
  } else if (request.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'ping',
          description: 'Return the Veritas smoke marker.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    };
  } else if (request.method === 'tools/call' && request.params.name === 'ping') {
    result = { content: [{ type: 'text', text: 'VERITAS_CODEX_APP_SERVER_SMOKE_OK' }] };
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown probe method' } })}\n`
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
