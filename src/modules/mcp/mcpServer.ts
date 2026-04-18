import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Writable } from "stream";
import { z } from "zod";

// 标记 MCP 模式，让 logger 走 stderr
process.env.MCP_MODE = 'true';

// 禁用 dotenvx / dotenv 的日志输出
process.env.DOTENV_CONFIG_QUIET = 'true';

// === stdout 隔离方案 ===
// 1. 保存原始的 stdout.write（用 bind 锁定 this，防止脱离 stdout 对象后 this 丢失）
const realStdoutWrite = process.stdout.write.bind(process.stdout);

// 2. 把 process.stdout.write 整个替换成 stderr.write
//    这样项目里所有的 console.log / process.stdout.write 都会走 stderr，不会污染 MCP 通道
process.stdout.write = process.stderr.write.bind(process.stderr) as any;

// 3. 给 MCP SDK 创建一个专用的输出流，它直接调用保存好的原始 write，绕过被劫持的 stdout
const mcpStdout = new Writable({
    write(chunk, encoding, callback) {
        realStdoutWrite(chunk, encoding as any, callback);
    }
});

/** ### MCP 服务启动
 * @description 暴露 Android Agent 核心功能供 MCP 客户端（如 Claude Code, OpenClaw）使用
 */
async function main() {
    // 延迟加载，确保上面的环境准备完毕
    const { StateManager } = await import("../stateManager/stateManager.js");
    const { readErrorLogs } = await import("../../utils/logger.js");
    type run_planner_result = any;
    type taskDetail = any;

    const server = new McpServer({
        name: "BATTCLAW-AndroidAgent-Server",
        version: "1.0.0",
    });

    const stateManager = StateManager.getInstance();

    // --- 工具 1: 启动任务 ---
    server.tool(
        "butt_android_run",
        "启动一个新的 Android Agent 任务。它会自动寻找并锁定一台空闲设备（物理机或虚拟机），根据你的需求进行规划并执行自动化操作。",
        {
            prompt: z.string().describe("描述你需要 Android Agent 执行的任务需求"),
        },
        async ({ prompt }) => {
            const result: run_planner_result = await stateManager.run_planner(prompt);
            
            if (result.state === "failure") {
                return {
                    content: [{
                        type: "text",
                        text: `❌ 启动失败: ${result.message}`
                    }],
                    isError: true
                };
            }
            
            // 此处 result.state 必为 "success"
            return {
                content: [{
                    type: "text",
                    text: `✅ 任务已成功启动。\n设备 ID: ${result.deviceId}\n状态: 执行中\n说明: 请稍后使用 butt_android_status 工具并传入设备 ID 来查询进度。`
                }]
            };
        }
    );

    // --- 工具 2: 查询任务状态 ---
    server.tool(
        "butt_android_status",
        "查询指定 Android 设备上当前任务的详细进度。包括任务状态（运行中/成功/失败）、已完成步骤的简要日志以及最终结论。如果有进行中的活动可以询问用户是否可以终止活动开始新活动。",
        {
            deviceId: z.string().describe("需要查询状态的 Android 设备 ID"),
        },
        async ({ deviceId }) => {
            const result: { state: "failure", message: string } | taskDetail = await stateManager.query_planner(deviceId);
            
            // 检查是否存在 taskDetail 特有的属性 'status' 来收窄类型
            if (!('status' in result)) {
                return {
                    content: [{ type: "text", text: `❌ 查询失败: ${result.message}` }],
                    isError: true
                };
            }
            
            // 到这里 result 自动被收窄为 taskDetail
            const task = result as taskDetail;

            // 返回详细的任务状态信息
            const statusInfo = [
                `设备 ID: ${task.deviceId}`,
                `任务状态: ${task.status}`,
                `当前进度: ${task.completionRate}`,
                `日志记录: \n${task.logs.slice(-5).join("\n") || "暂无日志"}`, // 返回最后 5 条日志
            ];

            if (task.result) {
                statusInfo.push(`最终结论: ${task.result}`);
            }

            return {
                content: [{
                    type: "text",
                    text: statusInfo.join("\n")
                }]
            };
        }
    );
    
    // --- 工具 3: 终止任务 ---
    server.tool(
        "butt_android_abort",
        "立即终止指定 Android 设备上正在运行的任务。用于在观察到 Agent 行为偏离预期或需要紧急停止时使用。",
        {
            deviceId: z.string().describe("需要终止任务的 Android 设备 ID"),
        },
        async ({ deviceId }) => {
            const result = await stateManager.abort_planner(deviceId);
            
            if (result.state === "failure") {
                return {
                    content: [{ type: "text", text: `❌ 终止失败: ${result.message}` }],
                    isError: true
                };
            }
            
            return {
                content: [{ type: "text", text: `✅ ${result.message}` }]
            };
        }
    );

    // --- 工具 4: 读取错误日志 ---
    server.tool(
        "butt_android_errorLog",
        "读取 Android Agent 最近记录的 50 条错误日志。用于排查系统异常、任务失败原因或调试内部错误。",
        {},
        async () => {
            const logs = await readErrorLogs();
            if (logs.length === 0) {
                return {
                    content: [{ type: "text", text: "📭 目前没有任何错误日志。" }]
                };
            }

            // 固定读取最近的 50 条
            const recentLogs = logs.slice(-50);
            
            const formattedLogs = recentLogs.map(log => {
                const date = new Date(log.timestamp).toLocaleString();
                return `[${date}] ${log.message}`;
            }).join("\n");

            return {
                content: [{
                    type: "text",
                    text: `* 当前时间： ${new Date().toLocaleString} \n* 查找到最近 ${recentLogs.length} 条错误日志：\n\n${formattedLogs}`
                }]
            };
        }
    );

    // --- 工具 5: 列出所有设备及其任务状态 ---
    server.tool(
        "butt_android_listDevices",
        "获取所有已连接的安卓设备（包括物理真机和红机虚拟机）的列表。展示设备型号、状态以及当前正在执行的任务进度。",
        {},
        async () => {
            const devices = await stateManager.query_devices();
            
            if (devices.length === 0) {
                return {
                    content: [{ type: "text", text: "📭 目前没有检测到任何已连接的安卓设备。" }]
                };
            }

            const deviceList = devices.map(d => {
                const icon = d.type === 'physical' ? '📱' : '🖥️';
                const status = d.isReady ? '✅ 在线' : '⏳ 离线/启动中';
                const aliasStr = d.alias ? ` (${d.alias})` : '';
                
                let taskInfo = '\n   └─ 状态: 💤 空闲';
                if (d.currentTask) {
                    const taskStatus = d.currentTask.status === 'running' ? '🔥 正在执行' : '🏁 已结束';
                    taskInfo = `\n   └─ 任务: ${taskStatus}\n   └─ 进度: ${d.currentTask.completionRate}\n   └─ 指令: ${d.currentTask.prompt}`;
                }

                return `${icon} [${d.id}] ${d.model}${aliasStr}\n   └─ 连接: ${status}${taskInfo}`;
            }).join('\n\n');

            return {
                content: [{
                    type: "text",
                    text: `📱 当前安卓设备全景图：\n\n${deviceList}`
                }]
            };
        }
    );

    // 连接到 stdio 传输（使用专用的 mcpStdout，确保协议消息走真正的 stdout）
    const transport = new StdioServerTransport(process.stdin, mcpStdout);
    await server.connect(transport);
    
}

main().catch((error) => {
    console.error("MCP Server 崩溃:", error);
    process.exit(1);
});
