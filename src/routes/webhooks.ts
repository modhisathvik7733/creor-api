import { Hono } from "hono"
import { db } from "../db/client"
import { billing, subscriptions } from "../db/schema"
import { eq, sql } from "drizzle-orm"
import { verifyRazorpaySignature } from "../lib/razorpay"
import { createId } from "../lib/id"

export const webhookRoutes = new Hono()

// ── Razorpay webhook handler ──

webhookRoutes.post("/razorpay", async (c) => {
  const body = await c.req.text()
  const signature = c.req.header("x-razorpay-signature")

  if (!signature || !verifyRazorpaySignature(body, signature)) {
    return c.json({ error: "Invalid signature" }, 400)
  }

  const event = JSON.parse(body) as RazorpayWebhookEvent

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
