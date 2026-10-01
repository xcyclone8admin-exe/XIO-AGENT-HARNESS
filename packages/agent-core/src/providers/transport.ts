import { ProviderError, type AiProvider, type ModelDescriptor, type ProviderRequest, type ProviderResponse } from '../contracts';

/** The platform broker keeps the credential in its native boundary for the whole request operation. */
export interface CredentialBroker {
  withCredential<T>(reference: string, scope: string, operation: (credential: string) => Promise<T>): Promise<T>;
}

export interface HttpProviderOptions {
  readonly id: string;
  readonly endpoint: string;
  readonly credentialRef?: string;
  readonly credentialScope?: string;
  readonly broker?: CredentialBroker;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowedHosts: readonly string[];
}

export type ProviderWireRequest = Readonly<Record<string, unknown>>;

export interface ProviderWireAdapter {
  request(request: ProviderRequest): ProviderWireRequest;
  response(value: unknown): ProviderResponse;
  authorization(credential: string): string;
  headers?(credential: string): Readonly<Record<string, string>>;
}

function safeEndpoint(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('PROVIDER_ENDPOINT_INVALID'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('PROVIDER_ENDPOINT_SCHEME_DENIED');
  }
  if (!allowedHosts.includes(url.host)) throw new Error('PROVIDER_HOST_NOT_ALLOWED');
  if (url.username || url.password || url.hash) throw new Error('PROVIDER_ENDPOINT_INVALID');
  return url;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const advertised = Number(response.headers.get('content-length') ?? 0);
  if (advertised > maxBytes) throw new ProviderError('INVALID_RESPONSE', 'Provider response exceeds configured limit', false);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new ProviderError('INVALID_RESPONSE', 'Provider response exceeds configured limit', false);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ProviderError('INVALID_RESPONSE', 'Provider returned invalid JSON', false); }
}

/** Shared guarded HTTP transport. Only the adapter maps vendor protocols and vendor error bodies are discarded. */
export class HttpAiProvider implements AiProvider {
  readonly id: string;
  private readonly endpoint: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: HttpProviderOptions, private readonly adapter: ProviderWireAdapter) {
    this.id = options.id;
    this.endpoint = safeEndpoint(options.endpoint, options.allowedHosts);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) throw new Error('PROVIDER_TIMEOUT_INVALID');
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 20_000_000) throw new Error('PROVIDER_RESPONSE_LIMIT_INVALID');
    if (options.credentialRef && (!options.broker || !options.credentialScope)) throw new Error('PROVIDER_BROKER_REQUIRED');
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal.aborted) throw new ProviderError('CANCELED', 'Provider call canceled', false);
    const timer = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([request.signal, timer]);
    const send = async (credential?: string): Promise<ProviderResponse> => {
      if (signal.aborted) throw new ProviderError(request.signal.aborted ? 'CANCELED' : 'TIMEOUT', 'Provider call aborted', false);
      const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
      if (credential !== undefined) for (const [key, value] of new Headers(this.adapter.headers?.(credential) ?? { authorization: this.adapter.authorization(credential) })) headers.set(key, value);
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST', headers, body: JSON.stringify(this.adapter.request(request)), signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store',
        });
      } catch {
        if (request.signal.aborted) throw new ProviderError('CANCELED', 'Provider call canceled', false);
        if (signal.aborted) throw new ProviderError('TIMEOUT', 'Provider call timed out', true);
        throw new ProviderError('UNAVAILABLE', 'Provider transport failed', true);
      }
      const body = await readBoundedJson(response, this.maxResponseBytes);
      if (!response.ok) {
        if (response.status === 429) throw new ProviderError('RATE_LIMITED', 'Provider rate limited request', true);
        if (response.status >= 500) throw new ProviderError('UNAVAILABLE', 'Provider service unavailable', true);
        throw new ProviderError('INVALID_RESPONSE', 'Provider rejected request', false);
      }
      return this.adapter.response(body);
    };
    if (!this.options.credentialRef) return send();
    try {
      return await this.options.broker!.withCredential(this.options.credentialRef, this.options.credentialScope!, send);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal.aborted) throw new ProviderError('CANCELED', 'Provider call canceled', false);
      if (signal.aborted) throw new ProviderError('TIMEOUT', 'Provider call timed out', true);
      throw new ProviderError('UNAVAILABLE', 'Provider credential or transport unavailable', false);
    }
  }
}

export type ProviderAdapterFactory = (options: Omit<HttpProviderOptions, 'id'>) => (model: ModelDescriptor) => AiProvider;
