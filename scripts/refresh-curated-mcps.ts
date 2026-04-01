#!/usr/bin/env bun
/**
 * Fetches GitHub URLs from punkpeye/awesome-mcp-servers and wong2/awesome-mcp-servers
 * READMEs and merges them with the current curated-mcp-urls.ts (additive only).
 *
 * Usage: bun run scripts/refresh-curated-mcps.ts
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const README_URLS = [
  "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md",
  "https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md",
]

const OUTPUT_PATH = join(
  import.meta.dir,
  "..",
  "src",
  "data",
  "curated-mcp-urls.ts",
)

// Matches GitHub URLs including optional /tree/... monorepo subpaths
const GITHUB_URL_PATTERN =
  /https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-][^\s\)\"'\]<>]*/g

function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[,;.!?)\]]+$/, "")
}

async function fetchReadme(url: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "creor-marketplace-sync/1.0",
  }
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
  }
  return res.text()
}

function extractGithubUrls(readme: string): string[] {
  const raw = readme.match(GITHUB_URL_PATTERN) ?? []
  const seen = new Set<string>()
  const result: string[] = []
  for (const url of raw) {
    const cleaned = stripTrailingPunctuation(url)
    const normalized = normalizeUrl(cleaned)
    if (!seen.has(normalized) && normalized.includes("/")) {
      seen.add(normalized)
      result.push(cleaned)
    }
  }
  return result
}

function deduplicateUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const url of urls) {
    const n = normalizeUrl(url)
    if (!seen.has(n)) {
      seen.add(n)
      result.push(url)
    }
  }
  return result
}

function parseCurrentUrls(): string[] {
  const content = readFileSync(OUTPUT_PATH, "utf-8")
  const matches = content.match(/"(https:\/\/github\.com\/[^"]+)"/g) ?? []
  return matches.map(m => m.slice(1, -1))
}

function generateFile(urls: string[]): string {
  const sorted = [...urls].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const lines = sorted.map(u => `  "${u}",`).join("\n")
  return `/**
 * Curated list of MCP server GitHub URLs.
 * Sources: punkpeye/awesome-mcp-servers + wong2/awesome-mcp-servers
 *
 * Auto-synced daily via .github/workflows/refresh-curated-mcps.yml
 */
export const CURATED_MCP_GITHUB_URLS: readonly string[] = [
${lines}
]
`
}

async function main() {
  const allFromReadmes: string[] = []
  for (const url of README_URLS) {
    console.log(`Fetching ${url}...`)
    const readme = await fetchReadme(url)
    const urls = extractGithubUrls(readme)
    console.log(`  Found ${urls.length} GitHub URLs`)
    allFromReadmes.push(...urls)
  }
  const fromReadme = deduplicateUrls(allFromReadmes)
  console.log(`Total unique GitHub URLs from all sources: ${fromReadme.length}`)

  const current = parseCurrentUrls()
  console.log(`Current list has ${current.length} URLs`)

  // Merge: union — additive only, never remove existing entries
  const currentNormalized = new Set(current.map(normalizeUrl))
  const merged = [...current]
  let added = 0

  for (const url of fromReadme) {
    if (!currentNormalized.has(normalizeUrl(url))) {
      merged.push(url)
      added++
    }
  }

  console.log(`Adding ${added} new URLs → total: ${merged.length}`)

  if (added === 0) {
    console.log("No changes — file not modified")
    return
  }

  writeFileSync(OUTPUT_PATH, generateFile(merged), "utf-8")
  console.log(`Written to ${OUTPUT_PATH}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
