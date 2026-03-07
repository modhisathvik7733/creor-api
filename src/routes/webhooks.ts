import { Hono } from "hono"
import { db } from "../db/client.ts"
import { billing, subscriptions, webhookEvents, payments, plans } from "../db/schema.ts"
import { eq, and, isNull, sql } from "drizzle-orm"
import { verifyWebhookSignature, updateSubscription, type LSWebhookEvent } from "../lib/lemonsqueezy.ts"
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

// ── Lemon Squeezy webhook handler ──

webhookRoutes.post("/lemonsqueezy", async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header("x-signature") ?? ""

  if (!verifyWebhookSignature(rawBody, signature)) {
    return c.json({ error: "Invalid signature" }, 400)
  }

  const eventName = c.req.header("x-event-name") ?? ""
  const event = JSON.parse(rawBody) as LSWebhookEvent
  const customData = event.meta?.custom_data ?? {}

  // Idempotency key
  const entityId = event.data?.id ?? "unknown"
  const eventKey = `${eventName}:${entityId}`

  if (!(await claimEvent(eventKey, eventName))) {
    return c.json({ status: "ok", note: "duplicate" })
  }

  switch (eventName) {
    case "order_created": {
      // One-time payment (credits) completed
      if (customData.type !== "credits") break

      const workspaceId = customData.workspaceId
      const userId = customData.userId
      const usdAmount = parseFloat(customData.usdAmount ?? "0")

      if (!workspaceId || usdAmount <= 0) break

      // Credit balance: USD amount → micro-units
      const creditMicro = Math.round(usdAmount * 100) * 10_000
      await db
        .update(billing)
        .set({
          balance: sql`${billing.balance} + ${creditMicro}`,
          timeUpdated: new Date(),
        })
        .where(eq(billing.workspaceId, workspaceId))

      // Record payment
      try {
        await db.insert(payments).values({
          id: createId("pay"),
          workspaceId,
          userId: userId ?? null,
          type: "credits",
          amountSmallest: Math.round(usdAmount * 100), // USD cents
          currency: "USD",
          lsOrderId: String(entityId),
          status: "captured",
          metadata: { customData },
        })
      } catch {
        // Unique constraint — already recorded
      }

      break
    }

    case "subscription_created": {
      // New subscription activated
      const workspaceId = customData.workspaceId
      const userId = customData.userId
      const planId = customData.plan as "starter" | "pro" | "team" | undefined

      if (!workspaceId || !userId || !planId) break

      const lsSubscriptionId = String(entityId)
      const attrs = event.data.attributes as Record<string, unknown>
      const customerId = attrs.customer_id ? String(attrs.customer_id) : null

      // Create subscription record
      await db.insert(subscriptions).values({
        id: createId("sub"),
        workspaceId,
        userId,
        plan: planId,
        lsSubscriptionId,
      }).onConflictDoNothing()

      // Update billing record
      await db
        .update(billing)
        .set({
          lsSubscriptionId,
          lsCustomerId: customerId,
          timeUpdated: new Date(),
        })
        .where(eq(billing.workspaceId, workspaceId))

      // Record subscription payment
      const plan = await db.select().from(plans).where(eq(plans.id, planId)).then((r) => r[0])
      if (plan) {
        const prices = plan.prices as Record<string, number> | null
        const amountSmallest = prices?.["USD"] ?? 0
        try {
          await db.insert(payments).values({
            id: createId("pay"),
            workspaceId,
            userId,
            type: "subscription",
            amountSmallest,
            currency: "USD",
            lsOrderId: `sub_${lsSubscriptionId}`,
            status: "captured",
            metadata: { subscriptionId: lsSubscriptionId, plan: planId },
          })
        } catch {
          // Already recorded
        }
      }

      break
    }

    case "subscription_updated": {
      // Plan change or billing update
      const lsSubscriptionId = String(entityId)
      const attrs = event.data.attributes as Record<string, unknown>
      const variantId = attrs.variant_id ? String(attrs.variant_id) : null

      if (!variantId) break

      // Look up which plan corresponds to this variant
      const matchingPlan = await db
        .select()
        .from(plans)
        .where(eq(plans.lsVariantId, variantId))
        .then((r) => r[0])

      if (matchingPlan) {
        await db
          .update(subscriptions)
          .set({ plan: matchingPlan.id as "starter" | "pro" | "team" })
          .where(and(
            eq(subscriptions.lsSubscriptionId, lsSubscriptionId),
            isNull(subscriptions.timeDeleted),
          ))
      }

      break
    }

    case "subscription_cancelled": {
      // User cancelled — enters grace period
      const lsSubscriptionId = String(entityId)
      const attrs = event.data.attributes as Record<string, unknown>
      const endsAt = attrs.ends_at ? new Date(attrs.ends_at as string) : null

      await db
        .update(subscriptions)
        .set({ graceUntil: endsAt })
        .where(and(
          eq(subscriptions.lsSubscriptionId, lsSubscriptionId),
          isNull(subscriptions.timeDeleted),
        ))

      break
    }

    case "subscription_expired": {
      // Grace period over — deactivate
      const lsSubscriptionId = String(entityId)

      await db
        .update(subscriptions)
        .set({ timeDeleted: new Date() })
        .where(and(
          eq(subscriptions.lsSubscriptionId, lsSubscriptionId),
          isNull(subscriptions.timeDeleted),
        ))

      // Clear billing subscription ID if it still points to this subscription
      await db
        .update(billing)
        .set({
          lsSubscriptionId: null,
          timeUpdated: new Date(),
        })
        .where(eq(billing.lsSubscriptionId, lsSubscriptionId))

      break
    }

    case "subscription_payment_success": {
      // Recurring/prorated charge succeeded — record payment
      const attrs = event.data.attributes as Record<string, unknown>
      const lsSubscriptionId = attrs.subscription_id ? String(attrs.subscription_id) : null
      const billingReason = attrs.billing_reason as string | undefined // "initial", "renewal", "updated"

      if (!lsSubscriptionId) break

      // Skip prorated upgrade invoices — we already record these in /change-plan
      if (billingReason === "updated") {
        console.log(`[webhook] Skipping subscription_payment_success for upgrade proration (billing_reason=updated)`)
        break
      }

      const sub = await db
        .select()
        .from(subscriptions)
        .where(and(
          eq(subscriptions.lsSubscriptionId, lsSubscriptionId),
          isNull(subscriptions.timeDeleted),
        ))
        .then((r) => r[0])

      if (sub) {
        // Use actual amount from LS webhook data when available, fall back to plan price
        let amountSmallest: number
        if (attrs.subtotal_usd !== undefined && attrs.subtotal_usd !== null) {
          amountSmallest = Number(attrs.subtotal_usd) // LS sends cents
        } else if (attrs.total_usd !== undefined && attrs.total_usd !== null) {
          amountSmallest = Number(attrs.total_usd)
        } else if (attrs.subtotal !== undefined && attrs.subtotal !== null) {
          amountSmallest = Number(attrs.subtotal)
        } else {
          const plan = await db.select().from(plans).where(eq(plans.id, sub.plan)).then((r) => r[0])
          const prices = plan?.prices as Record<string, number> | null
          amountSmallest = prices?.["USD"] ?? 0
        }

        try {
          await db.insert(payments).values({
            id: createId("pay"),
            workspaceId: sub.workspaceId,
            userId: sub.userId,
            type: "subscription",
            amountSmallest,
            currency: "USD",
            lsSubscriptionPaymentId: String(entityId),
            status: "captured",
            metadata: { subscriptionId: lsSubscriptionId, plan: sub.plan, billingReason },
          })
        } catch {
          // Already recorded
        }

        // Execute pending downgrade if scheduled
        if (sub.pendingPlan && sub.lsSubscriptionId) {
          const newPlan = await db
            .select()
            .from(plans)
            .where(eq(plans.id, sub.pendingPlan))
            .then((r) => r[0])

          if (newPlan?.lsVariantId) {
            try {
              // Change the variant on LS — no proration since this is at renewal
              await updateSubscription(sub.lsSubscriptionId, {
                variantId: newPlan.lsVariantId,
                disableProrations: true,
              })

              // Update local DB
              await db
                .update(subscriptions)
                .set({
                  plan: sub.pendingPlan as "starter" | "pro" | "team",
                  pendingPlan: null,
                  pendingPlanEffectiveAt: null,
                })
                .where(eq(subscriptions.id, sub.id))

              console.log(`[webhook] Executed pending downgrade: ${sub.plan} → ${sub.pendingPlan} for workspace ${sub.workspaceId}`)
            } catch (err) {
              console.error(`[webhook] Failed to execute pending downgrade for workspace ${sub.workspaceId}:`, err)
            }
          }
        }
      }

      break
    }

    case "subscription_payment_failed": {
      // Recurring charge failed — log for now
      console.warn(`[webhook] subscription_payment_failed: ${entityId}`)
      break
    }

    case "order_refunded": {
      // Credits refunded — deduct from balance
      const lsOrderId = String(entityId)

      const payment = await db
        .select()
        .from(payments)
        .where(eq(payments.lsOrderId, lsOrderId))
        .then((r) => r[0])

      if (payment && payment.type === "credits" && payment.status === "captured") {
        const debitMicro = payment.amountSmallest * 10_000
        await db
          .update(billing)
          .set({
            balance: sql`GREATEST(${billing.balance} - ${debitMicro}, 0)`,
            timeUpdated: new Date(),
          })
          .where(eq(billing.workspaceId, payment.workspaceId))

        await db
          .update(payments)
          .set({ status: "refunded" })
          .where(eq(payments.id, payment.id))
      }

      break
    }
  }

  return c.json({ status: "ok" })
})
