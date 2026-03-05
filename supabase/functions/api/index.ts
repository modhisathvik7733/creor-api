// Supabase Edge Function entry point
// Serves the entire Hono API from a single function to minimize cold starts

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

// Shim process.env for Node-style env access in Deno
if (typeof globalThis.process === "undefined") {
  ;(globalThis as any).process = {
    env: new Proxy(
      {},
      {
        get(_target, prop) {
          return Deno.env.get(String(prop))
        },
      },
    ),
  }
}

import app from "../../../src/app.ts"

Deno.serve((req: Request) => {
  const url = new URL(req.url)
  // Strip /api prefix — edge function URL already includes /functions/v1/api
  if (url.pathname.startsWith("/api")) {
    url.pathname = url.pathname.slice(4) || "/"
    req = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
  }
  return app.fetch(req)
})
