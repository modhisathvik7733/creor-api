import { Hono } from "hono"
import { db } from "../db/client.ts"
import { billing, subscriptions, webhookEvents, payments, plans } from "../db/schema.ts"
import { eq, and, sql } from "drizzle-orm"
import { verifyCashfreeWebhookSignature } from "../lib/cashfree.ts"
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

// ── Cashfree webhook handler ──

webhookRoutes.post("/cashfree", async (c) => {
  const body = await c.req.text()
  const signature = c.req.header("x-webhook-signature")
  const timestamp = c.req.header("x-webhook-timestamp")

  if (!signature || !timestamp || !(await verifyCashfreeWebhookSignature(body, timestamp, signature))) {
    return c.json({ error: "Invalid signature" }, 400)
  }

  const event = JSON.parse(body) as CashfreeWebhookEvent

  // Idempotency: derive a unique event key
  const entityId =
    event.data?.subscription?.subscription_id ??
    event.data?.order?.order_id ??
    "unknown"
  const eventKey = `${event.type}:${entityId}`

  if (!(await claimEvent(eventKey, event.type))) {
    return c.json({ status: "ok", note: "duplicate" })
  }

  switch (event.type) {
    case "PAYMENT_SUCCESS_WEBHOOK": {
      // One-time payment (credits) completed
      const order = event.data?.order
      if (!order) break

      const orderId = order.order_id
      const tags = order.order_tags ?? {}
      const workspaceId = tags.workspaceId
      const type = tags.type ?? "credits"

      if (!workspaceId) break

      // Record payment history (idempotent via unique cashfree_payment_id)
      try {
        await db.insert(payments).values({
          id: createId("pay"),
          workspaceId,
          userId: tags.userId ?? null,
          type: type as "credits" | "subscription",
          amountSmallest: Math.round((order.order_amount ?? 0) * 100), // display → smallest
          currency: order.order_currency ?? "INR",
          cashfreeOrderId: orderId,
          cashfreePaymentId: event.data?.payment?.cf_payment_id ?? `cf_${orderId}`,
          status: "captured",
          metadata: { tags },
        })
      } catch {
        // Unique constraint on cashfree_payment_id = already recorded
      }

      if (type === "credits") {
        const creditMicro = Math.round((order.order_amount ?? 0) * 100) * 10_000
        await db
          .update(billing)
          .set({
            balance: sql`${billing.balance} + ${creditMicro}`,
            timeUpdated: new Date(),
          })
          .where(eq(billing.workspaceId, workspaceId))
      }
      break
    }

    case "SUBSCRIPTION_NEW_ACTIVATION": {
      // Subscription activated — full plan price was charged upfront
      const sub = event.data?.subscription
      if (!sub) break

      const tags = sub.subscription_tags ?? {}
      const workspaceId = tags.workspaceId
      const userId = tags.userId
      const plan = tags.plan as "starter" | "pro" | "team"

      if (!workspaceId || !userId || !plan) break

      await db.insert(subscriptions).values({
        id: createId("sub"),
        workspaceId,
        userId,
        plan,
        cashfreeSubscriptionId: sub.subscription_id,
      }).onConflictDoNothing()

      await db
        .update(billing)
        .set({
          cashfreeSubscriptionId: sub.subscription_id,
          timeUpdated: new Date(),
        })
        .where(eq(billing.workspaceId, workspaceId))

      // Record the upfront subscription payment in history
      const planRow = await db.select().from(plans).where(eq(plans.id, plan)).then((r) => r[0])
      const bill = await db.select().from(billing).where(eq(billing.workspaceId, workspaceId)).then((r) => r[0])
      if (planRow && bill) {
        const currency = bill.currency ?? "INR"
        const prices = planRow.prices as Record<string, number> | null
        const amountSmallest = prices?.[currency] ?? 0
        try {
          await db.insert(payments).values({
            id: createId("pay"),
            workspaceId,
            userId,
            type: "subscription",
            amountSmallest,
            currency,
            cashfreePaymentId: `sub_upfront_${sub.subscription_id}`,
            status: "captured",
            metadata: { subscriptionId: sub.subscription_id, plan },
          })
        } catch {
          // Unique constraint — already recorded (e.g. by activate-subscription endpoint)
        }
      }

      break
    }

    case "SUBSCRIPTION_PAYMENT_SUCCESS": {
      // Recurring subscription payment succeeded
      const sub = event.data?.subscription
      if (!sub) break

      const tags = sub.subscription_tags ?? {}
      const workspaceId = tags.workspaceId

      if (!workspaceId) break

      // If there's a pending plan change, apply it now (downgrade at cycle end)
      const existingSub = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.cashfreeSubscriptionId, sub.subscription_id))
        .then((r) => r[0])

      if (existingSub?.pendingPlan) {
        await db
          .update(subscriptions)
          .set({
            plan: existingSub.pendingPlan as "starter" | "pro" | "team",
            pendingPlan: null,
            pendingPlanEffectiveAt: null,
          })
          .where(eq(subscriptions.id, existingSub.id))
      }

      break
    }

    case "SUBSCRIPTION_STATUS_CHANGE": {
      // Subscription status changed (activated, cancelled, completed, expired)
      const sub = event.data?.subscription
      if (!sub) break

      const status = sub.subscription_status
      const tags = sub.subscription_tags ?? {}
      const workspaceId = tags.workspaceId

      if (!workspaceId) break

      if (status === "ACTIVE") {
        // Treat as activation (same logic as SUBSCRIPTION_NEW_ACTIVATION)
        const userId = tags.userId
        const plan = tags.plan as "starter" | "pro" | "team"
        if (userId && plan) {
          await db.insert(subscriptions).values({
            id: createId("sub"),
            workspaceId,
            userId,
            plan,
            cashfreeSubscriptionId: sub.subscription_id,
          }).onConflictDoNothing()

          await db
            .update(billing)
            .set({
              cashfreeSubscriptionId: sub.subscription_id,
              timeUpdated: new Date(),
            })
            .where(eq(billing.workspaceId, workspaceId))
        }
      } else if (status === "CANCELLED" || status === "COMPLETED" || status === "EXPIRED") {
        await db
          .update(subscriptions)
          .set({ timeDeleted: new Date() })
          .where(eq(subscriptions.cashfreeSubscriptionId, sub.subscription_id))

        // Only clear billing's subscription ID if it still points to THIS subscription.
        // During upgrades, the old sub is cancelled but a new one may already be active.
        await db
          .update(billing)
          .set({
            cashfreeSubscriptionId: null,
            timeUpdated: new Date(),
          })
          .where(and(
            eq(billing.workspaceId, workspaceId),
            eq(billing.cashfreeSubscriptionId, sub.subscription_id),
          ))
      }

      break
    }
  }

  return c.json({ status: "ok" })
})

// ── Types ──

interface CashfreeWebhookEvent {
  type: string
  data: {
    order?: {
      order_id: string
      order_amount: number
      order_currency: string
      order_tags: Record<string, string>
    }
    payment?: {
      cf_payment_id: string
      payment_status: string
      payment_amount: number
    }
    subscription?: {
      subscription_id: string
      cf_subscription_id: string
      subscription_status: string
      subscription_tags: Record<string, string>
      plan_details?: { plan_id: string }
    }
  }
}
