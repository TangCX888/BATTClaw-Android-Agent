# 🦞 OpenClaw 0-1 Quick Installation Guide

[中文版本](./openclawConfig_zh-cn.md) | *English document translated by AI*

**This document records how to mount the Android Agent as a standard MCP service to OpenClaw**

<br>

## Phase 1: Project Build (Developer Mode)
Before integrating the project into OpenClaw, please ensure you have completed the basic environment setup according to the instructions in [README_en.md](../../README_en.md). Once the project runs normally locally, follow the steps below to mount the openclaw MCP/SKILL.

> [!TIP]
> **AI Automated Execution**: You can directly send this document to `openclaw` to let it execute it for you! If you are using CLI intelligent assistants like `claudecode` or `opencode`, you can also directly send this file to them to automatically complete all the remaining configuration steps.

<br>

## Phase 2: OpenClaw Plugin Preparation
Run the installation command in the terminal to add MCP communication capabilities to OpenClaw:
```bash
openclaw plugins install @aiwerk/openclaw-mcp-bridge
```
<br>

## Phase 3: Core Configuration File Injection
Open and modify `~/.openclaw/openclaw.json`.

### 1. Mount the Server
In `plugins.entries.openclaw-mcp-bridge.config.servers`, <text style=color:red>***fill in the compiled MCP file address***</text> and add:
```json
"battclaw": {
  "transport": "stdio",
  "command": "....../.nvm/versions/node/v24.11.1/bin/node",   // Write the node path, you can get it via `which node`
  "args": ["......../server/dist/modules/mcp/mcpServer.js"]   // Fill in the corresponding path
}
```
> [!IMPORTANT]
> - `command`: Must use the **absolute path** of Node (can be found via `which node`).
> - `args`: Must point to the full path of the compiled **mcpServer.js**.

### 2. Grant Tool Permissions
Add the `tools` configuration under the top-level node of the JSON, otherwise the AI cannot call tools:
```json
"tools": {
  "sandbox": {
    "tools": {
      "allow": ["group:openclaw", "mcp"]
    }
  }
}
```
<br>

## Phase 4: SKILL Enhancement
MCP provides underlying tools, but Skill injection can make the AI act more like an "Android Expert":
1. **Create SKILL**: Create `battclaw` in `~/.openclaw/skills`, place the [SKILL.md](SKILL.md) file from this folder inside, and refresh openclaw.
2. **Refresh Environment**:
```bash
openclaw gateway restart && openclaw dashboard
```
<br>

## Phase 5: Test and Use Your Android Assistant
*Please test directly in the openclaw chat dialog:*
1. Test if the installation was successful:
   > "Please list all the tools provided by the `battclaw` MCP server and help me check the currently connected Android device."
2. Start using:
   > "Please open Taobao on the phone and search for iphone 17"
