-- SamaPatra Database Schema
-- PostgreSQL 14+

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('teacher', 'student', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Classes table
CREATE TABLE classes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    grade INTEGER NOT NULL CHECK (grade IN (9, 10)),
    subject VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_classes_teacher ON classes(teacher_id);

-- Students table (extends users)
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grade INTEGER NOT NULL CHECK (grade IN (9, 10)),
    language VARCHAR(10) NOT NULL CHECK (language IN ('en', 'hi', 'kn')),
    accessibility_needs TEXT[] DEFAULT '{}',
    accessibility_profile JSONB DEFAULT '{}',
    current_level JSONB DEFAULT '{}', -- {subject: level} mapping
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);

CREATE INDEX idx_students_user ON students(user_id);
CREATE INDEX idx_students_grade ON students(grade);

-- Class enrollments
CREATE TABLE class_enrollments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(class_id, student_id)
);

CREATE INDEX idx_enrollments_class ON class_enrollments(class_id);
CREATE INDEX idx_enrollments_student ON class_enrollments(student_id);

-- Questions bank (base questions)
CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL CHECK (type IN ('mcq', 'short_answer', 'long_answer', 'assertion_reason', 'case_study')),
    grade INTEGER NOT NULL CHECK (grade IN (9, 10)),
    subject VARCHAR(100) NOT NULL,
    chapter VARCHAR(255) NOT NULL,
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    marks DECIMAL(5,2) NOT NULL CHECK (marks > 0),
    content JSONB NOT NULL, -- {text, options, correct_answer, model_answer, marking_scheme, image_url}
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_questions_subject_grade ON questions(subject, grade);
CREATE INDEX idx_questions_difficulty ON questions(difficulty);
CREATE INDEX idx_questions_type ON questions(type);

-- Question versions (rephrased for different languages/needs)
CREATE TABLE question_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    base_question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL CHECK (language IN ('en', 'hi', 'kn')),
    accessibility_context VARCHAR(100), -- 'dyslexia', 'audio', 'standard', etc.
    content JSONB NOT NULL, -- {text, options, image_url}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(base_question_id, language, accessibility_context)
);

CREATE INDEX idx_question_versions_base ON question_versions(base_question_id);
CREATE INDEX idx_question_versions_language ON question_versions(language);

-- Papers (exam instances)
CREATE TABLE papers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    teacher_id UUID NOT NULL REFERENCES users(id),
    class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    subject VARCHAR(100) NOT NULL,
    grade INTEGER NOT NULL CHECK (grade IN (9, 10)),
    total_marks DECIMAL(5,2) NOT NULL,
    duration_minutes INTEGER,
    questions JSONB NOT NULL, -- [{question_version_id, base_question_id, sequence, marks}]
    status VARCHAR(20) NOT NULL CHECK (status IN ('draft', 'published', 'in_progress', 'submitted', 'graded')),
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    submitted_at TIMESTAMP WITH TIME ZONE,
    due_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_papers_student ON papers(student_id);
CREATE INDEX idx_papers_teacher ON papers(teacher_id);
CREATE INDEX idx_papers_status ON papers(status);

-- Student answers
CREATE TABLE answers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paper_id UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    question_version_id UUID NOT NULL REFERENCES question_versions(id),
    base_question_id UUID NOT NULL REFERENCES questions(id),
    answer_text TEXT,
    answer_audio_url TEXT,
    marks_obtained DECIMAL(5,2),
    ai_suggested_marks DECIMAL(5,2),
    ai_feedback TEXT,
    teacher_feedback TEXT,
    is_graded BOOLEAN DEFAULT FALSE,
    answered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    graded_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(paper_id, question_version_id)
);

CREATE INDEX idx_answers_paper ON answers(paper_id);
CREATE INDEX idx_answers_student ON answers(student_id);
CREATE INDEX idx_answers_graded ON answers(is_graded);

-- Adaptive test results
CREATE TABLE adaptive_test_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject VARCHAR(100) NOT NULL,
    estimated_level DECIMAL(3,2) NOT NULL CHECK (estimated_level BETWEEN 1 AND 5),
    questions_attempted INTEGER NOT NULL,
    correct_answers INTEGER NOT NULL,
    question_sequence JSONB, -- [{question_id, difficulty, correct}]
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_adaptive_results_student ON adaptive_test_results(student_id);

-- AI response cache (to avoid duplicate AI calls)
CREATE TABLE ai_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cache_key VARCHAR(255) UNIQUE NOT NULL,
    prompt_hash VARCHAR(64) NOT NULL,
    response JSONB NOT NULL,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_ai_cache_key ON ai_cache(cache_key);
CREATE INDEX idx_ai_cache_expires ON ai_cache(expires_at);

-- Settings changed from the admin panel (API keys are stored encrypted).
-- The server also creates this table on first use if it is missing.
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    is_secret BOOLEAN NOT NULL DEFAULT false,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Wrong-password lockouts (shared by every server instance)
CREATE TABLE IF NOT EXISTS login_attempts (
    key VARCHAR(320) PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- How long slow AI jobs took, so the apps can estimate the next wait
CREATE TABLE IF NOT EXISTS ai_timings (
    id BIGSERIAL PRIMARY KEY,
    operation VARCHAR(40) NOT NULL,
    provider VARCHAR(20) NOT NULL,
    model VARCHAR(100),
    pages INTEGER,
    bytes INTEGER,
    seconds REAL NOT NULL,
    ok BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_timings_lookup ON ai_timings (operation, provider, created_at DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_classes_updated_at BEFORE UPDATE ON classes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_students_updated_at BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_questions_updated_at BEFORE UPDATE ON questions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
ALTER TABLE classes ADD COLUMN IF NOT EXISTS join_code VARCHAR(8) UNIQUE;

-- Only the backend talks to the database. On Supabase, turning on row level security with
-- no policies blocks the public REST API from every table, while the backend (which
-- connects as the database owner) is not affected.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE adaptive_test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_timings ENABLE ROW LEVEL SECURITY;
