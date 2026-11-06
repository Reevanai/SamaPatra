# SamaPatra Admin Panel

A small, dependency-free web app for admins to manage the backend's AI settings:

- Add or change the **Sarvam AI** and **Google Gemini** API keys
- Pick the model (and backup model) for each
- Choose which AI handles text work (translation, grading, adapting questions) and which reads question paper PDFs
- Test a key before saving it

Keys are sent to the backend over HTTPS, stored encrypted there, and only ever shown masked.

## Before you start

On the backend:

1. Create an admin account: `cd backend && npm run create-admin -- you@example.com "Your Name"`
2. Set `SETTINGS_ENCRYPTION_KEY` (`openssl rand -hex 32`) in the backend's `.env`.
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

- Only `admin` accounts can sign in; 5 wrong passwords lock sign-in for 15 minutes.
- Sessions last 1 hour and end after 15 minutes without activity or when the tab is closed.
- Strict Content Security Policy: the page can only run its own scripts and only talk to your backend.
- The panel cannot be embedded in other sites, is not indexed by search engines, and is never cached.
