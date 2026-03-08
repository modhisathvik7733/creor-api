import { db } from "../db/client.ts"
import { auditLog } from "../db/schema.ts"
import { createId } from "./id.ts"

export async function logAudit(params: {
  workspaceId: string
  userId?: string
  action: string
  resourceType?: string
  resourceId?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
}) {
  try {
    await db.insert(auditLog).values({
      id: createId("aud"),
      ...params,
    })
  } catch (err) {
    console.error("Failed to log audit event:", err)
  }
}
