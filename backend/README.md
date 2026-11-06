# SamaPatra Backend

Backend API for SamaPatra - an inclusive exam platform for students with diverse learning needs.

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Fastify
- **Language**: TypeScript
- **Database**: PostgreSQL 14+
- **AI Provider**: Sarvam AI

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
- Sarvam AI API key

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
   - `SARVAM_MODEL` - Model name (default: `sarvam-m`)
   - `SARVAM_FALLBACK_MODEL` - Optional backup model used when the main one is busy
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

Current implementation uses the Sarvam AI chat completions API. To add a new provider:
1. Implement the `AIProvider` interface
2. Update `createAIProvider()` in `src/services/ai/sarvam.ts`

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
