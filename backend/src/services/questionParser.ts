import { createHash } from 'node:crypto';
import { aiService } from './ai/index.js';
import { Language, type Question } from '../types/schema.js';

export interface ParsedQuestion {
  type: string;
  content: {
    text: string;
    options?: string[];
    correct_answer?: string;
    model_answer?: string;
    marking_scheme?: string;
  };
  marks: number;
  section?: string;
  questionNumber?: string;
}

export class QuestionParserService {
  /**
   * Parse a question paper PDF using AI
   * Returns structured questions that teacher can review and confirm
   */
  async parsePaperFromText(
    paperText: string,
    grade: number,
    subject: string
  ): Promise<ParsedQuestion[]> {
    const systemPrompt = `You are an expert at parsing CBSE question papers.
Extract all questions from the provided question paper text.
For each question, identify:
- Question type (mcq, short_answer, long_answer, assertion_reason, case_study)
- Full question text
- Options (for MCQ)
- Marks allocated
- Section and question number

Return ONLY valid JSON, no markdown formatting.`;

    const prompt = `Parse this ${subject} Grade ${grade} CBSE question paper and extract all questions.

Question paper text:
${paperText}

Return a JSON array of questions with this structure:
[{
  "type": "mcq|short_answer|long_answer|assertion_reason|case_study",
  "questionNumber": "1",
  "section": "A",
  "marks": 1,
  "content": {
    "text": "Full question text",
    "options": ["A) option 1", "B) option 2", "C) option 3", "D) option 4"],
    "marking_scheme": "Key points for marking"
  }
}]`;

    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["mcq", "short_answer", "long_answer", "assertion_reason", "case_study"]
          },
          questionNumber: { type: "string" },
          section: { type: "string" },
          marks: { type: "number" },
          content: {
            type: "object",
            properties: {
              text: { type: "string" },
              options: {
                type: "array",
                items: { type: "string" }
              },
              marking_scheme: { type: "string" }
            },
            required: ["text"]
          }
        },
        required: ["type", "marks", "content"]
      }
    };

    const questions = await aiService.generateStructured<ParsedQuestion[]>(
      prompt,
      schema,
      {
        systemPrompt,
        temperature: 0.3,
        maxTokens: 8192,
        useCache: true,
        cacheContext: {
          grade,
          subject,
          textHash: createHash('sha256').update(paperText).digest('hex'),
        }
      }
    );

    return questions;
  }

  /**
   * Translate and rephrase a question for a specific language and accessibility need
   */
  async rephraseQuestion(
    question: Question,
    targetLanguage: Language,
    accessibilityContext?: string
  ): Promise<string> {
    // Don't translate if already in target language and no accessibility context
    if (targetLanguage === Language.ENGLISH && !accessibilityContext) {
      return question.content.text;
    }

    const languageNames = {
      en: 'English',
      hi: 'Hindi',
      kn: 'Kannada'
    };

    let systemPrompt = `You are an expert CBSE ${question.subject} teacher fluent in English, Hindi, and Kannada.
Your task is to translate and rephrase questions while maintaining:
- Academic accuracy and terminology
- CBSE examination standards
- The exact same difficulty level
- All mathematical symbols and formulas correctly`;

    if (accessibilityContext === 'dyslexia') {
      systemPrompt += `\n- Simple, clear sentence structure for dyslexic students
- Shorter sentences where possible
- Active voice preferred`;
    } else if (accessibilityContext === 'audio') {
      systemPrompt += `\n- Clear pronunciation-friendly phrasing
- Spell out mathematical symbols as words where helpful
- Add contextual cues for better audio comprehension`;
    }

    const prompt = `Translate this Grade ${question.grade} ${question.subject} question to ${languageNames[targetLanguage]}.

Original question:
${question.content.text}

${question.content.options ? `Options:\n${question.content.options.join('\n')}` : ''}

${accessibilityContext ? `Adapt for: ${accessibilityContext}` : ''}

Return ONLY the translated question text (and options if present), maintaining all mathematical notation.`;

    const translated = await aiService.generateText(prompt, {
      systemPrompt,
      temperature: 0.4,
      useCache: true,
      cacheContext: {
        questionId: question.id,
        language: targetLanguage,
        context: accessibilityContext
      }
    });

    return translated.trim();
  }

  /**
   * Generate a model answer for a question
   */
  async generateModelAnswer(
    question: Question,
    language: Language = Language.ENGLISH
  ): Promise<string> {
    const languageNames = {
      en: 'English',
      hi: 'Hindi',
      kn: 'Kannada'
    };

    const systemPrompt = `You are an experienced CBSE ${question.subject} examiner.
Provide a concise model answer that would receive full marks.
Follow CBSE marking standards and terminology.`;

    const prompt = `Write a model answer for this Grade ${question.grade} ${question.subject} question (${question.marks} marks) in ${languageNames[language]}.

Question:
${question.content.text}

${question.content.marking_scheme ? `Marking scheme: ${question.content.marking_scheme}` : ''}

Provide a clear, complete answer that covers all mark-earning points.`;

    const modelAnswer = await aiService.generateText(prompt, {
      systemPrompt,
      temperature: 0.5,
      useCache: true,
      cacheContext: {
        questionId: question.id,
        language
      }
    });

    return modelAnswer.trim();
  }

  /**
   * Verify quality of Hindi/Kannada translations
   */
  async verifyTranslationQuality(
    originalText: string,
    translatedText: string,
    language: Language
  ): Promise<{ isGood: boolean; issues?: string[] }> {
    if (language === Language.ENGLISH) {
      return { isGood: true };
    }

    const languageNames = {
      en: 'English',
      hi: 'Hindi',
      kn: 'Kannada'
    };

    const systemPrompt = `You are a bilingual CBSE education quality reviewer.
Check if the ${languageNames[language]} translation maintains academic accuracy and proper terminology.`;

    const prompt = `Review this translation for a CBSE exam question.

Original (English):
${originalText}

Translation (${languageNames[language]}):
${translatedText}

Check for:
1. Academic terminology accuracy
2. Mathematical symbols preserved
3. Meaning preserved
4. Natural language flow

Return JSON: {"isGood": true/false, "issues": ["issue 1", "issue 2"]}`;

    const schema = {
      type: "object",
      properties: {
        isGood: { type: "boolean" },
        issues: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["isGood"]
    };

    const result = await aiService.generateStructured<{ isGood: boolean; issues?: string[] }>(
      prompt,
      schema,
      {
        systemPrompt,
        temperature: 0.3,
        useCache: false // Don't cache quality checks
      }
    );

    return result;
  }
}

export const questionParserService = new QuestionParserService();
