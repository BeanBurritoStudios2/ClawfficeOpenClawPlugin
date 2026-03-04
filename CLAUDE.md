# ClawfficeOpenClawPlugin — CLAUDE.md

## What You Are Building

An **OpenClaw plugin** that registers AI agents into the Clawffice dashboard (a pixel-art web dashboard at clawffice.com). This plugin mirrors the behavior of ClawfficeMCP — a Cloudflare Worker remote MCP server. Since OpenClaw does not support MCP properly, you are building a native plugin instead.

---

## What Is OpenClaw

OpenClaw is a personal AI assistant gateway. It runs on a local machine and routes messages from chat platforms (Discord, Telegram, WhatsApp, etc.) to AI agents (Claude, etc.). It has a plugin system for extending functionality.

Plugins are TypeScript files loaded at runtime via **jiti** (no build step needed). They run in-process with the OpenClaw Gateway.

---

## Plugin System Overview

### Entry Point

A plugin exports either a function or an object:

```ts
// Function form (used here):
export default function register(api: OpenClawPluginApi) {
  // register tools, hooks, commands, services
}

// OR object form:
export default {
  id: "clawffice",
  name: "Clawffice",
  register(api: OpenClawPluginApi) { ... }
};
```

### Plugin API (`api` object)

```ts
interface OpenClawPluginApi {
  pluginConfig: unknown;          // config from plugins.entries.clawffice.config
  config: OpenClawConfig;         // full OpenClaw config
  logger: Logger;                 // api.logger.info/warn/error/debug

  registerTool(tool: ToolDef, opts?: { optional?: boolean }): void;
  registerHook(event: string, handler: HookHandler, meta?: { name: string; description?: string }): void;
  registerCommand(cmd: CommandDef): void;
  registerService(svc: { id: string; start(): Promise<void>; stop(): Promise<void> }): void;
  registerGatewayMethod(name: string, handler: (opts: GatewayRequestHandlerOptions) => void): void;
  registerCli(fn: ({program}) => void, opts: { commands: string[] }): void;
  runtime: {
    tts: TTSRuntime;
    stt: STTRuntime;
  };
}
```

### Registering Agent Tools

Tools are functions exposed to the AI agent during chat sessions. The agent can call them.

```ts
api.registerTool({
  name: "clawffice_update_status",      // snake_case, must not conflict with core tools
  label: "Clawffice Update Status",
  description: "Update your status in the Clawffice dashboard",
  parameters: {                          // JSON Schema
    type: "object",
    properties: {
      task: { type: "string", description: "What you are working on" },
      status: { type: "string", enum: ["idle", "working", "error"] },
    },
    required: ["task", "status"],
  },
  async execute(_toolCallId: string, params: { task: string; status: string }) {
    // return tool result
    return {
      content: [{ type: "text" as const, text: "Status updated." }],
    };
  },
});
```

### Registering Hooks

Hooks are event handlers that fire on gateway lifecycle events.

```ts
api.registerHook(
  "agent:bootstrap",           // event name
  async (event) => {
    // event.type = "agent", event.action = "bootstrap"
    // event.sessionKey = unique session id
    // event.context.bootstrapFiles = WorkspaceBootstrapFile[]
    // event.context.workspaceDir = string
    // event.context.cfg = OpenClawConfig
    // event.messages = string[]  (push to send messages to user)
  },
  { name: "clawffice.bootstrap", description: "Register agent in Clawffice" }
);
```

**Event types you care about:**

1. **`agent:bootstrap`** — fires before workspace bootstrap files are injected into the agent. You can mutate `event.context.bootstrapFiles` to inject instructions.
   - `event.context.sessionKey` — session ID
   - `event.context.bootstrapFiles` — array of `WorkspaceBootstrapFile`
   - `event.context.workspaceDir` — path to workspace

2. **`message:received`** — fires when an inbound message arrives from any channel
   - `event.context.from` — sender ID
   - `event.context.content` — message text
   - `event.context.channelId` — "discord", "telegram", etc.
   - `event.context.conversationId` — chat/conversation ID
   - `event.sessionKey` — session ID

