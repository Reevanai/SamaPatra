import { getAIConfig, type AIConfigValues, type ProviderName } from './config.js';
import { createGeminiProvider } from './gemini.js';
import { createSarvamProvider } from './sarvam.js';
import type { PdfCapableProvider } from './types.js';

export function buildProvider(name: ProviderName, config: AIConfigValues): PdfCapableProvider {
  return name === 'gemini' ? createGeminiProvider(config) : createSarvamProvider(config);
}

/** Provider for translation, grading and adapting questions. */
export async function getTextProvider(): Promise<{ name: ProviderName; provider: PdfCapableProvider }> {
  const config = await getAIConfig();
  return { name: config.textProvider, provider: buildProvider(config.textProvider, config) };
}

/** Provider for reading question paper PDFs. */
export async function getPdfProvider(): Promise<{ name: ProviderName; provider: PdfCapableProvider }> {
  const config = await getAIConfig();
  return { name: config.pdfProvider, provider: buildProvider(config.pdfProvider, config) };
}
