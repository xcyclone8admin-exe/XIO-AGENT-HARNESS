import { ProviderError, ProviderResponse, type ProviderRequest, type ProviderResponse as ProviderResponseType } from '../contracts';
import { HttpAiProvider, type HttpProviderOptions, type ProviderWireAdapter } from './transport';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function commonResponse(value: unknown, output: string, usage: Json, finishReason: ProviderResponseType['finishReason'] = 'complete'): ProviderResponseType {
  const rawCalls: unknown[] = Array.isArray(obj(value).tool_calls) ? obj(value).tool_calls as unknown[] : [];
  const toolCalls = rawCalls.map((raw, index) => {
    const call = obj(raw); const fn = obj(call.function);
    let input: unknown = fn.arguments;
    if (typeof input === 'string') {
      try { input = JSON.parse(input) as unknown; } catch { throw new ProviderError('INVALID_RESPONSE', 'Provider returned malformed tool arguments', false); }
    }
    const name = str(fn.name);
    if (!name) throw new ProviderError('INVALID_RESPONSE', 'Provider returned unnamed tool call', false);
    return { id: str(call.id) || `call-${index}`, capabilityId: name, input };
  });
  const completion = finishReason === 'complete' && toolCalls.length ? 'tool_calls' : finishReason;
  try {
    return ProviderResponse.parse({ output, toolCalls, usage: {
      inputTokens: num(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: num(usage.completion_tokens ?? usage.output_tokens),
      costUsd: num(usage.cost_usd),
    }, finishReason: completion });
  } catch { throw new ProviderError('INVALID_RESPONSE', 'Provider returned an invalid response shape', false); }
}

function openAiAdapter(authorizationPrefix = 'Bearer'): ProviderWireAdapter {
  return {
    request: (r: ProviderRequest) => ({ model: r.model.id, messages: [{ role: 'user', content: r.prompt }, ...r.toolResults.map((x) => ({ role: 'tool', tool_call_id: x.callId, content: JSON.stringify(x.output ?? x.reason ?? x.status) }))] }),
    response: (raw) => {
      const root = obj(raw); const choice = obj(Array.isArray(root.choices) ? root.choices[0] : undefined); const message = obj(choice.message);
      return commonResponse(message, str(message.content), obj(root.usage), choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'content_filter' ? 'refusal' : 'complete');
    },
    authorization: (credential) => `${authorizationPrefix} ${credential}`,
  };
}

export function createOpenAiCompatibleProvider(id: string, options: Omit<HttpProviderOptions, 'id'>): HttpAiProvider {
  return new HttpAiProvider({ ...options, id }, openAiAdapter());
}

export function createOpenRouterProvider(options: Omit<HttpProviderOptions, 'id'>): HttpAiProvider {
  return createOpenAiCompatibleProvider('openrouter', options);
}

export function createOpenAiProvider(options: Omit<HttpProviderOptions, 'id'>): HttpAiProvider {
  return createOpenAiCompatibleProvider('openai', options);
}

export function createGoogleProvider(options: Omit<HttpProviderOptions, 'id'>): HttpAiProvider {
  const adapter: ProviderWireAdapter = {
    request: (r) => ({ contents: [{ role: 'user', parts: [{ text: r.prompt }] }] }),
    response: (raw) => {
      const root = obj(raw); const candidate = obj(Array.isArray(root.candidates) ? root.candidates[0] : undefined); const content = obj(candidate.content);
      const parts = Array.isArray(content.parts) ? content.parts : [];
      return commonResponse({}, parts.map((part) => str(obj(part).text)).join(''), obj(root.usageMetadata), candidate.finishReason === 'MAX_TOKENS' ? 'length' : candidate.finishReason === 'SAFETY' ? 'refusal' : 'complete');
    },
    authorization: () => '',
    headers: (credential) => ({ 'x-goog-api-key': credential }),
  };
  return new HttpAiProvider({ ...options, id: 'google' }, adapter);
}

export function createAnthropicProvider(options: Omit<HttpProviderOptions, 'id'>): HttpAiProvider {
  const adapter: ProviderWireAdapter = {
    request: (r) => ({ model: r.model.id, max_tokens: 4096, messages: [{ role: 'user', content: r.prompt }] }),
    response: (raw) => {
      const root = obj(raw); const content = Array.isArray(root.content) ? root.content : [];
      const output = content.map((part) => str(obj(part).text)).filter(Boolean).join('\n');
      const usage = obj(root.usage);
      return commonResponse({}, output, { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }, root.stop_reason === 'max_tokens' ? 'length' : root.stop_reason === 'refusal' ? 'refusal' : 'complete');
    },
    authorization: () => '',
    headers: (credential) => ({ 'x-api-key': credential, 'anthropic-version': '2023-06-01' }),
  };
  const provider = new HttpAiProvider({ ...options, id: 'anthropic' }, adapter);
  return provider;
}

export function createOllamaProvider(options: Omit<HttpProviderOptions, 'id' | 'credentialRef' | 'credentialScope' | 'broker'>): HttpAiProvider {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new Error('OLLAMA_LOCAL_ENDPOINT_REQUIRED'); }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('OLLAMA_LOCAL_ENDPOINT_REQUIRED');
  const adapter: ProviderWireAdapter = {
    request: (r) => ({ model: r.model.id, prompt: r.prompt, stream: false }),
    response: (raw) => {
      const root = obj(raw);
      return commonResponse({}, str(root.response), { input_tokens: root.prompt_eval_count, output_tokens: root.eval_count }, root.done === false ? 'length' : 'complete');
    },
    authorization: (credential) => credential,
  };
  return new HttpAiProvider({ ...options, id: 'ollama' }, adapter);
}
