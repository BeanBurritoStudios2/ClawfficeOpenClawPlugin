import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginConfig {
  officeToken?: string;
  agentName?: string;
  agentType?: string;
}

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  messages: string[];
}

interface WorkspaceBootstrapFile {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
}

interface CommandContext {
  args?: string;
  sessionKey?: string;
}

interface OpenClawPluginApi {
  pluginConfig: unknown;
  config: unknown;
  logger: Logger;
  registerTool(tool: ToolDef): void;
  registerHook(event: string, handler: (event: HookEvent) => Promise<void>, meta?: { name: string; description?: string }): void;
  registerCommand(cmd: { name: string; description: string; acceptsArgs: boolean; requireAuth: boolean; handler: (ctx: CommandContext) => Promise<{ text: string }> }): void;
  registerService(svc: { id: string; start(): Promise<void>; stop(): Promise<void> }): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE_PATH = path.join(os.homedir(), ".openclaw", "workspace", ".clawffice-state.json");

const CLAWFFICE_PROTOCOL = `## Clawffice Protocol

You are connected to Clawffice — a dashboard where your human monitors all their AI agents. These are your standing orders.

**You were automatically registered at session start. Use \`clawffice_get_info\` to retrieve your agent_id.**

### During Work
- Call \`clawffice_update_status\` EVERY time your state changes.
- Starting a task → status "working". Finished → status "idle". Error → status "error".
- Be specific in task descriptions: "Refactoring auth in src/api/auth.ts" not "Working".
- Do NOT batch status updates. Report immediately when state changes.

### End of Turn
Your turn is INCOMPLETE unless you:
1. Call \`clawffice_update_status\` with status "idle".
2. Call \`clawffice_check_mailbox\` to check for messages from your human.
3. If mailbox has messages: call \`clawffice_update_status\` with status "working", then read and act on them.

### Never
- Leave status as "working" when done.
- Use vague task descriptions.
- Skip \`clawffice_check_mailbox\` at end of turn.`;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const sessions = new Map<string, { agentId: string; agentName: string; officeId: string }>();
let cachedOfficeId: string | null = null;
let cachedOfficeSlug: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnv(): { supabaseUrl: string; supabaseKey: string } | null {
  const supabaseUrl = process.env.CLAWFFICE_SUPABASE_URL;
  const supabaseKey = process.env.CLAWFFICE_SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return { supabaseUrl, supabaseKey };
}

function supabaseHeaders(key: string, prefer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    apikey: key,
    "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;
  return headers;
}

async function supabaseGet<T>(baseUrl: string, key: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}/rest/v1${path}`, {
    method: "GET",
    headers: supabaseHeaders(key),
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function supabasePost<T>(baseUrl: string, key: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/rest/v1${path}`, {
    method: "POST",
    headers: supabaseHeaders(key, "return=representation"),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function supabasePatch<T>(baseUrl: string, key: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/rest/v1${path}`, {
    method: "PATCH",
    headers: supabaseHeaders(key, "return=representation"),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

function loadStateFile(): { agentId?: string } {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_FILE_PATH, "utf-8"));
    }
  } catch {
    // ignore corrupt state
  }
  return {};
}

function saveStateFile(agentId: string): void {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify({ agentId }, null, 2));
  } catch {
    // best effort
  }
}

function getAgentId(sessionKey: string): string | null {
  const session = sessions.get(sessionKey);
  if (session) return session.agentId;
  const state = loadStateFile();
  return state.agentId ?? null;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const officeToken = cfg.officeToken;
  const agentName = cfg.agentName ?? "Skippy";
  const agentType = cfg.agentType ?? "openclaw";

  const credsMissing = !officeToken || !getEnv();

  // -------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------

  api.registerService({
    id: "clawffice",
    async start() {
      if (credsMissing) {
        api.logger.warn("[clawffice] Missing credentials — officeToken, CLAWFFICE_SUPABASE_URL, or CLAWFFICE_SUPABASE_SERVICE_KEY not set. Plugin will be inactive.");
      } else {
        api.logger.info("[clawffice] Service started. Credentials present.");
      }
    },
    async stop() {
      sessions.clear();
      cachedOfficeId = null;
      cachedOfficeSlug = null;
      api.logger.info("[clawffice] Service stopped. Session map cleared.");
    },
  });

  // -------------------------------------------------------------------------
  // Hook: agent:bootstrap
  // -------------------------------------------------------------------------

  api.registerHook(
    "agent:bootstrap",
    async (event: HookEvent) => {
      if (event.type !== "agent" || event.action !== "bootstrap") return;
      if (credsMissing) return;

      const env = getEnv()!;
      const sessionKey = event.sessionKey ?? (event.context.sessionKey as string);

      try {
        // Look up office by token (cached)
        if (!cachedOfficeId) {
          const offices = await supabaseGet<Array<{ id: string; user_id: string; slug: string }>>(
            env.supabaseUrl, env.supabaseKey,
            `/offices?token=eq.${officeToken}&select=id,user_id,slug`,
          );
          if (!offices.length) throw new Error("Office not found for token");

          const office = offices[0];
          cachedOfficeId = office.id;
          cachedOfficeSlug = office.slug;

          // Validate user plan
          const users = await supabaseGet<Array<{ plan_status: string }>>(
            env.supabaseUrl, env.supabaseKey,
            `/users?id=eq.${office.user_id}&select=plan_status`,
          );
          if (users.length && users[0].plan_status === "unpaid") {
            api.logger.warn("[clawffice] User plan is unpaid — registration skipped.");
            return;
          }
        }

        // Find or create agent
        const existing = await supabaseGet<Array<{ id: string; name: string; status: string }>>(
          env.supabaseUrl, env.supabaseKey,
          `/agents?office_id=eq.${cachedOfficeId}&name=eq.${encodeURIComponent(agentName)}&select=id,name,status&order=created_at.desc&limit=1`,
        );

        let agentId: string;
        if (existing.length) {
          agentId = existing[0].id;
          // Update heartbeat on re-registration
          await supabasePatch(env.supabaseUrl, env.supabaseKey, `/agents?id=eq.${agentId}`, {
            status: "idle",
            task_description: "",
            last_heartbeat: new Date().toISOString(),
          });
        } else {
          const created = await supabasePost<Array<{ id: string }>>(
            env.supabaseUrl, env.supabaseKey, "/agents",
            {
              office_id: cachedOfficeId,
              name: agentName,
              agent_type: agentType,
              status: "idle",
              last_heartbeat: new Date().toISOString(),
            },
          );
          agentId = created[0].id;
        }

        // Store session
        sessions.set(sessionKey, { agentId, agentName, officeId: cachedOfficeId });
        saveStateFile(agentId);
        api.logger.info(`[clawffice] Agent registered: ${agentName} (${agentId})`);

        // Inject protocol into AGENTS.md
        const files = event.context.bootstrapFiles as WorkspaceBootstrapFile[];
        const agentsMd = files.find((f) => f.name === "AGENTS.md");
        if (agentsMd) {
          const existingContent = agentsMd.content ?? (agentsMd.missing ? "" : fs.readFileSync(agentsMd.path, "utf-8"));
          agentsMd.content = existingContent + "\n\n" + CLAWFFICE_PROTOCOL;
        }
      } catch (err) {
        api.logger.warn(`[clawffice] Bootstrap error: ${err}`);
      }
    },
    { name: "clawffice.bootstrap", description: "Register agent in Clawffice dashboard" },
  );

  // -------------------------------------------------------------------------
  // Hook: message:received
  // -------------------------------------------------------------------------

  api.registerHook(
    "message:received",
    async (event: HookEvent) => {
      if (credsMissing) return;
      const env = getEnv()!;
      const agentId = getAgentId(event.sessionKey);
      if (!agentId) return;

      const content = (event.context.content as string) ?? "";
      const task = content.slice(0, 200).trim();

      // Fire and forget
      void supabasePatch(env.supabaseUrl, env.supabaseKey, `/agents?id=eq.${agentId}`, {
        status: "working",
        task_description: task,
        last_heartbeat: new Date().toISOString(),
      }).catch((err) => api.logger.warn(`[clawffice] message:received status update failed: ${err}`));
    },
    { name: "clawffice.message_received", description: "Update Clawffice status on inbound message" },
  );

  // -------------------------------------------------------------------------
  // Hook: message:sent
  // -------------------------------------------------------------------------

  api.registerHook(
    "message:sent",
    async (event: HookEvent) => {
      if (credsMissing) return;
      const env = getEnv()!;
      const agentId = getAgentId(event.sessionKey);
      if (!agentId) return;

      // Fire and forget
      void (async () => {
        try {
          await supabasePatch(env.supabaseUrl, env.supabaseKey, `/agents?id=eq.${agentId}`, {
            status: "idle",
            task_description: "",
            last_heartbeat: new Date().toISOString(),
          });

          // Check mailbox
          const rows = await supabaseGet<Array<{ mailbox: unknown[] }>>(
            env.supabaseUrl, env.supabaseKey,
            `/agents?id=eq.${agentId}&select=mailbox`,
          );
          if (rows.length && Array.isArray(rows[0].mailbox) && rows[0].mailbox.length > 0) {
            api.logger.info(`[clawffice] Mailbox messages: ${JSON.stringify(rows[0].mailbox)}`);
            await supabasePatch(env.supabaseUrl, env.supabaseKey, `/agents?id=eq.${agentId}`, {
              mailbox: [],
            });
          }
        } catch (err) {
          api.logger.warn(`[clawffice] message:sent hook error: ${err}`);
        }
      })();
    },
    { name: "clawffice.message_sent", description: "Reset Clawffice status on outbound message" },
  );

  // -------------------------------------------------------------------------
  // Tool: clawffice_update_status
  // -------------------------------------------------------------------------

  api.registerTool({
    name: "clawffice_update_status",
    label: "Clawffice Update Status",
    description: "Update your status in the Clawffice dashboard. Call this every time your state changes.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What you are currently working on" },
        status: { type: "string", enum: ["idle", "working", "error"], description: "Current status" },
      },
      required: ["task", "status"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const env = getEnv();
        if (!env) return { content: [{ type: "text", text: "Error: Clawffice credentials not configured." }] };

        // Try to find agentId from any session or state file
        let agentId: string | null = null;
        for (const session of sessions.values()) {
          agentId = session.agentId;
          break;
        }
        if (!agentId) agentId = loadStateFile().agentId ?? null;
        if (!agentId) return { content: [{ type: "text", text: "Error: No agent registered. Bootstrap has not run yet." }] };

        await supabasePatch(env.supabaseUrl, env.supabaseKey, `/agents?id=eq.${agentId}`, {
          task_description: params.task as string,
          status: params.status as string,
          last_heartbeat: new Date().toISOString(),
        });

        return { content: [{ type: "text", text: `Status updated: ${params.status} — "${params.task}"` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err}` }] };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: clawffice_check_mailbox
  // -------------------------------------------------------------------------

  api.registerTool({
    name: "clawffice_check_mailbox",
    label: "Clawffice Check Mailbox",
    description: "Check for messages from your human in the Clawffice dashboard. Always call this at the end of your turn.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const env = getEnv();
        if (!env) return { content: [{ type: "text", text: "Error: Clawffice credentials not configured." }] };

        let agentId: string | null = null;
        for (const session of sessions.values()) {
          agentId = session.agentId;
          break;
        }
        if (!agentId) agentId = loadStateFile().agentId ?? null;
        if (!agentId) return { content: [{ type: "text", text: "Error: No agent registered." }] };

        const rows = await supabaseGet<Array<{ mailbox: unknown[] }>>(
          env.supabaseUrl, env.supabaseKey,
          `/agents?id=eq.${agentId}&select=mailbox`,
        );

        const mailbox = rows.length && Array.isArray(rows[0].mailbox) ? rows[0].mailbox : [];

        // Clear mailbox
        if (mailbox.length > 0) {
          await supabasePatch(env.supabaseUrl, env.supabaseKey, `/agents?id=eq.${agentId}`, {
            mailbox: [],
          });
        }

        if (mailbox.length === 0) {
          return { content: [{ type: "text", text: "Mailbox is empty. No messages." }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(mailbox, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err}` }] };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: clawffice_get_info
  // -------------------------------------------------------------------------

  api.registerTool({
    name: "clawffice_get_info",
    label: "Clawffice Get Info",
    description: "Get your Clawffice agent info including agent_id, name, office_id, and dashboard URL.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const env = getEnv();
        if (!env) return { content: [{ type: "text", text: "Error: Clawffice credentials not configured." }] };

        let session: { agentId: string; agentName: string; officeId: string } | null = null;
        for (const s of sessions.values()) {
          session = s;
          break;
        }

        const agentId = session?.agentId ?? loadStateFile().agentId;
        if (!agentId) return { content: [{ type: "text", text: "Error: No agent registered." }] };

        // Look up slug if not cached
        if (!cachedOfficeSlug && session?.officeId) {
          try {
            const offices = await supabaseGet<Array<{ slug: string }>>(
              env.supabaseUrl, env.supabaseKey,
              `/offices?id=eq.${session.officeId}&select=slug`,
            );
            if (offices.length) cachedOfficeSlug = offices[0].slug;
          } catch {
            // non-critical
          }
        }

        const dashboardUrl = cachedOfficeSlug
          ? `https://clawffice.com/${cachedOfficeSlug}`
          : "https://clawffice.com";

        const info = {
          agentId,
          agentName: session?.agentName ?? agentName,
          officeId: session?.officeId ?? cachedOfficeId ?? "unknown",
          dashboardUrl,
        };

        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err}` }] };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Command: /clawffice
  // -------------------------------------------------------------------------

  api.registerCommand({
    name: "clawffice",
    description: "Show Clawffice agent status",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (_ctx: CommandContext) => {
      if (credsMissing) {
        return { text: "Clawffice: not configured — missing officeToken or environment variables." };
      }

      let agentId: string | null = null;
      let name = agentName;
      for (const session of sessions.values()) {
        agentId = session.agentId;
        name = session.agentName;
        break;
      }
      if (!agentId) agentId = loadStateFile().agentId ?? null;

      if (!agentId) {
        return { text: `Clawffice Agent: ${name} | ID: pending | Status: not yet registered` };
      }

      return { text: `Clawffice Agent: ${name} | ID: ${agentId} | Status: active` };
    },
  });
}
