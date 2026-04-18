import fs from 'fs'
import path from 'path'
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';


/**
 * ### 统一日志调度助手
 * 旨在规范全项目的输出。
 * @param message 日志内容
 * @param options 配置项
 * @param options.error 是否为错误日志 (默认 false，为 true 时显示红色且始终打印)
 * @param options.debug 是否为调试日志 (默认 true，为 true 时仅在 process.env.DEBUG === 'true' 时打印)
 */
export function logger(message: string, options?: { error?: boolean, debug?: boolean }) {
    const isDebugMode = process.env.DEBUG === 'true';

    // MCP 模式下所有输出走 stderr，防止污染 stdout 的 JSON-RPC 通道
    const isMcpMode = process.env.MCP_MODE === 'true';
    const print = isMcpMode ? console.error : console.log;

    // 默认值处理：如果没传 options，则默认为 debug 日志且非 error
    const isError = options?.error || false;
    const isDebug = options?.debug ?? true;

    // 1. 如果是调试日志 (默认)，且环境未开启调试模式，则直接返回不打印
    if (isDebug && !isDebugMode) {
        return;
    }

    // 2. 如果是错误日志，则打印红色，并写入错误日志
    if (isError) {
        print(`\x1b[31m${message}\x1b[0m`);
        writeLog(message, 'stderr');
    } else {
        // 3. 正常打印 (非 error 的 debug 日志 或 debug: false 的业务日志)
        print(message);
        writeLog(message, 'stdout');
    }

}


/** ### 写入日志 */
function writeLog(message: string, type: 'stdout' | 'stderr') {
    try {
        // 检查 log 文件是否存在并创建
        let logDirPath = path.join(process.cwd(), 'log')
        if (!fs.existsSync(logDirPath)) {
            fs.mkdirSync(logDirPath, { recursive: true })
        }

        // 根据类型决定文件名
        const fileName = type === 'stderr' ? 'error.log' : 'log.log';
        const oldFileName = type === 'stderr' ? 'error.old.log' : 'log.old.log';
        
        const targetLogPath = path.join(logDirPath, fileName);
        const oldLogPath = path.join(logDirPath, oldFileName);

        // 当文件大于 100kb 时放入历史记录
        if (fs.existsSync(targetLogPath) && fs.statSync(targetLogPath).size > (1024 * 100)) {
            fs.renameSync(targetLogPath, oldLogPath);
        }

        // 写入内容 (JSONL 格式)
        const logEntry = JSON.stringify({
            timestamp: Date.now(),
            level: type === 'stderr' ? 'ERROR' : 'INFO',
            message: message
        });

        fs.appendFileSync(targetLogPath, logEntry + '\n');
    } catch (err) {
        console.error('日志系统异常，ERROR:', err)
    }
}

/**
 * ### 读取错误日志
 * 自动拼接旧日志 (error.old.log) 和新日志 (error.log)
 * @returns 返回解析后的 JSON 对象数组
 */
export async function readErrorLogs(): Promise<any[]> {
    const logDirPath = path.join(process.cwd(), 'log');
    const oldLogPath = path.join(logDirPath, 'error.old.log');
    const newLogPath = path.join(logDirPath, 'error.log');

    let logs: any[] = [];

    const parseLogFile = (filePath: string) => {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim() !== '');
            for (const line of lines) {
                const entry = safeJsonParse(line);
                if (entry) {
                    logs.push(entry);
                }
            }
        }
    };

    // 先读旧的，后读新的
    parseLogFile(oldLogPath);
    parseLogFile(newLogPath);

    return logs;
}

/**
 * ### 安全解析 JSON
 * @param text 
 * @returns 
 */
function safeJsonParse(text: string): any {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}