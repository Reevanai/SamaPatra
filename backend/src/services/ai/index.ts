import { getTextProvider } from './providers.js';
import { aiCache } from './cache.js';

interface ServiceOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  useCache?: boolean;
  cacheContext?: Record<string, any>;
}

// Main AI service. The provider and keys are looked up on every call, so changes
// made in the admin panel take effect without restarting the server.
export class AIService {
  async generateText(prompt: string, options?: ServiceOptions): Promise<string> {
    if (options?.useCache !== false) {
      const cached = await aiCache.get<string>(prompt, options?.cacheContext);
      if (cached) return cached;
    }

    const { name, provider } = await getTextProvider();
    const response = await provider.generateText(prompt, options);

    if (options?.useCache !== false) {
      await aiCache.set(prompt, response, name, provider.modelName, options?.cacheContext);
    }
    return response;
  }

  async generateStructured<T>(prompt: string, schema: any, options?: ServiceOptions): Promise<T> {
    if (options?.useCache !== false) {
      const cached = await aiCache.get<T>(prompt, options?.cacheContext);
      if (cached) return cached;
    }

    const { name, provider } = await getTextProvider();
    const response = await provider.generateStructured<T>(prompt, schema, options);

    if (options?.useCache !== false) {
      await aiCache.set(prompt, response, name, provider.modelName, options?.cacheContext);
    }
    return response;
  }

  estimateTokens(text: string): number {
    // ~4 characters per token; same rough estimate for every provider
    return Math.ceil(text.length / 4);
  }
}

export const aiService = new AIService();
