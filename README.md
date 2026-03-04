# ClawfficeOpenClawPlugin

An OpenClaw native plugin that connects your AI agents to the [Clawffice](https://clawffice.com) dashboard — a pixel-art web dashboard for monitoring all your AI agents in one place.

## Why This Exists

ClawfficeMCP is a Cloudflare Worker remote MCP server, but OpenClaw doesn't support MCP properly. This plugin replaces ClawfficeMCP with a native OpenClaw plugin that hooks directly into the gateway lifecycle — providing automatic status reporting without relying on the agent to manually call tools.

## Installation

```bash
openclaw plugins install ./ClawfficeOpenClawPlugin
openclaw gateway restart
```

## Configuration

### 1. Plugin Config

Add the following to your `openclaw.json`:

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

| Key          | Required | Default    | Description                                  |
|-------------|----------|------------|----------------------------------------------|
| officeToken | Yes      | —          | Bearer token from your Clawffice dashboard   |
| agentName   | No       | "Skippy"   | Name your agent registers as                 |
| agentType   | No       | "openclaw" | Agent type identifier                        |

### 2. Environment Variables

Add these to your gateway environment:

```
CLAWFFICE_SUPABASE_URL=https://xxx.supabase.co
CLAWFFICE_SUPABASE_SERVICE_KEY=your-service-key
```

On macOS, set these in the LaunchAgent plist or via `launchctl setenv`:

```bash
launchctl setenv CLAWFFICE_SUPABASE_URL "https://xxx.supabase.co"
launchctl setenv CLAWFFICE_SUPABASE_SERVICE_KEY "your-service-key"
```

## How It Works

The plugin hooks into three OpenClaw gateway lifecycle events:

1. **`agent:bootstrap`** — When a new agent session starts, the plugin automatically registers (or reclaims) the agent in Supabase and injects the Clawffice Protocol into the agent's bootstrap instructions.

2. **`message:received`** — When an inbound message arrives, the plugin sets the agent status to "working" with a task description based on the message content. This happens automatically — no agent tool call needed.

3. **`message:sent`** — When the agent sends a response, the plugin resets status to "idle" and checks the mailbox for messages from the dashboard.

The agent also gets three tools for manual control when the automatic hooks aren't sufficient.

## Slash Command

### `/clawffice`

Returns the current agent status:

```
Clawffice Agent: Skippy | ID: abc-123 | Status: active
```

## Agent Tools

These tools are available to the AI agent during chat sessions:

### `clawffice_update_status`

Manually update your status in the dashboard.

| Parameter | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| task      | string | Yes      | What you're working on   |
| status    | string | Yes      | "idle", "working", "error" |

### `clawffice_check_mailbox`

Check for messages from your human in the Clawffice dashboard. Returns messages as JSON and clears the mailbox.

### `clawffice_get_info`

Get your agent info: agent_id, name, office_id, and dashboard URL.

## MCP vs Plugin Comparison

| Feature                    | ClawfficeMCP (MCP)              | ClawfficeOpenClawPlugin (Plugin)    |
|----------------------------|---------------------------------|-------------------------------------|
| Registration               | Agent calls `register_agent`    | Automatic on session bootstrap      |
| Status updates             | Agent calls `update_status`     | Automatic on message events + manual tool |
| Mailbox checking           | Agent calls `check_mailbox`     | Automatic on message:sent + manual tool  |
| Protocol injection         | MCP resource/prompt             | Appended to AGENTS.md bootstrap     |
| State persistence          | Per-connection only             | State file survives gateway restarts |
| Dependencies               | Cloudflare Worker + Supabase SDK| Zero external deps (fetch + stdlib) |
| Auth                       | Bearer token per-request        | Plugin config + env vars            |

## State Persistence

The plugin persists the agent ID to `~/.openclaw/workspace/.clawffice-state.json` so it survives gateway restarts without re-registration.

## Troubleshooting

- **"not configured"** — Check that `officeToken` is set in plugin config and both `CLAWFFICE_SUPABASE_URL` and `CLAWFFICE_SUPABASE_SERVICE_KEY` environment variables are set.
- **"User plan is unpaid"** — The Clawffice account associated with the office token has an unpaid plan.
- **Agent not appearing** — Run `/clawffice` to check status. Look at gateway logs for `[clawffice]` prefixed messages.
