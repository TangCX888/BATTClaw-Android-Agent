/**
 * ### 安全解析 JSON 字符串
 * 防止因非法 JSON 格式导致程序崩溃。
 * @param jsonString 要解析的 JSON 字符串
 * @param defaultValue 解析失败时的默认值 (可选)
 * @returns 解析后的对象或默认值/null
 */
export function safeParseJSON<T>(jsonString: string, defaultValue: T | null = null): T | null {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.error(`[JSON Parse Error]: ${error instanceof Error ? error.message : String(error)}`);
        return defaultValue;
    }
}
