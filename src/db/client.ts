import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.ts"

// Use SUPABASE_DB_URL (auto-provided in edge functions) or fall back to individual params
const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL

// Dedicated server (Fly.io) can hold more connections than edge functions
const isEdgeFunction = !!process.env.SUPABASE_DB_URL
const poolConfig = isEdgeFunction
  ? { max: 3, connect_timeout: 10, idle_timeout: 20 }
  : { max: 25, connect_timeout: 5, idle_timeout: 60 }

const client = dbUrl
  ? postgres(dbUrl, {
      prepare: false,
      ...poolConfig,
    })
  : (() => {
      if (!process.env.DB_HOST || !process.env.DB_PASSWORD) {
        throw new Error("Missing required DB env vars: DB_HOST, DB_PASSWORD (or SUPABASE_DB_URL)")
      }
      return postgres({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "postgres",
        username: process.env.DB_USER ?? "creor_api",
        password: process.env.DB_PASSWORD,
        prepare: false,
        ssl: "require",
        ...poolConfig,
      })
    })()

export const db = drizzle(client, { schema })
