# SamaPatra Backend

Backend API for SamaPatra - an inclusive exam platform for students with diverse learning needs.

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Fastify
- **Language**: TypeScript
- **Database**: PostgreSQL 14+
- **AI Providers**: Sarvam AI and Google Gemini (switchable from the admin panel)

## Features

- **AI-Powered Question Parsing**: Parse CBSE question papers from text/PDF
- **Adaptive Testing**: 8-10 question adaptive test that adjusts difficulty based on student performance
- **Personalized Paper Generation**: Generate papers tailored to student level, language (English/Hindi/Kannada), and accessibility needs
- **AI-Assisted Grading**: Auto-grade MCQs, AI suggestions for descriptive answers with teacher review
- **Multi-language Support**: Questions translated and adapted for English, Hindi, and Kannada
- **Accessibility**: Support for blind, low vision, dyslexia, ADHD, and motor difficulty students
- **Caching**: AI responses cached to avoid duplicate API calls and manage costs
- **Rate Limiting**: Built-in rate limiting and retry with exponential backoff for AI calls

## Setup

### Prerequisites

- Node.js 20 or higher
- PostgreSQL 14 or higher
- A Sarvam AI and/or Google Gemini API key

### Installation

1. Clone the repository
2. Navigate to the backend directory:
   ```bash
   cd backend
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Set up environment variables:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and configure:
   - `DATABASE_URL` - PostgreSQL connection string
   - `SARVAM_API_KEY` - Your Sarvam AI API key (get from https://dashboard.sarvam.ai/)
   - `GOOGLE_AI_API_KEY` - Your Gemini API key (get from https://aistudio.google.com/)
   - `AI_TEXT_PROVIDER` / `AI_PDF_PROVIDER` - `sarvam` or `gemini` (defaults: Sarvam for text, Gemini for PDFs)
   - `SETTINGS_ENCRYPTION_KEY` - 64 hex characters (`openssl rand -hex 32`), encrypts keys saved from the admin panel
   - Keys, models and providers can all be changed later from the admin panel (see below)
   - Other settings as needed

5. Create the database:
   ```bash
   createdb samapatra
   ```

6. Run database migrations:
   ```bash
   psql -d samapatra -f src/db/schema.sql
   ```

### Development

Start the development server with hot reload:
```bash
npm run dev
```

The API will be available at `http://localhost:3000`

### Production

Build and run:
```bash
npm run build
npm start
```

## API Endpoints

### Health Check
- `GET /health` - Check API and database health

### Questions
- `GET /api/questions` - List questions (filter by subject, grade, difficulty)
- `GET /api/questions/:id` - Get single question
- `POST /api/questions` - Create question manually
- `PUT /api/questions/:id` - Update question
- `DELETE /api/questions/:id` - Delete question
- `POST /api/questions/parse-paper` - Parse question paper using AI
- `POST /api/questions/:id/generate-model-answer` - Generate model answer
- `POST /api/questions/bulk-import` - Import multiple questions

### Adaptive Testing
- `POST /api/adaptive-test/start` - Start adaptive test
- `POST /api/adaptive-test/answer` - Submit answer and get next question
- `POST /api/adaptive-test/complete` - Complete test and save results
- `GET /api/adaptive-test/history/:studentId` - Get student's test history
- `GET /api/adaptive-test/level/:studentId/:subject` - Get current level

### Papers
- `POST /api/papers/generate` - Generate personalized paper for student
- `GET /api/papers/:id` - Get paper by ID
- `GET /api/papers/student/:studentId` - Get papers for a student
- `GET /api/papers/teacher/:teacherId` - Get papers created by teacher
- `POST /api/papers/:id/publish` - Publish paper (make available to student)
- `POST /api/papers/:id/start` - Student starts paper
- `POST /api/papers/:id/answer` - Submit answer for a question
- `POST /api/papers/:id/submit` - Submit completed paper
- `GET /api/papers/:id/stats` - Get paper statistics
- `DELETE /api/papers/:id` - Delete draft paper

### Grading
- `POST /api/grading/papers/:paperId/auto-grade` - Auto-grade entire paper
- `GET /api/grading/papers/:paperId/summary` - Get grading summary for teacher
- `POST /api/grading/answers/:answerId/ai-grade` - AI-grade single answer
- `POST /api/grading/answers/:answerId/teacher-grade` - Teacher approves/adjusts marks
- `POST /api/grading/papers/:paperId/approve-ai-grades` - Bulk approve AI suggestions

