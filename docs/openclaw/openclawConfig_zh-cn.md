# 🦞 OpenClaw 0-1 小龙虾快速安装指南

[English Version](./openclawConfig_en.md)

**本文记录了如何将 Android Agent 作为一个标准的 MCP 服务挂载到 OpenClaw**

<br>

## Phase 1: 项目构建 (开发者模式)
在将项目集成到 OpenClaw 之前，请确保你已经按照 [README.md](../../README.md) 中的指引完成了基础环境调试。一旦项目可以在本地正常运行，即可按下述步骤进行 openclaw MCP/SKILL 挂载。

> [!TIP]
> **AI 自动化执行**：你可以直接将本文档发送给 `openclaw` 让他帮你执行！如果你正使用 `claudecode` 或 `opencode` 等 CLI 智能助手，也可以直接将本文件发给它，让它帮你自动完成剩下的所有配置步骤。

<br>

## Phase 2: OpenClaw 插件准备
在终端执行安装命令，为 OpenClaw 增加 MCP 通信能力：
```bash
openclaw plugins install @aiwerk/openclaw-mcp-bridge
```
<br>

## Phase 3: 核心配置文件注入
打开并修改 `~/.openclaw/openclaw.json`。

### 1. 挂载服务器
在 `plugins.entries.openclaw-mcp-bridge.config.servers` <text style=color:red>***填入 编译后 的 MCP 文件地址***</text> 添加：
```json
"battclaw": {
  "transport": "stdio",
  "command": "....../.nvm/versions/node/v24.11.1/bin/node",   // 写入 node 路径，可通过 which node 获取
  "args": ["......../server/dist/modules/mcp/mcpServer.js"]   // 填入对应位置
}
```
> [!IMPORTANT]
> - `command`: 必须使用 Node 的**绝对路径** (可通过 `which node` 查看)。
> - `args`: 必须指向编译后的 **mcpServer.js** 的全路径。

### 2. 解放工具权限
在 JSON 的顶级节点下增加 `tools` 配置，否则 AI 无法调用工具：
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

## Phase 4: SKILL 加强
MCP 提供了底层工具，但 Skill 注入能让 AI 表现得更像“安卓专家”：
1. **创建SKILL**：在 `~/.openclaw/skills` 中创建 battclaw 并将该文件夹下的 [SKILL.md](SKILL.md) 文件放入后刷新 openclaw。
2. **刷新环境**：
```bash
openclaw gateway restart && openclaw dashboard
```
<br>

## Phase 5: 测试与使用你的安卓助手
*请直接在 openclaw 对话框中进行以下测试：*
1. 测试是否安装成功：
   > “请列出 `battclaw` MCP 服务器提供的所有工具，并帮我查看当前连接的 Android 设备。”
2. 开始使用：
   > “请在手机上打开淘宝并搜索 iphone 17”
