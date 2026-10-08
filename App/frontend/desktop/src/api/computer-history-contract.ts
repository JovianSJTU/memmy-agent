import { z } from "zod";

export const ComputerHistoryPermissionsSchema = z.object({
  supported: z.boolean(),
  accessibility: z.boolean(),
  inputMonitoring: z.boolean(),
  platform: z.literal("windows").optional(),
  ready: z.boolean().optional(),
  reason: z.enum(["ready", "collector_unavailable", "authorization_required", "no_running_authorized_application", "settings_invalid", "discovery_failed"]).optional(),
}).strict();
export type ComputerHistoryPermissions = z.infer<typeof ComputerHistoryPermissionsSchema>;
export type ComputerHistoryPermission = "accessibility" | "inputMonitoring";
export function historyPermissionsReady(status?: ComputerHistoryPermissions): boolean {
  return !!status?.supported && (status.platform === "windows" ? status.ready === true : status.accessibility && status.inputMonitoring);
}
const WindowsSelectorSchema = z.object({ controlType: z.enum(["Edit", "Document"]), automationId: z.string() }).strict();
const WindowsDocumentSelectorSchema = z.union([WindowsSelectorSchema,
  z.object({ controlType: z.literal("Edit"), automationId: z.literal(""), scope: z.literal("vscode.editor") }).strict()]);
const WindowsAppRuleSchema = z.object({
  executable: z.string(), searchFields: z.array(WindowsSelectorSchema).optional(), documentRegions: z.array(WindowsDocumentSelectorSchema).optional(),
  sensitiveAutomationIds: z.array(z.string()).optional(),
}).strict();
export const WindowsHistorySettingsSchema = z.object({ version: z.literal(1), applications: z.array(WindowsAppRuleSchema), sensitiveAutomationIds: z.array(z.string()).optional(), deny: z.object({ executables: z.array(z.string()).optional() }).strict().optional(),
defaultApplicationBehavior: z.enum(["observe", "do_not_observe"]).optional(),
limits: z.object({ maxDepth: z.number(), maxNodes: z.number(), maxVisited: z.number(), maxTextChars: z.number(),
  maxNodeTextChars: z.number(), queryBudgetMs: z.number(), workerTimeoutMs: z.number() }).strict().optional() }).strict();
export const WindowsHistoryConfigurationSchema = z.object({ settings: WindowsHistorySettingsSchema,
  applications: z.array(z.object({ id: z.string(), name: z.string(), executable: z.string(), running: z.boolean(), supported: z.boolean(), allowed: z.boolean(), rule: WindowsAppRuleSchema.optional() }).strict()),
  permissions: ComputerHistoryPermissionsSchema }).strict();
export type WindowsHistoryConfiguration = z.infer<typeof WindowsHistoryConfigurationSchema>;
export type WindowsHistorySettings = z.infer<typeof WindowsHistorySettingsSchema>;

// The Computer History snapshot contract.
//
// This lives on its own, free of any browser dependency, so the agent that
// produces the snapshot can assert against the very schema the desktop client
// validates with. Keeping it inside the client meant the only way to check the
// contract was to import the browser bundle, and the two sides drifted twice
// before anything noticed.

export const ComputerHistoryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  applications: z.array(z.string()),
  summaryWindow: z.enum(["10min", "6h"]).nullable(),
  // Keep segments visible when neither metadata nor legacy citations prove coverage.
  coveredHistoryIds: z.array(z.string()).default([]),
  pinned: z.boolean(),
  eventStreamPath: z.string().nullable(),
  sourceType: z.enum(["captured", "rollup", "imported", "demo_fixture"]),
  createdAt: z.string(),
  // Left out of what the desktop client receives: the timeline never renders a
  // summary's body, and it was most of every response. The agent reads bodies
  // in process.
  markdown: z.string().optional(),
  filePath: z.string(),
  replayPlan: z.object({
    sourcePath: z.string(),
    sourceHash: z.string(),
    status: z.enum(["ready", "not_replayable"]),
    steps: z.array(z.string()),
    variables: z.array(z.string())
  }).nullable().optional()
}).strict();

export const ComputerHistoryWorkflowSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  markdown: z.string(),
  filePath: z.string(),
  sourceHistoryId: z.string().nullable()
}).strict();

// Exported so the agent can assert its snapshot still satisfies the contract
// this client enforces. The schema is strict, so a field added on one side and
// not the other breaks the page rather than being ignored.
export const ComputerHistorySnapshotSchema = z.object({
  observation: z.object({
    state: z.enum(["running", "paused", "stopped", "stopping", "failed"]),
    startedAt: z.string().nullable(),
    segmentId: z.string().nullable(),
    segmentStartedAt: z.string().nullable(),
    error: z.string().nullable(),
    narrationError: z.string().nullable(),
    narrationErrorCategory: z.literal("quota_exhausted").nullable().optional(),
    modelSource: z.enum(["account", "byok"]).nullable().optional(),
    permissions: ComputerHistoryPermissionsSchema.optional(),
  }).strict(),
  histories: z.array(ComputerHistoryEntrySchema),
  workflows: z.array(ComputerHistoryWorkflowSchema),
  privacy: z.object({
    screenshots: z.literal(false),
    audio: z.literal(false),
    rawRetentionHours: z.number(),
    markdownDirectory: z.string(),
    eventStreamDirectory: z.string(),

  }).strict()
}).strict();

// The app-icon route answers with one image rather than a snapshot, so it
// carries its own tiny schema next to the one it sits beside.
export const ApplicationIconSchema = z.object({
  icon: z.string().nullable()
}).strict();
