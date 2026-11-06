import type { AIProvider } from './types.js';
import { createAIProvider, AI_PROVIDER_NAME, currentModelName } from './sarvam.js';
import { aiCache } from './cache.js';

// Main AI service that uses the provider and cache
export class AIService {
  private provider: AIProvider;

  constructor() {
    this.provider = createAIProvider();
  }

  async generateText(
    prompt: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      useCache?: boolean;
      cacheContext?: Record<string, any>;
    }
  ): Promise<string> {
    // Try cache first
    if (options?.useCache !== false) {
      const cached = await aiCache.get<string>(prompt, options?.cacheContext);
      if (cached) return cached;
    }

    // Generate new response
    const response = await this.provider.generateText(prompt, options);

    // Store in cache
    if (options?.useCache !== false) {
      await aiCache.set(
        prompt,
        response,
        AI_PROVIDER_NAME,
        currentModelName(),
        options?.cacheContext
      );
    }

    return response;
  }

  async generateStructured<T>(
    prompt: string,
    schema: any,
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
      useCache?: boolean;
      cacheContext?: Record<string, any>;
    }
  ): Promise<T> {
    // Try cache first
    if (options?.useCache !== false) {
      const cached = await aiCache.get<T>(prompt, options?.cacheContext);
      if (cached) return cached;
    }

    // Generate new response
    const response = await this.provider.generateStructured<T>(prompt, schema, options);

    // Store in cache
    if (options?.useCache !== false) {
      await aiCache.set(
        prompt,
        response,
        AI_PROVIDER_NAME,
        currentModelName(),
        options?.cacheContext
      );
    }

    return response;
  }

  estimateTokens(text: string): number {
    return this.provider.estimateTokens(text);
  }
}

export const aiService = new AIService();