3. **`message:sent`** — fires when an outbound message is sent
   - `event.context.to` — recipient
   - `event.context.content` — message text
   - `event.context.success` — boolean
   - `event.sessionKey` — session ID

### WorkspaceBootstrapFile Type

```ts
type WorkspaceBootstrapFileName =
  | "AGENTS.md" | "SOUL.md" | "TOOLS.md" | "IDENTITY.md"
  | "USER.md" | "HEARTBEAT.md" | "BOOTSTRAP.md" | "MEMORY.md" | "memory.md";

type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;  // if set, overrides file content at path
  missing: boolean;
};
```

To inject instructions into every agent session, find the AGENTS.md entry in `bootstrapFiles` and append to its `content`:

```ts
api.registerHook("agent:bootstrap", async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;
  const files = event.context.bootstrapFiles as WorkspaceBootstrapFile[];
  const agentsMd = files.find(f => f.name === "AGENTS.md");
  if (agentsMd) {
    const fs = await import("fs");
    const existing = agentsMd.content ?? (agentsMd.missing ? "" : fs.readFileSync(agentsMd.path, "utf-8"));
    agentsMd.content = existing + "\n\n" + CLAWFFICE_PROTOCOL;
  }
}, { name: "clawffice.bootstrap" });
```

### Registering Auto-Reply Commands

Slash commands that execute without invoking the AI agent:

```ts
api.registerCommand({
  name: "clawffice",
  description: "Show Clawffice status",
  acceptsArgs: false,
  requireAuth: true,
  handler: async (ctx) => {
    return { text: `Clawffice: agentId=${...}` };
  },
});
```

---

## Plugin Manifest (openclaw.plugin.json)

Every plugin needs this file at the plugin root:

```json
{
  "id": "clawffice",
  "name": "Clawffice",
  "description": "Connects OpenClaw agents to the Clawffice dashboard",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "officeToken": { "type": "string" },
      "agentName": { "type": "string" },
      "agentType": { "type": "string" }
    }
  },
  "uiHints": {
    "officeToken": { "label": "Office Token", "sensitive": true },
    "agentName": { "label": "Agent Name" },
    "agentType": { "label": "Agent Type" }
  }
}
```

---

## What ClawfficeMCP Does (MCP equivalent you must replace)

The MCP (src/index.ts) does the following:

1. **On connect**: Injects INSTRUCTIONS into the agent, telling it to call `register_agent` immediately.
2. **`register_agent(name, agent_type)`**: Inserts a row in Supabase `agents` table.
3. **`reregister_agent(agent_id)`**: Reclaims existing agent row after session restart.
4. **`update_status(task, status)`**: Updates `task_description`, `status`, `last_heartbeat` on the agent row.
5. **`check_mailbox()`**: Reads and clears `mailbox` array on the agent row.

Auth flow: Bearer token → look up in `offices` table → get `office_id` → validate `users.plan_status != "unpaid"`.

---

## Supabase Schema (DO NOT MODIFY)

```sql
-- users
id UUID PK, clerk_id TEXT, email TEXT, plan_status TEXT DEFAULT 'unpaid', stripe_customer_id TEXT, created_at TIMESTAMPTZ

-- offices
id UUID PK, user_id UUID FK->users, name TEXT, slug TEXT UNIQUE, token TEXT UNIQUE DEFAULT gen_random_uuid(), created_at TIMESTAMPTZ

-- agents
id UUID PK, office_id UUID FK->offices, name TEXT, agent_type TEXT, status TEXT DEFAULT 'idle', task_description TEXT, mailbox JSONB DEFAULT '[]', last_heartbeat TIMESTAMPTZ, created_at TIMESTAMPTZ
```

`agent_type` values: `claudecode | claudedesktop | codex | geminicli | antigravity | kimicode | kilocode | cursor | windsurf | copilot | aider | roocode | cline | continue | goose | zed | opencode | openclaw | other`

