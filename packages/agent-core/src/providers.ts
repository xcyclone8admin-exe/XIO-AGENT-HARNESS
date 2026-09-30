import type { AiProvider, ModelDescriptor, ProviderRequest, ProviderResponse } from './contracts';

export class ProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();
  private readonly models = new Map<string, ModelDescriptor>();

  registerProvider(provider: AiProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  registerModel(model: ModelDescriptor): void {
    if (model.provider.trim().length === 0) throw new Error('Model provider is required');
    if (this.models.has(this.key(model.provider, model.id))) {
      throw new Error(`Model already registered: ${model.provider}/${model.id}`);
    }
    this.models.set(this.key(model.provider, model.id), model);
  }

  getProvider(id: string): AiProvider | undefined {
    return this.providers.get(id);
  }

  getModel(provider: string, model: string): ModelDescriptor | undefined {
    return this.models.get(this.key(provider, model));
  }

  private key(provider: string, model: string): string {
    return `${provider}\u0000${model}`;
  }
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly shouldRetry: (error: unknown) => boolean;
  readonly onRetry?: (retry: number, error: unknown) => void;
}

/** At most two same-operation retries by default (three attempts total). */
export async function retryOperation<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new Error('maxRetries must be 0..2');
  let retries = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (retries >= maxRetries || !options.shouldRetry(error)) throw error;
      retries += 1;
      options.onRetry?.(retries, error);
    }
  }
}

/** Typed seam for adapter conformance tests without exposing a vendor SDK outside an adapter. */
export async function requestProvider(provider: AiProvider, request: ProviderRequest): Promise<ProviderResponse> {
  return provider.complete(request);
}
