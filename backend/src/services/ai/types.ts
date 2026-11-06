// AI Provider interface - abstraction for any AI service
export interface AIProvider {
  generateText(prompt: string, options?: GenerateOptions): Promise<string>;
  generateStructured<T>(prompt: string, schema: any, options?: GenerateOptions): Promise<T>;
  estimateTokens(text: string): number;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  systemPrompt?: string;
}

export interface AIConfig {
  apiKey: string;
  model: string;
  maxRetries?: number;
  retryDelay?: number;
}

// Rate limiting
export class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private requestsThisMinute = 0;
  private minuteStart = Date.now();

  constructor(private maxRequestsPerMinute: number) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      if (now - this.minuteStart >= 60000) {
        this.requestsThisMinute = 0;
        this.minuteStart = now;
      }

      if (this.requestsThisMinute >= this.maxRequestsPerMinute) {
        const waitTime = 60000 - (now - this.minuteStart);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.requestsThisMinute = 0;
        this.minuteStart = Date.now();
      }

      const task = this.queue.shift();
      if (task) {
        this.requestsThisMinute++;
        // Start it and move on: the limit is on how many start per minute, not one at a time.
        // (Awaiting here made every AI call wait for the one before, e.g. behind a long PDF import.)
        void task();
      }
    }

    this.processing = false;
  }
}

// Retry with exponential backoff
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if it's a rate limit error (429)
      if (error.status === 429 || error.message?.includes('429')) {
        const delay = delayMs * Math.pow(2, attempt - 1);
        console.log(`Rate limited. Retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Don't retry on other errors
      throw error;
    }
  }

  throw lastError!;
}

/** A provider that can also read a PDF and return JSON (used for question paper import). */
export interface PdfCapableProvider extends AIProvider {
  readonly modelName: string;
  generateStructuredFromPdf<T>(
    pdf: Buffer,
    prompt: string,
    schema: any,
    options?: GenerateOptions
  ): Promise<T>;
}