### Students
- `POST /api/students` - Create student profile
- `GET /api/students/:id` - Get student by ID
- `GET /api/students/by-user/:userId` - Get student by user ID
- `PUT /api/students/:id/accessibility` - Update accessibility profile
- `GET /api/classes/:classId/students` - Get students in a class
- `POST /api/classes/:classId/enroll/:studentId` - Enroll student in class
- `DELETE /api/classes/:classId/students/:studentId` - Remove student from class

### Classes
- `POST /api/classes` - Create class
- `GET /api/classes/:id` - Get class by ID
- `GET /api/teachers/:teacherId/classes` - Get teacher's classes
- `PUT /api/classes/:id` - Update class
- `DELETE /api/classes/:id` - Delete class

## Database Schema

See `src/db/schema.sql` for the complete schema.

Main tables:
- `users` - Teachers, students, admins
- `students` - Student profiles with accessibility needs
- `classes` - Teacher's classes
- `class_enrollments` - Student enrollments
- `questions` - Base question bank
- `question_versions` - Translated/adapted versions
- `papers` - Generated exam papers
- `answers` - Student answers
- `adaptive_test_results` - Adaptive test results
- `ai_cache` - Cached AI responses

## AI Provider Architecture

The backend uses an abstraction layer for AI providers, making it easy to swap models or providers:

```typescript
interface AIProvider {
  generateText(prompt: string, options?: GenerateOptions): Promise<string>;
  generateStructured<T>(prompt: string, schema: any, options?: GenerateOptions): Promise<T>;
  estimateTokens(text: string): number;
}
```

Two providers are built in: Sarvam AI (`sarvam.ts`) and Google Gemini (`gemini.ts`).
`providers.ts` picks one for text work and one for PDF import, based on the live settings in `config.ts`. To add a new provider:
1. Implement the `AIProvider` interface
2. Add it to `buildProvider()` in `src/services/ai/providers.ts` and to `ProviderName` in `config.ts`

## Admin panel

The `admin-panel/` folder (repo root) is a small web app for changing the Sarvam and Gemini
API keys, models, and which AI does what, without touching the server.

1. Set `ADMIN_RECOVERY_CODE` (any long random string). In the panel, choose
   **Forgot password, or first time here?** and enter it: you get the admin password,
   a random 24-letter string shown once. Or run `npm run create-admin` in a terminal.
2. Deploy `admin-panel/` (see its README) and add its URL to `CORS_ORIGIN`.

How it is protected:
- Sign-in is with the admin password only (`POST /api/auth/admin/login`). Teachers and students get 403 on admin routes.
- The password is a random 24-letter string. Change it in the panel, or reset it with the recovery
  code (`POST /api/auth/admin/recover`). Either way, every older admin session ends.
- 5 wrong tries from one network address lock sign-in and recovery for 15 minutes.
- Admin sessions last 1 hour; the panel also signs out after 15 minutes without activity.
- Keys are encrypted (AES-256-GCM) before they are stored in the `app_settings` table, and
  are never sent back in full, only as `sk_a••••1234`.
- Every change records who made it and when; sign-ins and changes are logged.

Admin API (all need an admin token): AI settings (`/api/admin/ai-settings`), teachers
(`/api/admin/teachers`), classes (`/api/admin/classes`), students (`/api/admin/students`),
`/api/admin/overview` and `/api/admin/password`. Questions use the regular `/api/questions` routes.

## Deploying on Vercel

The backend runs on Vercel as one serverless function: `npm run build` compiles `src/` to
`dist/`, and `api/index.js` hands every request to the Fastify app (see `vercel.json`).

- Set the project's **Root Directory** to `backend` and add the environment variables from
  `.env.example` (at least `DATABASE_URL`, `JWT_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `CORS_ORIGIN`).
- For Supabase, use the **connection pooler** URL (port 6543), which suits serverless.
- Turn off Vercel Authentication for this project, or the Android app cannot reach the API.
- Vercel limits request bodies to 4.5 MB, so PDF uploads must be smaller than that.
- Sign-in lockouts are stored in the `login_attempts` table, so they work across instances.

## Security

- All AI calls go through the backend - API key never exposed to clients
- Student names and personal details are anonymized before sending to AI
- Rate limiting prevents API abuse
- Input validation using Zod schemas
- PostgreSQL parameterized queries prevent SQL injection

## Performance

- AI response caching reduces costs and latency
- Rate limiting with retry and exponential backoff
- Database indexes on frequently queried columns
- Connection pooling for database

## Testing

Run tests:
```bash
npm test
```

## License

MIT

## Support

For issues or questions, contact the development team.
