import { ulid } from "ulid"

/** Generate a prefixed ULID for entity identification */
export function createId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`
}
