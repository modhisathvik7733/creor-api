// Supabase Edge Function entry point
// Serves the entire Hono API from a single function to minimize cold starts

import app from "../../../src/app.ts"

Deno.serve(app.fetch)
