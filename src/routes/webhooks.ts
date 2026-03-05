import { Hono } from "hono"
import { db } from "../db/client.ts"
import { billing, subscriptions, webhookEvents } from "../db/schema.ts"
import { eq, sql } from "drizzle-orm"
import { verifyRazorpaySignature } from "../lib/razorpay.ts"
import { createId } from "../lib/id.ts"

export const webhookRoutes = new Hono()

/** Claim a webhook event for idempotent processing. Returns true if new. */
async function claimEvent(eventId: string, eventType: string): Promise<boolean> {
  try {
    await db.insert(webhookEvents).values({
      id: createId("whe"),
      eventId,
      eventType,
    })
    return true
  } catch {
    return false // unique constraint = already processed
  }
}

// ── Razorpay webhook handler ──

webhookRoutes.post("/razorpay", async (c) => {
  const body = await c.req.text()
  const signature = c.req.header("x-razorpay-signature")

  if (!signature || !(await verifyRazorpaySignature(body, signature))) {
    return c.json({ error: "Invalid signature" }, 400)
  }

  const event = JSON.parse(body) as RazorpayWebhookEvent

  // Idempotency: derive a unique event ID from the entity
  const entityId =
    event.payload.payment?.entity?.id ??
    event.payload.subscription?.entity?.id ??
    "unknown"
  const eventKey = `${event.event}:${entityId}`

  if (!(await claimEvent(eventKey, event.event))) {
    return c.json({ status: "ok", note: "duplicate" })
  }

  switch (event.event) {
    case "payment.captured": {
      const payment = event.payload.payment.entity
      const workspaceId = payment.notes?.workspaceId
      const type = payment.notes?.type

      if (!workspaceId) break

      if (type === "credits") {
        // Add credits: amount is in paise, convert to micro-paise for storage
        const microPaise = payment.amount * 10000 // paise → micro-paise
        await db
          .update(billing)
          .set({
            balance: sql`${billing.balance} + ${microPaise}`,
            timeUpdated: new Date(),
          })
          .where(eq(billing.workspaceId, workspaceId))
      }
      break
    }

    case "subscription.activated": {
      const sub = event.payload.subscription.entity
      const workspaceId = sub.notes?.workspaceId
      const userId = sub.notes?.userId
      const plan = sub.notes?.plan as "starter" | "pro" | "team"

      if (!workspaceId || !userId || !plan) break

      await db.insert(subscriptions).values({
        id: createId("sub"),
        workspaceId,
        userId,
        plan,
        razorpaySubscriptionId: sub.id,
      })

      await db
        .update(billing)
        .set({
          razorpaySubscriptionId: sub.id,
          timeUpdated: new Date(),
        })
        .where(eq(billing.workspaceId, workspaceId))

      break
    }

    case "subscription.cancelled":
    case "subscription.completed": {
      const sub = event.payload.subscription.entity
      const workspaceId = sub.notes?.workspaceId

      if (!workspaceId) break

      await db
        .update(subscriptions)
        .set({ timeDeleted: new Date() })
        .where(eq(subscriptions.razorpaySubscriptionId, sub.id))

      await db
        .update(billing)
        .set({
          razorpaySubscriptionId: null,
          timeUpdated: new Date(),
        })
        .where(eq(billing.workspaceId, workspaceId))

      break
    }
  }

  return c.json({ status: "ok" })
})

// ── Types ──

interface RazorpayWebhookEvent {
  event: string
  payload: {
    payment: {
      entity: {
        id: string
        amount: number
        currency: string
        status: string
        notes: Record<string, string>
      }
    }
    subscription: {
      entity: {
        id: string
        plan_id: string
        status: string
        notes: Record<string, string>
      }
    }
  }
}
