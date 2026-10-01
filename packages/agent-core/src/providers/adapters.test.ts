import { describe, expect, it, vi } from 'vitest';
import { ProviderError, type ProviderRequest } from '../contracts';
import { createAnthropicProvider, createOllamaProvider, createOpenAiCompatibleProvider } from './adapters';
import type { CredentialBroker } from './transport';

const request: ProviderRequest = {
  runId: 'run-1', model: { id: 'model-a', provider: 'test', aliases: [], capabilities: ['text'], contextWindow: 1000, qualityTier: 'standard', latencyTier: 'fast', costTier: 'low', privacyTier: 'external', status: 'available' },
  prompt: 'hello', toolResults: [], signal: new AbortController().signal,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const opts = (fetch: typeof globalThis.fetch, more: Record<string, unknown> = {}) => ({ endpoint: 'https://api.example.test/v1/chat/completions', allowedHosts: ['api.example.test'], fetch, ...more }) as never;

describe('guarded provider adapters', () => {
  it('uses only a broker credential inside the request and maps compatible chat completion', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ephemeral');
      return json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
    });
    const broker: CredentialBroker = { withCredential: async (_ref, scope, run) => { expect(scope).toBe('provider:openai'); return run('ephemeral'); } };
    const provider = createOpenAiCompatibleProvider('openai', opts(fetch, { credentialRef: 'os-key:openai', credentialScope: 'provider:openai', broker }));
    await expect(provider.complete(request)).resolves.toMatchObject({ output: 'ok', usage: { inputTokens: 2, outputTokens: 3 }, toolCalls: [] });
  });

  it('fails closed on disallowed hosts, remote plaintext HTTP, and missing broker', () => {
    expect(() => createOpenAiCompatibleProvider('x', { endpoint: 'https://attacker.test', allowedHosts: ['api.example.test'] })).toThrow('PROVIDER_HOST_NOT_ALLOWED');
    expect(() => createOpenAiCompatibleProvider('x', { endpoint: 'http://api.example.test', allowedHosts: ['api.example.test'] })).toThrow('PROVIDER_ENDPOINT_SCHEME_DENIED');
    expect(() => createOpenAiCompatibleProvider('x', { endpoint: 'https://api.example.test', allowedHosts: ['api.example.test'], credentialRef: 'secret-ref', credentialScope: 'provider:x' })).toThrow('PROVIDER_BROKER_REQUIRED');
    expect(() => createOllamaProvider({ endpoint: 'https://remote.example.test/api/generate', allowedHosts: ['remote.example.test'] })).toThrow('OLLAMA_LOCAL_ENDPOINT_REQUIRED');
  });

  it('does not expose vendor error bodies or credential material in thrown errors', async () => {
    const fetch = vi.fn(async () => json({ error: 'secret=vendor-debug' }, 401));
    const broker: CredentialBroker = { withCredential: async (_ref, _scope, run) => run('never-print-this') };
    const provider = createOpenAiCompatibleProvider('openai', opts(fetch, { credentialRef: 'ref', credentialScope: 'provider:openai', broker }));
    await expect(provider.complete(request)).rejects.toThrow('Provider rejected request');
    await expect(provider.complete(request)).rejects.not.toThrow('never-print-this');
    await expect(provider.complete(request)).rejects.not.toThrow('vendor-debug');
  });

  it('enforces abort and timeout on in-flight transport without fallback at adapter boundary', async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const controller = new AbortController();
    const provider = createOpenAiCompatibleProvider('openai', opts(fetch, { timeoutMs: 20 }));
    const pending = provider.complete({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fetch).toHaveBeenCalledTimes(1);

    const timeoutProvider = createOpenAiCompatibleProvider('openai', opts(fetch, { timeoutMs: 10 }));
    await expect(timeoutProvider.complete(request)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('caps response size and parses Ollama and Anthropic response shapes', async () => {
    const tooBig = createOpenAiCompatibleProvider('openai', opts(vi.fn(async () => new Response('x'.repeat(24), { status: 200 })), { maxResponseBytes: 10 }));
    await expect(tooBig.complete(request)).rejects.toBeInstanceOf(ProviderError);

    const ollama = createOllamaProvider({ endpoint: 'http://localhost:11434/api/generate', allowedHosts: ['localhost:11434'], fetch: vi.fn(async () => json({ response: 'local answer', prompt_eval_count: 2, eval_count: 4, done: true })) });
    await expect(ollama.complete(request)).resolves.toMatchObject({ output: 'local answer', usage: { inputTokens: 2, outputTokens: 4 } });

    const anthropicResponse = { content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 1, output_tokens: 2 }, stop_reason: 'end_turn' };
    const anthropicFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('anthropic-token');
      return json(anthropicResponse);
    });
    const broker: CredentialBroker = { withCredential: async (_ref, _scope, run) => run('anthropic-token') };
    const anthropic = createAnthropicProvider(opts(anthropicFetch, { credentialRef: 'ref', credentialScope: 'provider:anthropic', broker }));
    await expect(anthropic.complete(request)).resolves.toMatchObject({ output: 'answer' });
  });
});
