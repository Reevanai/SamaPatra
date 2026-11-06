# SamaPatra Admin Panel

A small, dependency-free web app for running SamaPatra:

- **Teachers**: add, edit, reset passwords, remove
- **Classes**: add, edit, see class codes, remove
- **Students**: add (PIN shown once), edit supports and classes, new PIN, remove
- **Questions**: add, edit, delete, and import a question paper PDF (review before saving)
- **AI settings**:

- Add or change the **Sarvam AI** and **Google Gemini** API keys
- Pick the model (and backup model) for each
- Choose which AI handles text work (translation, grading, adapting questions) and which reads question paper PDFs
- Test a key before saving it

Keys are sent to the backend over HTTPS, stored encrypted there, and only ever shown masked.

## Before you start

On the backend:

1. Set `ADMIN_RECOVERY_CODE` and `SETTINGS_ENCRYPTION_KEY` (`openssl rand -hex 32`) on the backend.
2. Open the panel, choose **Forgot password, or first time here?**, and enter the recovery code.
   You get the admin password (24 random letters), shown once.
3. After deploying the panel, add its URL to the backend's `CORS_ORIGIN`
   (for example `CORS_ORIGIN=https://samapatra-admin.vercel.app`) and restart the backend.

## Deploy on Vercel

1. In Vercel, **Add New → Project**, import this repository, and set **Root Directory** to `admin-panel`.
2. Add an environment variable `ADMIN_API_BASE_URL` with your backend's public address,
   for example `https://api.example.com`. This locks the panel to that server.
   (If you leave it out, the sign-in screen asks for the server address.)
3. Deploy. Vercel uses `vercel.json`: it runs `npm run build` and serves `dist/`.

## Run locally

```bash
ADMIN_API_BASE_URL=http://localhost:3000 npm run preview
```

Then open http://localhost:5173.

## Security notes

- Password-only sign-in with a random 24-letter password; change it any time, or reset it with the
  recovery code. Either way, older sessions end. 5 wrong tries lock sign-in for 15 minutes.
- Sessions last 1 hour and end after 15 minutes without activity or when the tab is closed.
- Strict Content Security Policy: the page can only run its own scripts and only talk to your backend.
- The panel cannot be embedded in other sites, is not indexed by search engines, and is never cached.
