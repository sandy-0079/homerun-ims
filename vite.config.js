import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // The commit the browser bundle was built from, stamped into
    // `params/toTargets.engineCommit` by applyAndRun so it matches what
    // api/run-engine.js stamps from process.env.VERCEL_GIT_COMMIT_SHA.
    //
    // ⚠ WHY: Vercel (frontend) and Supabase deploy separately, and the browser
    // Apply and the nightly headless run are two writers of the same row.
    // Stamping both makes a drift between them VISIBLE in the row, rather than
    // something you deduce later from wrong transfer quantities. Falls back to
    // "local" under `npm run dev` — itself useful, since a row stamped "local"
    // was written from somebody's laptop.
    __ENGINE_COMMIT__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || 'local'),
  },
})
