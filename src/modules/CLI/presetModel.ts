/** @预设模型 */
export const presetModel: Record<string, { modelName: string[], baseUrl: string }> = {
    gemini: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        modelName: [
            "gemini-3-flash-preview",
            "gemini-3.1-flash-lite-preview"
        ]
    },
    kimi: {
        baseUrl: "https://api.moonshot.cn/v1",
        modelName: [
            "kimi-k2.5"
        ]
    },
    minimax: {
        baseUrl: "https://api.minimax.chat/v1",
        modelName: [
            "MiniMax-M2.7"
        ]
    }
}