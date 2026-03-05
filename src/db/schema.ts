import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"

// ── Workspaces ──

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
  timeDeleted: timestamp("time_deleted"),
})

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  users: many(users),
  keys: many(keys),
  billing: many(billing),
}))

// ── Users ──

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    authProvider: text("auth_provider", { enum: ["github", "google"] }).notNull(),
    authProviderId: text("auth_provider_id").notNull(),
    avatarUrl: text("avatar_url"),
    monthlyLimit: integer("monthly_limit"), // in INR (paise)
    monthlyUsage: bigint("monthly_usage", { mode: "number" }).default(0), // in micro-paise
    timeMonthlyUsageUpdated: timestamp("time_monthly_usage_updated"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeUpdated: timestamp("time_updated").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    uniqueIndex("users_email_workspace_idx").on(table.email, table.workspaceId),
    index("users_auth_provider_idx").on(table.authProvider, table.authProviderId),
  ],
)

export const usersRelations = relations(users, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [users.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── API Keys ──

export const keys = pgTable(
  "keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    key: text("key").notNull().unique(),
    timeUsed: timestamp("time_used"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [index("keys_workspace_idx").on(table.workspaceId)],
)

export const keysRelations = relations(keys, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [keys.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [keys.userId],
    references: [users.id],
  }),
}))

// ── Billing ──

export const billing = pgTable("billing", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id)
    .unique(),
  balance: bigint("balance", { mode: "number" }).notNull().default(0), // micro-paise
  monthlyLimit: integer("monthly_limit"), // in INR
  monthlyUsage: bigint("monthly_usage", { mode: "number" }).default(0),
  timeMonthlyUsageUpdated: timestamp("time_monthly_usage_updated"),
  razorpayCustomerId: text("razorpay_customer_id"),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  reloadEnabled: boolean("reload_enabled").default(false),
  reloadAmount: integer("reload_amount").default(500), // INR
  reloadTrigger: integer("reload_trigger").default(100), // INR threshold
  timeReloadLockedTill: timestamp("time_reload_locked_till"),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeUpdated: timestamp("time_updated").defaultNow().notNull(),
})

export const billingRelations = relations(billing, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [billing.workspaceId],
    references: [workspaces.id],
  }),
}))

// ── Subscriptions (Creor Pro) ──

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    plan: text("plan", { enum: ["starter", "pro", "team"] }).notNull(),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    rollingUsage: bigint("rolling_usage", { mode: "number" }).default(0),
    fixedUsage: bigint("fixed_usage", { mode: "number" }).default(0),
    timeRollingUpdated: timestamp("time_rolling_updated"),
    timeFixedUpdated: timestamp("time_fixed_updated"),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    index("subscriptions_workspace_user_idx").on(table.workspaceId, table.userId),
  ],
)

// ── Usage Tracking ──

export const usage = pgTable(
  "usage",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    keyId: text("key_id").references(() => keys.id),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cost: bigint("cost", { mode: "number" }).notNull().default(0), // micro-paise
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    index("usage_workspace_idx").on(table.workspaceId),
    index("usage_time_idx").on(table.timeCreated),
  ],
)

// ── Model Visibility (per workspace) ──

export const modelSettings = pgTable(
  "model_settings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    model: text("model").notNull(),
    disabled: boolean("disabled").default(false),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("model_settings_workspace_model_idx").on(
      table.workspaceId,
      table.model,
    ),
  ],
)

// ── Provider Credentials (BYOK) ──

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").notNull(),
    credentials: text("credentials").notNull(), // encrypted API key
    timeCreated: timestamp("time_created").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("provider_credentials_workspace_provider_idx").on(
      table.workspaceId,
      table.provider,
    ),
  ],
)

// ── Session Shares ──

export const shares = pgTable("shares", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  data: jsonb("data").notNull(), // session + messages + parts JSON
  timeCreated: timestamp("time_created").defaultNow().notNull(),
  timeDeleted: timestamp("time_deleted"),
})

// ── Webhook Events (idempotency) ──

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  timeCreated: timestamp("time_created").defaultNow().notNull(),
})

// ── Invites ──

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    timeCreated: timestamp("time_created").defaultNow().notNull(),
    timeAccepted: timestamp("time_accepted"),
    timeDeleted: timestamp("time_deleted"),
  },
  (table) => [
    uniqueIndex("invites_workspace_email_idx").on(table.workspaceId, table.email),
  ],
)
