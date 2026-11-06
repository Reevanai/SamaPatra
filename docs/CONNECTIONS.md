# SamaPatra – connections and URLs

Everything the project is connected to, in one place.

> **No secrets in this file.** This repository is public. Passwords, keys and codes live only
> in the places listed under [Where the secrets are](#where-the-secrets-are).

## Live addresses

| What | URL |
|---|---|
| Admin panel | https://samapatra-admin.vercel.app |
| API (backend) | https://samapatra-api.vercel.app |
| API health check | https://samapatra-api.vercel.app/health |
| Android app (latest APK) | https://github.com/Reevanai/SamaPatra/releases/tag/android-latest |

The admin panel is behind Vercel's login: sign in to Vercel (reevanai's account) first, then
use the admin password. The API is public on purpose so the Android app can reach it; it has
its own sign-in for every route except `/health` and the sign-in routes.

## GitHub

| | |
|---|---|
| Repository | https://github.com/Reevanai/SamaPatra |
| Working branch | `claude/stoic-gates-a32qj0` |
| APK build workflow | `.github/workflows/android-apk.yml` – https://github.com/Reevanai/SamaPatra/actions/workflows/android-apk.yml |
| APK release | tag `android-latest` (replaced on every Android change) |

The workflow runs on every push that changes `android/`, or by hand from the Actions tab
(**Run workflow**). It builds a debug-signed APK.

## Vercel

Team: **reevanai's projects** (`reevanais-projects`, id `team_CQ3dYke63KL4DBBjXnzJQqwh`)

| Project | Id | Source folder | Region | Dashboard |
|---|---|---|---|---|
| `samapatra-api` | `prj_mknLxJwWRZVFAmqbWJhNYja9Pz5U` | `backend/` | Mumbai (`bom1`) | https://vercel.com/reevanais-projects/samapatra-api |
| `samapatra-admin` | `prj_DRFiYb8qAwqzMkgZwb2WwxrxPUq3` | `admin-panel/` | static | https://vercel.com/reevanais-projects/samapatra-admin |

Both projects were deployed by uploading files, not linked to GitHub, so a `git push` does
**not** redeploy them. To redeploy, either ask Claude, or link each project to the repo in
Vercel (Settings → Git, root directory `backend` or `admin-panel`).

### Environment variables on `samapatra-api`

| Name | What it is |
|---|---|
| `DATABASE_URL` | Supabase transaction pooler connection string (secret) |
| `JWT_SECRET` | Signs sign-in tokens (secret, random) |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts API keys saved from the admin panel (secret, random) |
| `ADMIN_SETUP_CODE` | Admin **recovery code** for "Forgot password" (secret) |
| `CORS_ORIGIN` | `https://samapatra-admin.vercel.app` |
| `TEACHER_SIGNUP_CODE` | Optional. School code for teachers to sign up themselves (otherwise the admin adds teachers) |
| `AI_TEXT_PROVIDER` / `AI_PDF_PROVIDER` | Starting values `sarvam` / `gemini`; the admin panel can change them |
| `NODE_ENV`, `LOG_LEVEL`, `ENABLE_AI_CACHE`, `CACHE_TTL_HOURS`, `AI_RATE_LIMIT_PER_MINUTE` | Plain settings |

### Environment variables on `samapatra-admin`

| Name | Value |
|---|---|
| `ADMIN_API_BASE_URL` | `https://samapatra-api.vercel.app` |

## Supabase (database)

| | |
|---|---|
| Organization | `gvhkyesngxadojeyytsk` |
| Project | **SamaPatra**, ref `bixtsfgbecickjipkkcm`, region Mumbai (`ap-south-1`) |
| Dashboard | https://supabase.com/dashboard/project/bixtsfgbecickjipkkcm |
| Connection used by the API | Transaction pooler: host `aws-0-ap-south-1.pooler.supabase.com`, port `6543`, database `postgres`, user `postgres.bixtsfgbecickjipkkcm` |
| Direct host (not usable from Vercel, IPv6 only) | `db.bixtsfgbecickjipkkcm.supabase.co:5432` |
| Schema | `backend/src/db/schema.sql` (row level security on, no policies: only the backend can read the tables) |

Other projects in the same organization: **Reevan Cloud** (`tusumfnbfkeeeobxxycl`) is
**paused** to make room on the free plan. Restore it from its dashboard when needed (the free
plan allows two active projects).

## AI providers

| Provider | Used for (default) | Get a key | Where the key is set |
|---|---|---|---|
| Sarvam AI | Translation, grading, adapting questions | https://dashboard.sarvam.ai | Admin panel → AI settings |
| Google Gemini | Reading question paper PDFs | https://aistudio.google.com | Admin panel → AI settings |

Keys saved in the admin panel are encrypted in the database (`app_settings` table) and are
never shown again in full. Which provider does which job is also chosen there.

## Android app

| | |
|---|---|
| Package | `com.samapatra.app` |
| Default server | `https://samapatra-api.vercel.app` (`ApiConfig.DEFAULT_URL` in `android/app/src/main/java/com/samapatra/app/ui/theme/data/ApiClient.kt`) |
| Change the server | In the app: Admin (behind the tablet's admin lock) → server address |
| PDF upload limit | 4 MB (Vercel accepts up to 4.5 MB) |

## Where the secrets are

| Secret | Where it lives | How to change it |
|---|---|---|
| Admin panel password | Only in your password manager (24 random letters) | Admin panel → **Change password**, or **Forgot password** with the recovery code |
| Admin recovery code | Vercel → `samapatra-api` → Settings → Environment Variables → `ADMIN_SETUP_CODE` | Edit it there, then redeploy |
| Database password | Supabase → Project Settings → Database | Reset it there, then update `DATABASE_URL` in Vercel and redeploy |
| `JWT_SECRET`, `SETTINGS_ENCRYPTION_KEY` | Vercel environment variables | Changing `JWT_SECRET` signs everyone out; changing `SETTINGS_ENCRYPTION_KEY` means re-entering the AI keys |
| Sarvam / Gemini keys | Encrypted in the database | Admin panel → AI settings |
| Teacher passwords, student PINs | Hashed in the database | Admin panel → Teachers / Students → Reset password / New PIN |
| Vercel token used by Claude to deploy | Saved on the Claude Code cloud environment (`api.vercel.com`) | Revoke at https://vercel.com/account/tokens |

## Running it locally

```bash
cd backend && cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, ...
npm install && npm run dev            # API on http://localhost:3000
```

```bash
cd admin-panel && ADMIN_API_BASE_URL=http://localhost:3000 npm run preview   # http://localhost:5173
```

In the Android emulator, set the server address to `http://10.0.2.2:3000`.
