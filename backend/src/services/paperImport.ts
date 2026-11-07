import { getDocumentProxy } from 'unpdf';
import { getPdfProvider } from './ai/providers.js';
import { recordTiming } from './aiTiming.js';

const TYPES = ['mcq', 'short_answer', 'long_answer', 'assertion_reason', 'case_study'] as const;
type QuestionType = (typeof TYPES)[number];

export interface ImportedQuestion {
  type: QuestionType;
  grade: number;
  subject: string;
  chapter: string;
  difficulty: number;
  marks: number;
  content: {
    text: string;
    options?: string[];
    correct_answer?: string;
  };
  metadata: {
    questionNumber: string;
    section: string;
    needsFigure: boolean;
    answerSource: 'document' | 'ai' | 'none';
    answerVerified: boolean;
    aiEstimated: string[];
    importedFrom: 'pdf';
  };
}

export interface ImportResult {
  questions: ImportedQuestion[];
  summary: { count: number; totalMarks: number; byType: Record<string, number> };
  warnings: string[];
  /** How long the AI took, and the paper's size (helps the apps estimate the next wait). */
  timing?: { seconds: number; pages: number | null };
}

// No enum values here on purpose: the rules are in the prompt and checked in code below.
const SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      questionNumber: { type: 'string' },
      section: { type: 'string' },
      type: { type: 'string' },
      marks: { type: 'number' },
      chapter: { type: 'string' },
      difficulty: { type: 'number' },
      needsFigure: { type: 'boolean' },
      answerSource: { type: 'string' },
      text: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      correctAnswer: { type: 'string' },
    },
    required: ['questionNumber', 'type', 'marks', 'chapter', 'difficulty', 'needsFigure', 'answerSource', 'text'],
  },
};

const SYSTEM_PROMPT = `You are an experienced CBSE examiner reading an official question paper PDF.
You extract questions exactly as printed, so teachers can build a question bank.
Return ONLY a JSON array.`;

function buildPrompt(grade: number, subject: string): string {
  return `This PDF is a CBSE Grade ${grade} ${subject} question paper. Extract EVERY question exactly once, in order.

For each question return:
- questionNumber: the number as printed, for example "7".
- section: the section letter as printed, for example "B".
- type: one of mcq, short_answer, long_answer, assertion_reason, case_study.
  mcq = a 1-mark objective question with options.
  assertion_reason = has an Assertion (A) and a Reason (R).
  case_study = a passage or situation followed by sub-questions.
  short_answer = written answer worth 2 or 3 marks.
  long_answer = any other written answer.
- marks: the marks for the whole question. For a case study, the total of its parts.
- chapter: the NCERT chapter name that the question mainly tests.
- difficulty: a whole number from 1 to 5. 1 = recall of a fact or definition, 2 = one direct step, 3 = standard multi-step, 4 = combines two ideas, 5 = higher-order or unusual. Use the whole range honestly.
- needsFigure: true if the question depends on a diagram, graph, picture or figure that is not in the text, so it could not be read aloud.
- text: the full question exactly as printed. For mcq and assertion_reason, leave the answer options OUT of text, because they go in options. Write mathematics in plain Unicode text (for example x², √3, π, ≤, and fractions like (a + b)/c), never LaTeX.
- options: for mcq and assertion_reason only, each option as its own string starting with its label, "A) ...", "B) ...", "C) ...", "D) ...".
- correctAnswer and answerSource:
  If the PDF itself contains the answers or a marking scheme, use it and set answerSource to "document".
  Otherwise, for mcq and assertion_reason ONLY, solve it carefully and give the correct option letter, with answerSource "ai".
  For every other question leave correctAnswer empty and set answerSource to "none".
  If you are not sure of the answer, leave correctAnswer empty and use "none". Never guess.

Rules:
- Keep a case study as ONE item, with its passage and every sub-question (i), (ii), (iii)... inside text.
- Keep an internal-choice question as ONE item, with both alternatives and the word OR between them.
- Skip general instructions, section headings, headers, footers and page numbers.`;
}

