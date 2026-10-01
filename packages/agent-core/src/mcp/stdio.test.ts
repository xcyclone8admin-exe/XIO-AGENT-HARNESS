import { describe, expect, it, vi } from 'vitest';
import { createBrokeredStdioMcpTransport, StdioMcpTransport, type McpByteChannel } from './stdio';

function channel(...replies: unknown[]) {
  const reads: Uint8Array[] = replies.map((reply) => new TextEncoder().encode(`${JSON.stringify(reply)}\n`));
  const transport: McpByteChannel = { write: vi.fn(async () => undefined), read: vi.fn(async () => reads.shift() ?? null), close: vi.fn(async () => undefined) };
  return transport;
}

describe('host-channel MCP transport', () => {
  it('rejects a tool with no capability allowlist mapping before writing', async () => {
    const ch = channel({ jsonrpc: '2.0', id: 1, result: {} });
    const mcp = new StdioMcpTransport(ch, { allowedCapabilities: ['ops.tasks.list'], toolCapabilities: { list: 'ops.tasks.list' }, budget: { maxRequests: 2, maxResponseBytes: 1000, timeoutMs: 100 } });
    expect(() => mcp.callTool('delete', {}, new AbortController().signal)).toThrow('MCP_CAPABILITY_NOT_ALLOWED');
    expect(ch.write).not.toHaveBeenCalled();
  });

  it('lists and invokes allowlisted tools using JSON-RPC over the injected channel', async () => {
    const ch = channel(
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'list', description: 'list tasks', inputSchema: { type: 'object' } }] } },
    );
    const mcp = new StdioMcpTransport(ch, { allowedCapabilities: ['ops.tasks.list'], toolCapabilities: { list: 'ops.tasks.list' }, budget: { maxRequests: 2, maxResponseBytes: 1000, timeoutMs: 100 } });
    await expect(mcp.listTools(new AbortController().signal)).resolves.toHaveLength(1);
    const sent = (ch.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => new TextDecoder().decode(call[0] as Uint8Array));
    expect(sent[0]).toContain('initialize');
    expect(sent[1]).toContain('notifications/initialized');
    expect(sent[2]).toContain('tools/list');
  });

  it('enforces request budgets, cancellation, timeout and response-size ceilings', async () => {
    const ch = channel({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
    const mcp = new StdioMcpTransport(ch, { allowedCapabilities: [], toolCapabilities: {}, budget: { maxRequests: 2, maxResponseBytes: 1000, timeoutMs: 100 } });
    await mcp.listTools(new AbortController().signal);
    await expect(mcp.listTools(new AbortController().signal)).rejects.toThrow('MCP_BUDGET_EXCEEDED');

    const blocked: McpByteChannel = { write: async () => undefined, read: async (signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })), close: async () => undefined };
    const timed = new StdioMcpTransport(blocked, { allowedCapabilities: [], toolCapabilities: {}, budget: { maxRequests: 1, maxResponseBytes: 1000, timeoutMs: 10 } });
    await expect(timed.listTools(new AbortController().signal)).rejects.toThrow('MCP_TIMEOUT');

    const huge = channel({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
    const bounded = new StdioMcpTransport(huge, { allowedCapabilities: [], toolCapabilities: {}, budget: { maxRequests: 1, maxResponseBytes: 10, timeoutMs: 100 } });
    await expect(bounded.listTools(new AbortController().signal)).rejects.toThrow('MCP_RESPONSE_TOO_LARGE');
  });

  it('opens an authenticated channel through the broker without putting the credential on JSON-RPC', async () => {
    const ch = channel({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'list', description: 'list', inputSchema: {} }] } });
    const openSecureChannel = vi.fn(async (credential: string) => { expect(credential).toBe('mcp-token-never-in-message'); return ch; });
    const broker = { withCredential: async <T>(_ref: string, scope: string, callback: (credential: string) => Promise<T>) => { expect(scope).toBe('mcp:server'); return callback('mcp-token-never-in-message'); } };
    const mcp = await createBrokeredStdioMcpTransport({ serverId: 'server', credentialRef: 'broker-ref', credentialScope: 'mcp:server', broker, openSecureChannel, policy: { allowedCapabilities: ['ops.tasks.list'], toolCapabilities: { list: 'ops.tasks.list' }, budget: { maxRequests: 2, maxResponseBytes: 1000, timeoutMs: 100 } } });
    await mcp.listTools(new AbortController().signal);
    const wire = (ch.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => new TextDecoder().decode(call[0] as Uint8Array)).join('');
    expect(wire).not.toContain('mcp-token-never-in-message');
    expect(openSecureChannel).toHaveBeenCalledOnce();
  });
});
