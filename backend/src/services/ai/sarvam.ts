import { extractText, getDocumentProxy } from 'unpdf';
import type { AIProvider, AIConfig, GenerateOptions } from './types.js';
import { withRetry, RateLimiter } from './types.js';

const DEFAULT_BASE_URL = 'https://api.sarvam.ai/v1';
const DEFAULT_MODEL = 'sarvam-m';

// One limiter for every Sarvam call in the app, so the rate limit is shared.
let sharedLimiter: RateLimiter | undefined;
function getLimiter(): RateLimiter {
  if (!sharedLimiter) {
    sharedLimiter = new RateLimiter(parseInt(process.env.AI_RATE_LIMIT_PER_MINUTE || '10'));
  }
  return sharedLimiter;
}

/** True for errors that usually clear up when we wait or use another model. */
function isBusy(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 503 || status === 429 || status === 500 || status === 502;
}

class SarvamError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'SarvamError';
  }
}

/** Removes reasoning blocks that some Sarvam models put in the answer. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
}

/** Pulls the JSON value out of a reply that may have code fences or extra words around it. */
export function parseJsonReply<T>(reply: string): T {
  let text = stripThinking(reply);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall back to the outermost [...] or {...} in the reply
    const starts = [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0);
    if (starts.length > 0) {
      const start = Math.min(...starts);
      const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
      if (end > start) return JSON.parse(text.slice(start, end + 1)) as T;
    }
    throw new Error(`AI reply was not valid JSON: ${text.slice(0, 200)}`);
  }
}

function jsonInstructions(schema: any): string {
  return `Reply with ONLY valid JSON (no markdown, no code fences, no explanation) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class SarvamProvider implements AIProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private fallbackModel?: string;
  private rateLimiter: RateLimiter;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: AIConfig & { baseUrl?: string }, fallbackModel?: string) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model;
    this.fallbackModel = fallbackModel && fallbackModel !== config.model ? fallbackModel : undefined;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;
    this.rateLimiter = getLimiter();
  }

  get modelName(): string {
    return this.model;
  }

  /** Tries the main model, and if it stays busy, the backup model. */
  private async callWithFallback<T>(makeCall: (modelName: string) => Promise<T>): Promise<T> {
    const fallback = this.fallbackModel;
    if (!fallback) {
      return withRetry(() => makeCall(this.model), this.maxRetries, this.retryDelay);
    }
    try {
      return await withRetry(() => makeCall(this.model), 2, this.retryDelay);
    } catch (error) {
      if (!isBusy(error)) throw error;
      console.warn(`AI model ${this.model} is busy. Trying ${fallback} instead.`);
      return withRetry(() => makeCall(fallback), this.maxRetries, this.retryDelay);
    }
  }

  private async chat(
    modelName: string,
    messages: ChatMessage[],
    options: GenerateOptions | undefined,
    defaults: { temperature: number; maxTokens: number }
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      temperature: options?.temperature ?? defaults.temperature,
      max_tokens: options?.maxTokens ?? defaults.maxTokens,
    };
    if (options?.stopSequences?.length) body.stop = options.stopSequences;

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new SarvamError(`Sarvam API error ${res.status}: ${detail.slice(0, 500)}`, res.status);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Sarvam API returned no message content');
    }
    return content;
  }

  private buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  async generateText(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.rateLimiter.execute(() =>
      this.callWithFallback(async (modelName) => {
        const reply = await this.chat(
          modelName,
          this.buildMessages(prompt, options?.systemPrompt),
          options,
          { temperature: 0.7, maxTokens: 2048 }
        );
        return stripThinking(reply);
      })
    );
  }

  async generateStructured<T>(prompt: string, schema: any, options?: GenerateOptions): Promise<T> {
    return this.rateLimiter.execute(() =>
      this.callWithFallback(async (modelName) => {
        const reply = await this.chat(
          modelName,
          this.buildMessages(`${prompt}\n\n${jsonInstructions(schema)}`, options?.systemPrompt),
          options,
          { temperature: 0.5, maxTokens: 4096 }
        );
        return parseJsonReply<T>(reply);
      })
    );
  }

  /**
   * Reads a PDF and returns JSON. Sarvam's chat models take text only, so the
   * PDF's text is extracted locally first and sent along with the prompt.
   * Scanned (image-only) PDFs have no text layer and cannot be read this way.
   */
  async generateStructuredFromPdf<T>(
    pdf: Buffer,
    prompt: string,
    schema: any,
    options?: GenerateOptions
  ): Promise<T> {
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { text: pages } = await extractText(doc, { mergePages: false });
    const pdfText = (pages as string[])
      .map((page, i) => `--- Page ${i + 1} ---\n${page.trim()}`)
      .join('\n\n')
      .trim();

    if (!pdfText.replace(/--- Page \d+ ---/g, '').trim()) {
      throw new Error(
        'This PDF has no readable text (it may be a scanned image). Please upload a PDF with selectable text.'
      );
    }

    const fullPrompt = `${prompt}\n\nThe text extracted from the PDF follows. Layout, tables and symbols may be slightly garbled by the extraction, so read it carefully.\n\n<pdf_text>\n${pdfText}\n</pdf_text>`;

    return this.generateStructured<T>(fullPrompt, schema, {
      temperature: 0.2,
      maxTokens: 16384,
      ...options,
    });
  }

  estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for English.
    // Indic scripts usually use more tokens, but this is a safe ballpark.
    return Math.ceil(text.length / 4);
  }
}

export function createSarvamProvider(): SarvamProvider {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error('SARVAM_API_KEY environment variable is required');
  }

  const model = process.env.SARVAM_MODEL || DEFAULT_MODEL;
  const fallback = (process.env.SARVAM_FALLBACK_MODEL ?? '').trim();

  return new SarvamProvider(
    {
      apiKey,
      model,
      baseUrl: process.env.SARVAM_BASE_URL,
      maxRetries: parseInt(process.env.AI_RETRY_MAX_ATTEMPTS || '3'),
      retryDelay: parseInt(process.env.AI_RETRY_DELAY_MS || '1000'),
    },
    fallback === '' || fallback.toLowerCase() === 'none' ? undefined : fallback
  );
}

// Factory function to create AI provider
export function createAIProvider(): AIProvider {
  return createSarvamProvider();
}

export const AI_PROVIDER_NAME = 'sarvam';
export function currentModelName(): string {
  return process.env.SARVAM_MODEL || DEFAULT_MODEL;
}