function toType(value: unknown, hasOptions: boolean, marks: number): QuestionType {
  const v = String(value ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if ((TYPES as readonly string[]).includes(v)) return v as QuestionType;
  if (hasOptions) return 'mcq';
  return marks <= 3 ? 'short_answer' : 'long_answer';
}

function labelOptions(options: string[]): string[] {
  return options.map((o, i) =>
    /^\(?[A-H][).]\s/.test(o) ? o : `${'ABCDEFGH'[i] ?? '?'}) ${o}`
  );
}

function toLetter(value: unknown, options: string[]): string | undefined {
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  const letter = s.match(/^\(?([A-Da-d])[).:]?$/);
  if (letter) return letter[1].toUpperCase();
  // The AI may have written the option's text instead of its letter
  const stripped = (o: string) => o.replace(/^\(?[A-Ha-h][).]\s*/, '').trim().toLowerCase();
  const index = options.findIndex((o) => stripped(o) === s.toLowerCase());
  return index >= 0 ? 'ABCDEFGH'[index] : undefined;
}

/** The AI sometimes leaves "(A) ... (B) ... (C) ..." inside the question text. Splits them out. */
function splitInlineOptions(text: string): { stem: string; options: string[] } | null {
  const start = text.search(/(^|\s)\(A\)\s/);
  if (start === -1) return null;
  const stem = text.slice(0, start).trim();
  if (!stem) return null;
  const parts = text.slice(start).split(/\s*\(([A-H])\)\s+/);
  const options: string[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    options.push(`${parts[i]}) ${parts[i + 1].trim()}`);
  }
  const letters = options.map((o) => o[0]).join('');
  if (options.length < 3 || !'ABCDEFGH'.startsWith(letters)) return null;
  return { stem, options };
}

function normalize(raw: unknown, grade: number, subject: string): ImportResult {
  const warnings: string[] = [];
  const questions: ImportedQuestion[] = [];
  let skipped = 0;
  let noOptions = 0;

  for (const item of (Array.isArray(raw) ? raw : []) as any[]) {
    const fullText = String(item?.text ?? '').trim();
    const marks = Number(item?.marks);
    if (!fullText || !Number.isFinite(marks) || marks <= 0) {
      skipped++;
      continue;
    }

    let optionList: string[] = Array.isArray(item.options)
      ? item.options.map((o: unknown) => String(o).trim()).filter((o: string) => o !== '')
      : [];
    const type = toType(item.type, optionList.length > 0, marks);

    // Move any options that were left inside the question text
    let text = fullText;
    if (type === 'mcq') {
      const inline = splitInlineOptions(fullText);
      if (inline) {
        text = inline.stem;
        if (optionList.length < 3) optionList = inline.options;
      }
    }

    const hasChoices = type === 'mcq' || type === 'assertion_reason';
    const options = hasChoices && optionList.length > 0 ? labelOptions(optionList) : undefined;
    if (hasChoices && !options) noOptions++;

    const letter = options ? toLetter(item.correctAnswer, options) : undefined;
    const claimed = ['document', 'ai'].includes(item.answerSource) ? item.answerSource : 'none';
    const answerSource: 'document' | 'ai' | 'none' = letter ? claimed : 'none';

    const difficulty = Math.min(5, Math.max(1, Math.round(Number(item.difficulty)) || 3));
    const aiEstimated = ['chapter', 'difficulty'];
    if (answerSource === 'ai') aiEstimated.push('answer');

    questions.push({
      type,
      grade,
      subject,
      chapter: String(item.chapter ?? '').trim() || 'General',
      difficulty,
      marks,
      content: {
        text,
        ...(options ? { options } : {}),
        ...(letter ? { correct_answer: letter } : {}),
      },
      metadata: {
        questionNumber: String(item.questionNumber ?? '').trim(),
        section: String(item.section ?? '').trim(),
        needsFigure: item.needsFigure === true,
        answerSource,
        answerVerified: answerSource === 'document',
        aiEstimated,
        importedFrom: 'pdf',
      },
    });
  }

  const byType: Record<string, number> = {};
  for (const q of questions) byType[q.type] = (byType[q.type] ?? 0) + 1;

  if (questions.length === 0) warnings.push('No questions were found in that file.');
  if (skipped > 0) warnings.push(`${skipped} items had no usable text or marks and were skipped.`);
  if (noOptions > 0) warnings.push(`${noOptions} multiple-choice questions came without options. Check them.`);

  const figures = questions.filter((q) => q.metadata.needsFigure).length;
  if (figures > 0) {
    warnings.push(
      `${figures} questions refer to a figure or graph that can’t be shown or read aloud. They are marked, so papers for blind students can leave them out.`
    );
  }
  const aiAnswers = questions.filter((q) => q.metadata.answerSource === 'ai').length;
  if (aiAnswers > 0) {
    warnings.push(
      `${aiAnswers} answers were worked out by the AI, not taken from the paper. Check them before they are used for marking.`
    );
  }

  return {
    questions,
    summary: {
      count: questions.length,
      totalMarks: questions.reduce((sum, q) => sum + q.marks, 0),
      byType,
    },
    warnings,
  };
}

/** Reads a question paper PDF and returns draft questions for the teacher to review. Nothing is saved. */
export async function importPaperFromPdf(
  pdf: Buffer,
  grade: number,
  subject: string
): Promise<ImportResult> {
  const { name, provider } = await getPdfProvider();
  const pages = await countPages(pdf);
  const started = Date.now();
  let ok = false;
  try {
    const raw = await provider.generateStructuredFromPdf<unknown>(
      pdf,
      buildPrompt(grade, subject),
      SCHEMA,
      { systemPrompt: SYSTEM_PROMPT, temperature: 0.2 }
    );
    ok = true;
    const result = normalize(raw, grade, subject);
    return { ...result, timing: { seconds: Math.round((Date.now() - started) / 1000), pages } };
  } finally {
    await recordTiming({
      operation: 'pdf_import',
      provider: name,
      model: provider.modelName,
      pages,
      bytes: pdf.length,
      seconds: (Date.now() - started) / 1000,
      ok,
    });
  }
}

/** Number of pages, or null if the PDF can't be opened here (the AI may still read it). */
export async function countPages(pdf: Buffer): Promise<number | null> {
  try {
    const doc = await getDocumentProxy(new Uint8Array(pdf)); // copies, so `pdf` stays usable
    return doc.numPages;
  } catch {
    return null;
  }
}