`status` values: `idle | working | error`

`mailbox` format: `[{"from": "dashboard", "text": "...", "sent_at": "ISO8601"}]`

---

## Supabase HTTP API (use fetch, no SDK needed)

Set these headers on every request:
```
Authorization: Bearer {SUPABASE_SERVICE_KEY}
apikey: {SUPABASE_SERVICE_KEY}
Content-Type: application/json
Prefer: return=representation  (for INSERT/UPDATE that returns data)
```

Base URL: `{SUPABASE_URL}/rest/v1`

### Look up office by token:
```
GET /rest/v1/offices?token=eq.{token}&select=id,user_id
```

### Check user plan:
```
GET /rest/v1/users?id=eq.{user_id}&select=plan_status
```

### Find agent by name (find-or-create pattern):
```
GET /rest/v1/agents?office_id=eq.{office_id}&name=eq.{name}&select=id,name,status&order=created_at.desc&limit=1
```

### Insert new agent:
```
POST /rest/v1/agents
Body: { "office_id": "...", "name": "...", "agent_type": "openclaw", "status": "idle", "last_heartbeat": "ISO8601" }
Headers: Prefer: return=representation
```

### Update agent status:
```
PATCH /rest/v1/agents?id=eq.{agent_id}
Body: { "task_description": "...", "status": "...", "last_heartbeat": "ISO8601" }
Headers: Prefer: return=representation
```

### Get mailbox + clear it:
```
# Read
GET /rest/v1/agents?id=eq.{agent_id}&select=mailbox

# Clear
PATCH /rest/v1/agents?id=eq.{agent_id}
Body: { "mailbox": [] }
```

---

## Environment Variables

Credentials are provided via environment variables:
- `CLAWFFICE_SUPABASE_URL` — Supabase project URL (e.g. `https://xyz.supabase.co`)
- `CLAWFFICE_SUPABASE_SERVICE_KEY` — Supabase service role key

Plugin config (in `openclaw.json` under `plugins.entries.clawffice.config`):
- `officeToken` — the office bearer token from the Clawffice dashboard
- `agentName` — name to register as (default: "Skippy")
- `agentType` — agent type (default: "openclaw")

---

## CLAWFFICE_PROTOCOL constant (adapt for this plugin)

This is the protocol text that gets appended to AGENTS.md in the bootstrap hook:

```
## Clawffice Protocol

You are connected to Clawffice — a dashboard where your human monitors all their AI agents. These are your standing orders.

**You were automatically registered at session start. Use `clawffice_get_info` to retrieve your agent_id.**

### During Work
- Call `clawffice_update_status` EVERY time your state changes.
- Starting a task → status "working". Finished → status "idle". Error → status "error".
- Be specific in task descriptions: "Refactoring auth in src/api/auth.ts" not "Working".
- Do NOT batch status updates. Report immediately when state changes.

### End of Turn
Your turn is INCOMPLETE unless you:
1. Call `clawffice_update_status` with status "idle".
2. Call `clawffice_check_mailbox` to check for messages from your human.
3. If mailbox has messages: call `clawffice_update_status` with status "working", then read and act on them.

### Never
- Leave status as "working" when done.
- Use vague task descriptions.
- Skip `clawffice_check_mailbox` at end of turn.
```

---

## What The Plugin Must Build

### File Structure
```
ClawfficeOpenClawPlugin/
├── openclaw.plugin.json    # Plugin manifest
├── package.json            # { "name": "clawffice" }
├── index.ts                # Single plugin entry file (keep it in one file)
├── CLAUDE.md               # This file
└── README.md               # Setup + usage instructions
```

Keep everything in `index.ts` for simplicity (same convention as ClawfficeMCP's `src/index.ts`).

### index.ts Must:

1. **Read config**: `officeToken`, `agentName` (default "Skippy"), `agentType` (default "openclaw") from `api.pluginConfig`. Read `CLAWFFICE_SUPABASE_URL` and `CLAWFFICE_SUPABASE_SERVICE_KEY` from `process.env`.

2. **Session state map**: `Map<string, { agentId: string; agentName: string; officeId: string }>` keyed by `sessionKey`. Also persist `agentId` to a state file at `path.join(os.homedir(), ".openclaw", "workspace", ".clawffice-state.json")` for survival across gateway restarts.

3. **`agent:bootstrap` hook**:
   - Look up office by token in Supabase → get `office_id` (cache this in a module-level variable)
   - Find-or-create agent by `(office_id, agentName)` — do a GET first, then POST if not found
   - Store `{agentId, agentName, officeId}` in session map keyed by `event.sessionKey`
   - Persist agentId to state file
   - Append CLAWFFICE_PROTOCOL to AGENTS.md bootstrap content (find the AGENTS.md entry in bootstrapFiles and append to its content)

4. **`message:received` hook**:
   - Get agentId for session (fall back to state file agentId if session not in map)
   - Update status to "working", task = first 200 chars of message content (trimmed)
   - Fire and forget — wrap in void/catch, don't block message processing

5. **`message:sent` hook**:
   - Get agentId for session
   - Update status to "idle", task = ""
   - Check mailbox, log any messages with `api.logger.info`
   - Fire and forget

6. **Register tools** (always available, not optional):
   - `clawffice_update_status(task: string, status: "idle"|"working"|"error")` — manual status update, returns confirmation
   - `clawffice_check_mailbox()` — returns mailbox messages as JSON, clears the mailbox
   - `clawffice_get_info()` — returns current agentId, name, officeId, and dashboard URL constructed from office slug (look it up)

7. **`/clawffice` auto-reply command**:
   - Returns plain text: "Clawffice Agent: {name} | ID: {agentId} | Status: active"
   - Show "not configured" if credentials missing

8. **Service registration**:
   - On `start`: log validation status (are credentials present?)
   - On `stop`: clear session map

---

## Error Handling

- All Supabase calls wrapped in try/catch
- Errors in tools returned as `{ content: [{ type: "text", text: "Error: ..." }] }`
- Errors in hooks logged with `api.logger.warn(...)`, never thrown (don't block gateway)
- If credentials are missing, log a warning on service start and skip hook execution gracefully

---

## Code Style

- TypeScript (jiti loads it at runtime, no build step)
- No external dependencies — use built-in `fetch` (available in Node 18+) and `fs`/`os`/`path` from stdlib
- Use ES module `import` syntax
- Use `async/await` not `.then()`
- Type everything properly
- Keep it clean and readable

---

## README.md Must Include

1. What this is and why it exists (MCP doesn't work with OpenClaw)
2. Install steps:
   ```bash
   openclaw plugins install ./ClawfficeOpenClawPlugin
   openclaw gateway restart
   ```
3. Configuration — what to add to `openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "clawffice": {
           "enabled": true,
           "config": {
             "officeToken": "your-office-token-here",
             "agentName": "Skippy",
             "agentType": "openclaw"
           }
         }
       }
     }
   }
   ```
4. Environment variables — add to gateway environment:
   ```
   CLAWFFICE_SUPABASE_URL=https://xxx.supabase.co
   CLAWFFICE_SUPABASE_SERVICE_KEY=your-service-key
   ```
   On macOS, set these in the LaunchAgent plist or via `launchctl setenv`.
5. How it works: hook-based automatic reporting vs MCP's manual tool-call approach
6. Available slash command: `/clawffice`
7. Available agent tools: `clawffice_update_status`, `clawffice_check_mailbox`, `clawffice_get_info`
8. Comparison table: MCP vs Plugin approach

---

## Start Here

Build in this order:
1. `index.ts` — the full plugin
2. `openclaw.plugin.json` — manifest
3. `package.json` — minimal, just `{ "name": "clawffice", "type": "module" }`
4. `README.md` — docs for humans

Then: `git add -A && git commit -m "feat: initial ClawfficeOpenClawPlugin implementation" && git push`
