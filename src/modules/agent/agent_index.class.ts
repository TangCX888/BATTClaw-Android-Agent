import { streamText, generateText, generateObject, tool, type GenerateTextResult, type ModelMessage } from 'ai';
import { z } from 'zod';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { AndroidAgent } from './adb/tools/AndroidAgent.class.js';
import { createVertex } from '@ai-sdk/google-vertex';
import { BaseModule } from './adb/tools/BaseModule.class.js';
import { createAdbTools } from './adb/adb.tools.js';
import { createPlanTools } from './role/role_tool/plan.tool.js';
import { parseFunctionCall, executeAction, getFunctionDefinitions_executor, getFunctionDefinitions_restorer, getFunctionCallingPrompt_plan } from './stream_parser.js';
import { getGeneratedPrompt } from './role/role_prompt/prompts.generated.js';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import proxyHelper from '../../utils/proxy_helper.js';
import { logger } from '../../utils/logger.js';
import Settings from '../setting/settings.js';


/**
 * 审计失败错误类
 * @description 当任务审计未通过时抛出此错误，包含审计建议和结果。
 */
export class AuditFailedError extends Error {
    /** 审计结果详情 */
    public inspectorResult: any;
    constructor(inspectorResult: any) {
        super(`[审计拦截] 上一任务审计未通过: ${inspectorResult.text || '无建议'}`);
        this.inspectorResult = inspectorResult;
        this.name = 'AuditFailedError';
    }
}

/** 
 * Agent 运行结果接口
 * @description 结合了 AI SDK 的原生响应与业务系统的清洗逻辑。
 */
export interface new_agent_run_result {
    /** AI 生成的纯文本回复内容 */
    text: string;
    /** 
     * 清洗后的消息历史记录
     * 仅包含：user (截图指令), assistant, 及 tool 原始响应。
     */
    history: ModelMessage[];
    /** 本轮触发的所有工具调用原始对象 (仅执行模式提供) */
    toolCalls?: any[];
    /** 工具执行后的原始结果汇总 (仅执行模式提供) */
    toolResults?: any[];
    /** 解析出的结构化任务列表 (仅规划模式提供) */
    taskList?: { description: string, id: string, role: 'executor' | 'restorer', level: number }[];
    /** 本次请求的 Token 消耗统计 */
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    /** AI 响应的中止原因（如 'stop' 或 'tool-calls'） */
    finishReason: string;
    /** 当前最新的屏幕截图路径，供后续审计环节使用 */
    imagePath?: string;
    /** 完整的 AI SDK 原始响应对象 */
    response: any;
}

/**
 * 模型运行配置参数
 */
export interface new_agent_run_params {
    /** 请求的起始提示词 (必填) */
    input: string;
    /** 是否在请求中附带当前屏幕结构及截图 (必填) */
    sendState: boolean;
    /** 目标设备客户端实例 (必填) */
    device: DeviceClient;
    /** 操作后的等待时间，单位毫秒 (默认: 500) */
    waitingTime?: number;
    /** 本次请求的超时时间，覆盖类默认设置 */
    timeout?: number;
    /** 历史对话记录，用于构建上下文 */
    history?: any[];
    /** HTTP 代理地址 */
    http_proxy?: string;
    /** HTTPS 代理地址 */
    https_proxy?: string;
    /** 发送请求时附带的本地图片绝对路径数组 */
    images?: string[];
    /** 已成功的操作记录与收集到的数据总结 */
    successHistory?: string[];
    /** 统筹员或修补员专用的引导提示词 */
    promptText?: string;
    /** 标识当前是否为任务流的最后一步 */
    isLastStep?: boolean;
    /** 用于投机执行的审计异步状态 */
    auditPromise?: Promise<any>;
    /** 请求中断信号 */
    signal?: AbortSignal;
}

/** ### 不同 AI 角色对应的参数映射表 */
export type ChatParamsMap = {
    /** 运行助手 (run): 负责分析截图并执行具体的单步 ADB 操作 */
    run: new_agent_run_params;
    /** 计划助手 (plan): 负责接收用户需求并拆分为有序的任务清单 */
    plan: new_agent_run_params;
    /** 统筹助手 (coordinator): 负责任务执行后的数据汇总、逻辑闭环及结果输出 */
    coordinator: new_agent_run_params & {
        /** 由外部统等生成的汇总引导提示词 */
        promptText: string;
        /** 是否为总流程的最后一步 */
        isLastStep: boolean
    };
    /** 修补助手 (restorer): 负责故障诊断、环境修复及全局计划重塑 */
    restorer: new_agent_run_params & {
        /** 包含故障背景信息和修复目标的提示词 */
        promptText: string
    };
    /** 检查员 (inspector): 负责对子任务执行结果进行“视觉+历史”双重审计 */
    inspector: new_agent_run_params & {
        /** [必填] 任务清单：当前计划中的全量任务列表 (作为审计背景) */
        allTaskList: any[];
        /** [必填] 上一任务：本次待检查的子任务具体内容 */
        lastTask: string;
        /** [必填] 上一任务限制：该任务开始前给予执行员的操作提示与限制条件 */
        lastTaskInstructions: string;
    };
    /** 需求分析 (beforePlanning): 负责对原始需求进行过滤、纠错与多任务拆分 */
    beforePlanning: new_agent_run_params;
};

/**
 * ### agent_Index: 高度封装的任务执行器
 * 支持单步执行模式，自动处理 UI 状态捕获与工具初始化。
 */
export class agent_Index {
    private model: any;
    private defaultTimeout: number = 90;
    /** 环境是否已就绪（缓存自检结果，避免每轮循环重复扫描） */
    private isEnvironmentReady: boolean = false;
    /** 当前激活的模型名称（仅用于日志打印） */
    private currentModelName: string = '';
    /** 当前激活的模型系列 */
    private modelFamily: string = '';
    /** ### 制定计划的基本规定 */
    private PlanRegulations: string = '';
    /** ### 计划者、修补者共享函数调用提示词 */
    private functionCalling_plan: string = ''
    /** ### 审计确认状态 (本实例生命周期内只需通过一次即可) */
    private isAuditConfirmed: boolean = false;
    /** ### 系统设置实例 (用于读取代理、语言等) */
    private settings: Settings | null = null;
    /** ### 代理配置缓存 */
    private proxyConfig: { enable: boolean, path: string } = { enable: false, path: '' };

    /** 获取当前激活的模型名称 (用于日志打印) */
    public getCurrentModelName(): string {
        return this.currentModelName;
    }

    /** ### 🤖 初始化新版 Agent 实例
     * 内部构造函数，建议使用静态方法 `agent_Index.create()` 进行初始化。
     */
    constructor(modelFamily: string, modelName: string, apiKey: string, baseUrl?: string, settings?: Settings) {
        this.settings = settings || null;
        if (this.settings) {
            this.proxyConfig = this.settings.setting.proxy || { enable: false, path: '' };
        }

        // 处理核心模型初始化
        switch (modelFamily) {
            case 'gemini':
                // 特殊逻辑：探测是否通过 OpenAI 桥接使用 Gemini
                if (baseUrl && baseUrl.includes('/openai')) {
                    this.model = (createOpenAI as any)({
                        apiKey,
                        baseURL: baseUrl,
                        compatibility: 'compatible',
                    }).chat(modelName);
                } else {
                    this.model = createGoogleGenerativeAI({
                        apiKey,
                        baseURL: baseUrl || undefined,
                    })(modelName);
                }
                break;
            case 'vertex':
                this.model = createVertex({
                    project: process.env.VERTEX_PROJECT,
                    location: process.env.VERTEX_LOCATION,
                })(modelName);
                break;
            case 'openai':
                this.model = createOpenAI({
                    apiKey,
                    baseURL: baseUrl || undefined,
                })(modelName);
                break;
            case 'deepseek':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://api.deepseek.com/v1',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            case 'zhipu':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            case 'moonshot':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://api.moonshot.cn/v1',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            case 'doubao':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            case 'qwen':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            case 'minimax':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://api.minimax.chat/v1',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            case 'github':
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || 'https://models.github.ai/inference',
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
            default:
                // 通用兜底模式 (OpenAI 兼容框架)
                this.model = (createOpenAI as any)({
                    apiKey,
                    baseURL: baseUrl || undefined,
                    compatibility: 'compatible',
                }).chat(modelName);
                break;
        }

        this.currentModelName = modelName;
        this.modelFamily = modelFamily;
        this.functionCalling_plan = getFunctionCallingPrompt_plan();
    }

    /** ### 🚀 异步创建 Agent 实例 (工厂方法)
     * @description 该方法会自动加载系统设置，校验模型配置，并根据当前激活的模型状态初始化 Agent。
     */
    public static async create(): Promise<agent_Index> {
        const settings = await Settings.create();
        const active = settings.setting.activeModel;
        const lang = settings.setting.language;

        // 1. 配置基础存在性校验 (i18n)
        if (!active || !active.modelFamily || !active.modelName) {
            const errorMsg = lang === 'zh-CN'
                ? " 未检测到有效的大模型配置，请前往 [设置 -> 模型选择] 进行配置。"
                : " No valid AI model configuration detected. Please go to [Settings -> Select Model] to configure it.";
            throw new Error(errorMsg);
        }

        // 2. 深度有效性校验: 检查 API Key
        if (!active.apikey || active.apikey.trim().length < 5) {
            const errorMsg = lang === 'zh-CN'
                ? `❌ 模型 [${active.name}] 的 API Key 无效或未设置，请在设置中更新。`
                : `❌ The API Key for model [${active.name}] is invalid or not set. Please update in settings.`;
            throw new Error(errorMsg);
        }

        // 3. 深度有效性校验: 检查 Base URL (针对需要网络请求的非 Vertex 型模型)
        if (active.modelFamily !== 'vertex' && active.baseUrl) {
            // 【优化】：支持 localhost 等省略协议头的写法，自动补齐 http:// 以便校验和向下游传递
            let normalizedUrl = active.baseUrl.trim();
            if (!normalizedUrl.includes('://')) {
                normalizedUrl = 'http://' + normalizedUrl;
                active.baseUrl = normalizedUrl; // 同步更新，确保后续 constructor 拿到的是完整 URL
            }

            try {
                // 简单的 URL 格式预检
                new URL(normalizedUrl);
            } catch (e) {
                const errorMsg = lang === 'zh-CN'
                    ? `❌ 模型 [${active.name}] 的接口地址 (Base URL) 格式错误: "${active.baseUrl}"。请前往设置修改为正确的 URL 格式 (例如 http://localhost:11434 或 https://api.openai.com/v1)。`
                    : `❌ Invalid Base URL format for model [${active.name}]: "${active.baseUrl}". Please update to a correct URL format (e.g., http://localhost:11434 or https://api.openai.com/v1).`;
                throw new Error(errorMsg);
            }
        }

        // 4. 实例化并返回
        return new agent_Index(
            active.modelFamily,
            active.modelName,
            active.apikey,
            active.baseUrl || undefined,
            settings
        );
    }



    /* 

            @备份配置请勿删除

            switch (modelFamily) {
        case 'gemini':
            this.model = createGoogleGenerativeAI({
                apiKey,
                baseURL: process.env.AGENT_BASE_URL || undefined,
            })(modelName);
            break;
        case 'vertex':
            this.model = createVertex({
                project: process.env.VERTEX_PROJECT,
                location: process.env.VERTEX_LOCATION,
            })(modelName);
            break;
        case 'openai':
            this.model = createOpenAI({
                apiKey,
                baseURL: process.env.AGENT_BASE_URL || undefined,
            })(modelName);
            break;
        case 'deepseek':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://api.deepseek.com/v1',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        case 'zhipu':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://open.bigmodel.cn/api/paas/v4',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        case 'moonshot':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://api.moonshot.cn/v1',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        case 'doubao':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        case 'qwen':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        case 'minimax':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://api.minimax.chat/v1',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        case 'github':
            this.model = (createOpenAI as any)({
                apiKey,
                baseURL: 'https://models.github.ai/inference',
                compatibility: 'compatible',
            }).chat(modelName);
            break;
        default:
            throw new Error(`暂不支持 ${modelFamily}`)
    }
    
     */



    /** ## 统一 AI 对话入口 (Chat Entry)
     * 该方法是所有 AI 任务（执行、规划、统筹、修补）的统筹核心。
     * 它通过 `AbortController` 监控请求耗时，并自动处理网络抖动导致的失败。
     * 
     * @param role - **可调用的 AI 角色:**
     *   - `run`: **执行员**。负责单步 ADB 操作输出，实时分析屏幕截图。
     *   - `plan`: **规划员**。负责任务拆解，将用户大目标分解为有序的任务列表。
     *   - `coordinator`: **统筹员**。负责多步任务后的数据汇总、逻辑闭环及结果输出。
     *   - `restorer`: **修补员**。负责故障自检、环境修复及计划重塑。
     *   - `inspector`: **检查员**。负责对子任务的完成情况进行视觉与逻辑审计。
     * 
     * @param params - **扁平化运行配置 (Essential Configuration):**
     *   - 包含 `input`, `device`, `sendState` 等基础参数。
     *   - 针对 `coordinator` 角色，额外包含 `promptText`, `isLastStep`。
     *   - 针对 `restorer` 角色，额外包含 `promptText`。
     *   - 针对 `inspector` 角色，使用 `input` 传递用户总需求，`promptText` 传递上一任务报备，并额外包含 `allTaskList`, `lastTask`, `lastTaskInstructions`。
     * 
     * @returns **一致化的角色结果对象:**
     *   - 成功：返回对应角色的具体结果。
     *   - 最终超时：不抛出异常，而是返回带有 `otherStop` 或 `stop` 标志的友好说明对象。
     */
    /** ### 统一 AI 对话入口 (Chat Entry)
     * 自动处理网络环境适配（代理）、请求监控及重试逻辑。
     */
    async chat<T extends keyof ChatParamsMap>(
        role: T,
        params: ChatParamsMap[T]
    ): Promise<any> {
        // --- 核心集成：全角色自动代理应用 ---
        const startChatTask = () => this._chatBase(role, params);

        if (this.proxyConfig.enable && this.proxyConfig.path) {
            logger(`[agent_Index] 正在通过全局代理执行任务: ${this.proxyConfig.path}`, { debug: true });
            return await proxyHelper.useProxy(startChatTask, {
                http_proxy: this.proxyConfig.path,
                https_proxy: this.proxyConfig.path
            });
        }

        return await startChatTask();
    }

    /** 内部私有的基础对话实现 (包含重试与超时控制) */
    private async _chatBase<T extends keyof ChatParamsMap>(
        role: T,
        params: ChatParamsMap[T]
    ): Promise<any> {
        let retryCount = 0;
        const maxRetries = 3;
        const runParams = params as new_agent_run_params;
        const timeoutSeconds = runParams.timeout || this.defaultTimeout;

        if (!this.model) {
            throw new Error(`[agent_Index] 大模型未初始化，请检索 create() 方法。`);
        }

        while (retryCount < maxRetries) {
            const externalSignal = (runParams as any).signal;
            const controller = new AbortController();
            
            // 如果外部传入了 signal (来自 StateManager)，则监听它的中止事件来同步中止内部控制器
            if (externalSignal) {
                if (externalSignal.aborted) throw new Error('AbortError');
                externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
            }

            const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

            try {
                let result;
                switch (role) {
                    case 'run':
                        result = await this.run(runParams, controller.signal);
                        break;
                    case 'plan':
                        result = await this.plan(runParams, controller.signal);
                        break;
                    case 'coordinator': {
                        const p = params as new_agent_run_params & { promptText: string; isLastStep: boolean };
                        result = await this.coordinator_run(p.promptText, p.isLastStep, p, p.history || [], controller.signal);
                        break;
                    }
                    case 'restorer': {
                        const p = params as new_agent_run_params & { promptText: string };
                        result = await this.restorer(p.promptText, p, controller.signal);
                        break;
                    }
                    case 'inspector': {
                        const p = params as ChatParamsMap['inspector'];
                        result = await this.inspector(p, p.allTaskList, p.lastTask, p.lastTaskInstructions, controller.signal);
                        break;
                    }
                    case 'beforePlanning': {
                        result = await this.before_planning_run(runParams, controller.signal);
                        break;
                    }
                }
                clearTimeout(timeoutId);
                return result;
            } catch (error: any) {
                // --- 深度错误分析 ---
                const errorName = error?.name || 'UnknownError';
                const errorMessage = error?.message || String(error);
                const statusCode = error?.status || error?.statusCode;
                const isRateLimit = statusCode === 429 || errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED');

                // 特殊处理：审计拦截失败属于内部逻辑错误，仅在调试模式下显示为红色
                if (errorName === 'AuditFailedError' || errorMessage.includes('审计拦截')) {
                    logger(`[agent.${role}] 审计拦截 [AuditFailedError]: ${errorMessage}`, { error: true, debug: true });
                } else {
                    // 其他请求异常（如 401, 404, 500）属于基础架构/配置错误，始终显示并报错
                    logger(`[agent.${role}] 请求异常 [${errorName}]: ${errorMessage}${statusCode ? ` (Status: ${statusCode})` : ''}`, { error: true });
                }

                clearTimeout(timeoutId);
                retryCount++;

                if (error?.name === 'AbortError' || error?.message?.includes('超时')) {
                    logger(`[Agent.${role}] 第 ${retryCount} 次请求超时 (${timeoutSeconds}s)...`, { debug: true, error: true });

                    if (retryCount >= maxRetries) {
                        return this._handleChatTimeout(role, runParams, maxRetries, timeoutSeconds, params);
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 增加超时后的重试间隔
                    continue;
                }

                // 针对 429 频率限制进行特殊处理：增加重试间隔
                if (isRateLimit) {
                    const waitTime = Math.pow(2, retryCount) * 2000; // 指数退避: 4s, 8s...
                    logger(`[Agent.${role}] 触发频率限制 (429)，正在进行指数退避等待 (${waitTime / 1000}s) 后第 ${retryCount + 1} 次重试...`, { debug: true, error: true });

                    if (retryCount < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                }

                if (retryCount >= maxRetries) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
        }
    }

    /** 内部私有方法：统一处理聊天超时后的返回对象 */
    private _handleChatTimeout(role: string, runParams: any, maxRetries: number, timeoutSeconds: number, originalParams: any) {
        if (role === 'run' || role === 'plan') {
            return {
                finishReason: 'otherStop',
                text: `检测到 AI 请求超时中断 (已尝试 ${maxRetries} 次，超时设定 ${timeoutSeconds}s)。建议检查网络代理或更换模型。`,
                history: runParams.history || [],
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                response: null
            };
        } else if (role === 'coordinator') {
            return {
                result: `统筹分析过程最终超时 (已尝试 ${maxRetries} 次)`,
                history: originalParams.history || [],
                title: 'none'
            };
        } else if (role === 'restorer') {
            return { title: "stop", text: `修补员分析最终超时`, think: "" };
        }
        return { finishReason: 'timeout', text: '请求最终超时' };
    }


    /** ### 获取提示词
     * @description 按需加载提示词 (直接从生成的代码模块中获取)
     * @param filename 文档名称
     */
    private getPrompt(filename: string): string {
        const generated = getGeneratedPrompt(filename);
        if (generated) {
            return generated;
        }
        logger(`[getPrompt] 找不到提示词内容: ${filename}`, { error: true });
        return '';
    }

    /** =============== 任务计划前 =============== */

    /** ### 需求预处理入口 (静态调用)
     * @description 对用户原始需求进行拆分、纠错与过滤，输出结构化的任务清单。
     * @param input 用户原始输入
     */
    public static async beforePlanning(input: string): Promise<{ agentTasks: string[]; otherTasks: string[] }> {
        const agent = await agent_Index.create();
        const result = await agent.chat('beforePlanning', {
            input: input,
            sendState: false
        } as any);
        return result;
    }

    /** ### 需求预处理内部实现 (beforePlanning)
     * @param params - 运行参数
     * @param abortSignal - 中断信号
     */
    private async before_planning_run(params: new_agent_run_params, abortSignal?: AbortSignal): Promise<{ agentTasks: string[]; otherTasks: string[] }> {
        const systemPrompt = this.getPrompt('beforePlanning');
        const messages: any[] = [{
            role: 'user',
            content: params.input
        }];

        try {
            const result = await (generateText as any)({
                model: this.model,
                system: systemPrompt,
                messages: messages,
                abortSignal: abortSignal,
                maxTokens: 1024,
                maxCompletionTokens: 1024,
                // temperature: 0.1,
                maxRetries: 1
            });

            const fullText = result.text || '';
            const thinkMatch = fullText.match(/<think>([\s\S]*?)<\/think>/);

            // 处理思考过程输出逻辑
            if (thinkMatch) {
                const thinkContent = thinkMatch[1].trim();
                const showFullThink = process.env.showThink === 'true';
                const displayThink = showFullThink ? thinkContent : (thinkContent.length > 30 ? thinkContent.substring(0, 30) + '...' : thinkContent);
                logger(`\n[Agent/需求分析] 🤔 思考过程:\n${displayThink}`, { debug: true });
            }

            // 解析代理任务列表 (agentTask) - 兼容 agentTask(tasks=["..."]) 和 agentTask(["..."]) 甚至 agentTask("...")
            const agentTaskMatch = fullText.match(/agentTask\((?:tasks=\[)?([\s\S]*?)\]?\)/i);
            let agentTasks: string[] = [];
            if (agentTaskMatch) {
                try {
                    const taskRaw = agentTaskMatch[1].trim();
                    // 尝试匹配带引号的项，否则按逗号粗暴拆分
                    const matches = taskRaw.match(/(["'])(?:(?=(\\?))\2.)*?\1/g);
                    if (matches) {
                        agentTasks = matches.map((m: string) => m.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
                    } else {
                        agentTasks = taskRaw.split(',').map((i: string) => i.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
                    }
                } catch (e: any) {
                    logger(`[Agent/需求分析] 解析 agentTasks 失败: ${e.message}`, { error: true });
                }
            }

            // 解析非代理任务列表 (otherTask)
            const otherTaskMatch = fullText.match(/otherTask\((?:tasks=\[)?([\s\S]*?)\]?\)/i);
            let otherTasks: string[] = [];
            if (otherTaskMatch) {
                try {
                    const taskRaw = otherTaskMatch[1].trim();
                    const matches = taskRaw.match(/(["'])(?:(?=(\\?))\2.)*?\1/g);
                    if (matches) {
                        otherTasks = matches.map((m: string) => m.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
                    } else {
                        otherTasks = taskRaw.split(',').map((i: string) => i.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
                    }
                } catch (e: any) { }
            }

            // 如果没匹配到任何标签且文本不为空，兜底认为整体是一个单一任务（剥离 <think> 后的文本）
            if (agentTasks.length === 0 && otherTasks.length === 0 && fullText.trim()) {
                let cleanTask = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                logger(`[Agent/需求分析] 未匹配到结构化标签，按清理后的任务处理。`, { debug: true });
                agentTasks = [cleanTask || params.input]; // 如果清理后为空，则使用原始输入
            }

            // 调试模式下打印拆分结果
            if (agentTasks.length > 0) {
                logger(`[Agent/需求分析] 📱 拆分出的手机任务 (${agentTasks.length}):\n${agentTasks.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`, { debug: true });
            }
            if (otherTasks.length > 0) {
                logger(`[Agent/需求分析] 🚫 过滤出的非手机任务 (${otherTasks.length}):\n${otherTasks.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`, { debug: true });
            }

            return { agentTasks, otherTasks };

        } catch (error: any) {
            logger(`[BeforePlanning] 运行异常: ErrorName: ${error.message || error}, Error: ${error}`, { error: true });
            // 不再返回默认空任务，允许错误上报以提示用户配置问题
            throw error;
        }
    }

    /** =============== 角色板块 =============== */

    /** ### 执行者 (Stream 流式 + 正则解析模式)
     *  @description 最小化的单步动作执行。AI 通过 <think>/<function> 标签输出，客户端正则解析后调用 ADB 方法。
     */
    async run(params: new_agent_run_params, abortSignal?: AbortSignal): Promise<new_agent_run_result> {
        const date = new Date();
        const timeoutSeconds = params.timeout || this.defaultTimeout;
        const waitingTime = params.waitingTime || 500;

        // --- 核心优化：API 频率保护 (Cool-down) ---
        if (waitingTime > 0) {
            logger(`[new_agent] 正在进行 API 频率保护等待 (${waitingTime}ms)...`, { debug: true });
            await new Promise(resolve => setTimeout(resolve, waitingTime));
        }

        // 2. 初始化 AndroidAgent（用于执行解析出的函数调用）
        const androidAgent = new AndroidAgent(params.device, waitingTime);

        // --- 环境自检：确保 adbKeyboard 已安装 ---
        if (!this.isEnvironmentReady) {
            const keyboardPkg = 'com.android.adbkeyboard';
            const isKeyboardInstalled = await androidAgent.pm.isInstalled(keyboardPkg);
            if (!isKeyboardInstalled) {
                logger(`[new_agent] 检测到未安装 ADB Keyboard，正在自动补齐环境...`, { debug: true });
                const localApkPath = path.join(BaseModule.getRootPath(), 'assets/apk/must/adbKeyboard.apk');
                if (fs.existsSync(localApkPath)) {
                    await androidAgent.pm.installLocal(localApkPath);
                    logger(`[new_agent] ADB Keyboard 安装完成。`);
                } else {
                    logger(`[new_agent] 未能找到本地 APK 文件: ${localApkPath}，请检查文件是否存在。`, { debug: true, error: true });
                }
            }
            this.isEnvironmentReady = true;
        }

        // 3. 【核心逻辑：双轮视觉缓冲】清理历史记录中的"陈旧"临时图片，防止请求体爆炸
        const history = (params.history || []).map((msg, index, arr) => {
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                const laterUserMsgCount = arr.slice(index + 1).filter(m => m.role === 'user').length;
                if (laterUserMsgCount > 0) {
                    return {
                        ...msg,
                        // 对于上一轮的请求（later === 1），保留原图去除临时图；对于更老的请求（later > 1），去除所有图片
                        content: msg.content.filter((c: any) => c.type !== 'image' || (laterUserMsgCount === 1 && !c.isTempImage))
                    };
                }
            }
            return msg;
        });

        let messages: ModelMessage[] = [...history];

        // 4. 并行采集环境背景信息 (仅采集状态与截图，移除耗时的 XML)
        const [currentState, capResult, size, launcherApps] = await Promise.all([
            // androidAgent.xml.analyze(0),                    // 获取 xml ,总共两处，下方一处插入
            androidAgent.xml.getCurrentState(),
            androidAgent.screencap(80, 0, 'screen.png', false, undefined, '当前屏幕').then(async (res) => {
                const gridRes = await androidAgent.gridScreencap(0, res.buffer);
                return { ...res, gridPath: gridRes.filePath };
            }),
            androidAgent.getScreenSize(), // 纳入并行采集，提升速度
            androidAgent.pm.launcherAppList() // 采集已安装的应用列表
        ]);

        // --- 获取上次点击坐标并刷新 ---
        const clickPrompt = (AndroidAgent.lastClick.rawX && AndroidAgent.lastClick.rawY) ? `【操作提示】：上次点击的坐标是(${AndroidAgent.lastClick.rawX}:${AndroidAgent.lastClick.rawY})，已显示在页面上的红点处，如果未命中请及时调整点击位置` : null
        AndroidAgent.lastClick = { x: null, y: null, rawX: null, rawY: null };

        // 准备坐标参考边界 (固定 1000px)
        const scaledWidth = 1000;
        const scaledHeight = 1000;

        // 准备系统提示词
        let systemPrompt =
            `**当前的时间是:** ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}\n\n` +

            `\n\n------------------ 系统提示词 ------------------\n` +
            `${this.getPrompt('run_main')
                .replace(/\$\{scaledWidth\}/g, String(scaledWidth))
                .replace(/\$\{scaledHeight\}/g, String(scaledHeight))
                .replace(/\$\{currentState\}/g, JSON.stringify(currentState))}\n` +

            `\n\n------------------ 函数调用 ------------------\n` +
            `${this.getPrompt('run_tools')}\n` +

            `\n\n------------------ app启动列表 ------------------\n` +
            `# app应用启动列表\n` +
            `> 启动应用优先从这里启动，这里是 app 入口地址，可以通过调用 start() 函数启动app \n` +
            `${launcherApps.map(app => `- ${app}`).join('\n')}` +
            `${clickPrompt ? '\n' + clickPrompt : ''}`

        // 1.1 格式化当前页面层级状态 (包名/Activity/窗口栈)
        const hierarchyStr = currentState ?
            `当前应用：${currentState.context.current_app}\n  - 当前 Activity：${currentState.context.current_activity}\n  - 窗口堆栈：${currentState.context.window_stack.length > 0 ? `\n    ${currentState.context.window_stack.join('\n    ')}` : '无'}` :
            '获取失败';

        const screenPath = capResult.filePath;
        let autoGridPath: string | undefined = capResult.gridPath;
        let contentArray: any[] = [{
            type: 'text',
            text: `- 页面层级：\n  ${hierarchyStr}\n\n- 任务指令：\n  ${params.input}`
        }];

        // =========== 是否注入原图截屏 （注释则关闭注入） ============
        logger(`[new_agent] 正在注入实时屏幕截图...`, { debug: true });
        const imageBASE64 = fs.readFileSync(screenPath, { encoding: 'base64' });
        contentArray.push({
            type: 'image',
            image: imageBASE64,
            mimeType: 'image/png',
            isTempImage: true
        });
        // ============================

        // 处理用户手动传入或其他工具截获的图片
        if (params.images && Array.isArray(params.images)) {
            logger(`[new_agent] 收到附加图片请求，数量: ${params.images.length}`, { debug: true });
            for (const imgPath of params.images) {
                if (fs.existsSync(imgPath)) {
                    logger(`[new_agent] 附加外部图片: ${imgPath}`, { debug: true });
                    const imgBASE64 = fs.readFileSync(imgPath, { encoding: 'base64' });
                    contentArray.push({ type: 'image', image: imgBASE64, mimeType: 'image/png', isTempImage: true });
                } else {
                    logger(`[new_agent] 附加图片文件不存在跳过: ${imgPath}`, { debug: true });
                }
            }
        }

        const newUserMessage: ModelMessage = {
            role: 'user',
            content: contentArray
        };
        messages.push(newUserMessage);

        // 【格式强制】：针对 GitHub 模型的严格格式注入
        const forceFormatMessage: ModelMessage = {
            role: 'user',
            content: [{ type: 'text', text: "\n\nCRITICAL: DO NOT explain. DO NOT talk to user. KEEP <think> block under 2 sentences. ONLY output the required XML tags (<think>, <function>, <text>). Ensure all <function> calls are correctly formatted." }]
        };

        const callOptions: any = {
            model: this.model,
            abortSignal: abortSignal,
            system: systemPrompt,
            messages: this._sanitizeHistory([...messages, forceFormatMessage]),
            maxTokens: 1024,
            max_tokens: 1024,
            maxCompletionTokens: 1024,
            max_completion_tokens: 1024,
            // temperature: 0.1, // 降低随机性，确保生成的坐标和逻辑更稳定
            maxRetries: 2
        };

        logger(`[DEBUG] Final callOptions for streamText: maxTokens=${callOptions.maxTokens}, maxCompletionTokens=${callOptions.maxCompletionTokens}`, { debug: true });



        // 6. 执行 streamText（流式模式，无 function calling）
        // payload 调试：打印消息数量和图片体积
        const imgCount = messages.reduce((count, msg) => count + (Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === 'image').length : 0), 0);
        const imgBytes = messages.reduce((total, msg) => total + (Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === 'image').reduce((s: number, c: any) => s + (c.image?.length || 0), 0) : 0), 0);
        logger(`[payload] 消息数: ${messages.length}, 图片数: ${imgCount}, 图片总大小: ${(imgBytes / 1024).toFixed(0)}KB, System Prompt: ${(systemPrompt.length / 1024).toFixed(0)}KB`, { debug: true });


        try {
            const startStreamTask = async () => {
                logger(`[new_agent] 🚀 正在发起 AI 流式请求 (${this.currentModelName})...`, { debug: true });
                return (streamText as any)(callOptions);
            };

            const streamResult = await startStreamTask();

            // --- 7. 流式消费 + Think 实时显示 + 超时保护 ---
            let fullText = '';
            let thinkPrinted = 0;
            const STREAM_CHUNK_TIMEOUT = 60000; // 单个 chunk 超时 120 秒，处理多图需更久

            try {
                const iterator = streamResult.textStream[Symbol.asyncIterator]();
                logger(`[new_agent] 流式数据传输开始...`, { debug: true });

                while (true) {
                    // 每个 chunk 竞速：要么拿到最新的部分文字数据，要么 90s 内无数据则抛出超时异常（跳至 catch 块）
                    const chunkResult: any = await Promise.race([
                        iterator.next(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`[${this.currentModelName}] Stream chunk 超时 (90s 无数据，提示：如果频繁超时请检查网络代理和模型提供商并发限制)`)), 90000)
                        )
                    ]);

                    // 【核心跳出循环判定】：当 AI 文本流彻底输出完毕（连接结束），chunkResult.done 会变为 true，此时 break 跳出 while 循环
                    if (chunkResult.done) {
                        logger(`\n[new_agent] 流式数据接收完成 (总长: ${fullText.length} 字符)`, { debug: true });
                        break;
                    }

                    const chunk = chunkResult.value;
                    fullText += chunk; // 拼接到完整文本中

                    const isShowThink = process.env.SHOWTHINK === 'true';

                    // 寻找动作开始的位置（兼容标准标签或 Kimi 自创格式）
                    const funcIdx1 = fullText.indexOf('<function>');
                    const funcIdx2 = fullText.indexOf('[调用函数]');
                    const foundStart = [];
                    if (funcIdx1 >= 0) foundStart.push(funcIdx1);
                    if (funcIdx2 >= 0) foundStart.push(funcIdx2);
                    const functionStart = foundStart.length > 0 ? Math.min(...foundStart) : fullText.length;

                    if (isShowThink) {
                        // --- 模式 A: 完整显示模型思考内容 (SHOWTHINK=true) ---
                        if (functionStart === fullText.length) {
                            // 过滤掉思考和总结标签本身，让输出更纯净
                            const cleanChunk = chunk.replace(/<\/?think>|<\/?text>/g, '');
                            process.stdout.write(`\x1b[90m${cleanChunk}\x1b[0m`);
                            thinkPrinted = 1;
                        }
                    } else {
                        // --- 模式 B: 原有的单行跑马灯模式 (默认) ---
                        const cleanTextToDisplay = fullText.slice(0, functionStart).replace(/\s+/g, ' ').trim();
                        const snippet = cleanTextToDisplay.length > 30 ? '...' + cleanTextToDisplay.slice(-30) : cleanTextToDisplay;

                        if (snippet.length > 0 && thinkPrinted !== -1) {
                            process.stdout.write(`\r\x1b[90m🤔 正在思考: ${snippet}\x1b[0m\x1b[K`);
                            thinkPrinted = 1;
                        }
                    }

                    // 当遇到动作标签时
                    if (functionStart < fullText.length && thinkPrinted > 0) {
                        if (!isShowThink) {
                            process.stdout.write(`\r\x1b[K`); // 跑马灯模式下：立刻擦除这行思考留下的痕迹
                        } else {
                            process.stdout.write(`\n`); // 完整显示模式下：换行以区分后续动作输出
                        }
                        thinkPrinted = -1; // 标记不再打印
                    }
                }
            } catch (streamError: any) {
                logger(`\n[Stream] 流式接收异常 (已收集${fullText.length}字符): ${streamError.message}`, { debug: true, error: true });
            }

            // 清理残留的思考显示状态并恢复颜色
            if (thinkPrinted > 0 && process.env.SHOWTHINK !== 'true') {
                process.stdout.write(`\r\x1b[K`);
            }

            // --- 8. 获取 usage（流已结束或超时，尝试获取） ---
            let usage: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            let finishReason: string = 'unknown';
            try {
                usage = await Promise.race([
                    streamResult.usage,
                    new Promise(resolve => setTimeout(() => resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }), 5000))
                ]);
                finishReason = await Promise.race([
                    streamResult.finishReason,
                    new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
                ]) as string;
            } catch (e) {
                logger(`[Stream] 获取 usage/finishReason 失败`, { debug: true });
            }

            // --- 9. 正则解析 <function> 或降级标签 ---
            const parsedList = parseFunctionCall(fullText);

            // 如果本轮 AI 一无所获或只出了空，才暴露出原始的一大坨日志方便 Debug！
            if (parsedList.length === 0) {
                logger(`\n[DEBUG] AI 未执行任何函数，原始输出 (${fullText.length}字符, finishReason=${finishReason}):\n${fullText.slice(0, 500)}`, { error: true });
                if (fullText.trim().length === 0 && finishReason === 'stop') {
                    logger(`   🚨 [警告] AI 瞬间返回了空的结果并结束！这通常说明你使用的代理节点拦截了包含大图的请求，或者是触发了其免费配额断连/安全审核，而不是代码卡住。`, { debug: true, error: true });
                }
            }



            // 提取 think 内容作为 text 返回（供 executor 日志记录）
            const thinkMatch = fullText.match(/<think>([\s\S]*?)<\/think>/);
            const thinkText = thinkMatch ? thinkMatch[1].trim() : fullText;

            // 解析 AI 的 <text> 标签（模型的结构化状态总结，作为跨轮次的"记忆"）
            const textMatch = fullText.match(/<text>([\s\S]*?)<\/text>/);
            const aiReplyText = textMatch ? textMatch[1].trim() : '';

            // --- 10. 顺序执行解析出的所有函数 ---
            let toolCalls: any[] = [];
            let toolResults: any[] = [];

            if (parsedList.length > 0) {
                // --- 审计挂起拦截点 ---
                if (params.auditPromise && !this.isAuditConfirmed) {
                    logger(`\n[Agent] ⏳ LLM 思考完毕，正在通过 AuditPromise 等待上一步审计结果以决定是否执行动作...`);
                    const auditRes = await params.auditPromise;
                    if (auditRes.function === 'back' || auditRes.function === 'restorer') {
                        logger(`[Agent] ❌ 审计不通过 (${auditRes.function})，已拦截本轮投机执行并抛出中断指令。`);
                        throw new AuditFailedError(auditRes);
                    }
                    logger(`[Agent] ✅ 审计已通过，允许执行本轮投机动作。`);
                    this.isAuditConfirmed = true; // 标记已通过，本任务后续不再检查
                }

                // 精简打印本轮调用的所有函数名
                if (process.env.DEBUG === 'true') {
                    const fnNames = parsedList.map(p => `#${p.tool}`).join('   ');
                    logger(`[function calling]  ${fnNames}`);
                }

                for (const parsed of parsedList) {
                    const callId = `stream-${Date.now()}`;
                    toolCalls.push({
                        toolCallId: callId,
                        toolName: parsed.tool,
                        args: parsed.args,
                        input: parsed.args  // 兼容 planner.ts 的 item.input 检查
                    });

                    // 执行实际的 ADB 操作
                    const actionResult = await executeAction(androidAgent, parsed);

                    toolResults.push({
                        toolCallId: callId,
                        toolName: parsed.tool,
                        result: actionResult
                    });

                    const resultStr = JSON.stringify(actionResult);
                    const snipStr = resultStr.length > 80 ? resultStr.slice(0, 80) + '... (已省略长输出)' : resultStr;
                    // logger(`   🛠️  [底层反馈] 已执行函数 [${parsed.tool}]: ${snipStr}`);
                }
            } else {
                logger(`   ⚠️  [Stream] AI 未输出 <function> 标签，本轮无动作`, { debug: true });
            }

            // --- 11. 构造兼容 new_agent_run_result 的返回值 ---
            // 关键优化：彻底移除历史记录中的图片实体数据，仅保留文本描述，防止 Token 爆炸和模型幻觉
            const cleanHistoryUser = {
                ...newUserMessage,
                content: Array.isArray(newUserMessage.content)
                    ? newUserMessage.content.map((c: any) => {
                        if (c.type === 'image') {
                            return { type: 'text', text: '[上一轮历史屏幕截图已省略]' };
                        }
                        return c;
                    })
                    : newUserMessage.content
            };

            // 构建 assistant 历史消息：保留原始 XML 格式 + 确保包含 <text> 记忆
            // 分层注入逻辑：我们将“推理/动作”与“进度总结”作为两个逻辑段落，中间穿插“执行结果”
            let cleanAssistantAction = fullText.trim();
            let finalReplyText = aiReplyText;

            /**
             * 【步骤 1】: 提取并净化“动作轮次”内容
             * 如果 AI 输出中包含 <text> 进度总结标签，我们将其从本轮主回复中剥离。
             * 理由：为了实现“回声式”记忆，我们会把总结放在执行结果之后单独重申。
             */
            if (textMatch) {
                // 仅保留推理 (<think>) 和函数调用 (<function>) 部分
                cleanAssistantAction = fullText.replace(/<text>([\s\S]*?)<\/text>/g, '').trim();
            }

            // 【兜底逻辑】: 如果 AI 回复为空（如由于模型超时或安全过滤），注入占位符以防止 API 400 错误
            if (!cleanAssistantAction) {
                cleanAssistantAction = "【系统提示】AI 本轮未返回有效动作或发生超时，请分析当前屏幕状态重新执行策略。";
            }
            if (!finalReplyText) {
                finalReplyText = "（本轮未生成进度总结）";
            }

            /**
             * 【步骤 2】: 异常托底逻辑
             * 如果 AI 这一轮执行了动作（parsedList 有值）但忘记输出 <text> 总结标签：
             * 我们自动生成一份“自动记录”，确保下一轮迭代不会丢失“刚刚做了什么”的上下文。
             */
            if (!textMatch && parsedList.length > 0) {
                const autoSummary = parsedList.map(p => `${p.tool}(${Object.entries(p.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`).join(' → ');
                const generatedText = `【自动记录】本轮执行了: ${autoSummary}`;
                finalReplyText = generatedText;
            }

            /**
             * 【步骤 3】: 构建分层对话流
             * 结构逻辑：User(请求) -> Assistant(动作详情) -> User(工具执行显性结果) -> Assistant(进度与下步总结)
             */
            let resultMessages: any[] = toolResults.length > 0 ? [{
                role: 'user',
                content: toolResults.map(tr => `[${tr.toolName} 执行结果]: ${JSON.stringify(tr.result)}`).join('\n')
            }] : [];

            let currentTurnMessages: any[] = [];
            if (toolResults.length > 0) {
                // [动作流模式]: 实现了动作与逻辑总结的显式分离，强化模型感知力
                currentTurnMessages = [
                    cleanHistoryUser,
                    { role: 'assistant', content: cleanAssistantAction }, // 只有思考和动作
                    ...resultMessages,                                   // 工具返回的真实数据
                    { role: 'assistant', content: `<text>\n${finalReplyText}\n</text>` } // 总结：回顾过去，展望未来
                ];
            } else {
                // [纯对话模式]: 维持标准对话格式
                // 强制对单条对话也进行空值兜底
                const safeFeedback = fullText.trim() || "【系统提示】AI 本轮未返回有效文本或发生超时。";
                currentTurnMessages = [
                    cleanHistoryUser,
                    { role: 'assistant', content: safeFeedback }
                ];
            }

            /**
             * 将内存中之前积攒的所有历史记录与本轮新生成的对话序列全量合并。
             * 保证下一轮迭代发送给 AI 的数据中，没有任何 assistant 消息为空内容。
             */
            const rawHistory = [...(params.history || []), ...currentTurnMessages];
            const finalHistory = this._sanitizeHistory(rawHistory);

            // 写入带回复的历史日志，方便调试看 AI 说了什么
            try {
                const logDir = path.join(BaseModule.getRootPath(), 'log');
                if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
                fs.writeFileSync(path.join(logDir, 'aiStdout.log'), JSON.stringify(finalHistory, null, 2));
            } catch (e) {
                logger(`[new_agent] 写入历史记录日志失败: ${e}`, { debug: true, error: true });
            }

            return {
                /** AI 本轮的回复文本（优先 <text> 标签内容，其次 <think> 标签内容），用于 executor 日志和 success 结果提取
                 *  示例: "【当前进度总结】已进入淘宝首页...\n【下一步计划】搜索商品..." */
                text: finalReplyText || thinkText,
                /** 本轮产生的历史记录数组，executor 通过 history.push(...response.history) 叠加
                 *  示例: [{ role:'user', content:[...] }, { role:'assistant', content:'<think>...</think><function>...</function>' }, { role:'user', content:'[click 执行结果]: {...}' }] */
                history: finalHistory,
                /** 本轮解析出的函数调用列表（兼容原 function calling 格式），executor 通过 .find(tc => tc.toolName === 'success') 检测任务完成
                 *  示例: [{ toolCallId:'stream-1711555200000', toolName:'click', args:{ x:540, y:120 }, input:{ x:540, y:120 } }] 
                 *  无调用时: [] */
                toolCalls,
                /** 函数执行后的结果列表，executor 通过 .forEach 检测 scrollScreencap/gridScreencap 的图片路径
                 *  示例: [{ toolCallId:'stream-1711555200000', toolName:'click', result:{ status:'success', message:'已点击坐标 (540, 120)' } }]
                 *  无调用时: [] */
                toolResults,
                /** 本次请求的 Token 消耗统计
                 *  示例: { promptTokens: 1520, completionTokens: 86, totalTokens: 1606 } */
                usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                /** AI 响应的终止原因
                 *  示例: 'stop'（正常结束）| 'length'（达到最大 token）| 'error'（出错） */
                finishReason: finishReason || 'stop',
                /** streamText 的原始流式结果对象，保留用于调试
                 *  包含 .textStream, .usage, .response 等底层属性 */
                response: streamResult,
                /** 【新增】本轮最新的屏幕截图路径 */
                imagePath: screenPath
            } as any;
        } catch (error: any) {
            // 内部执行异常（如审计失败）仅在开发调试模式下显示为红色
            logger(`[new_agent.run] 执行异常: ${error.message || error}`, { error: true, debug: true });
            throw error;
        }
    }

    /** ### 计划者/决策者 (Stream 流式 + 正则解析模式)
     * @description 该方法专门用于 Planner 角色进行任务拆解。
     * AI 通过 <think>/<function> 标签输出计划，客户端正则解析后提取 makePlan 调用。
     */
    async plan(params: new_agent_run_params, abortSignal?: AbortSignal): Promise<new_agent_run_result> {
        const timeoutSeconds = params.timeout || this.defaultTimeout;

        // 1. 构建消息历史
        const androidAgent = new AndroidAgent(params.device, params.waitingTime || 500);
        const launcherApps = await androidAgent.pm.launcherAppList();
        const appListStr = launcherApps.map(app => `- ${app}`).join('\n');

        const history = params.history || [];
        let messages: ModelMessage[] = [...history];

        let contentArray: any[] = [{ type: 'text', text: params.input }];

        // 支持传入参考图片
        if (params.images && Array.isArray(params.images)) {
            for (const imgPath of params.images) {
                if (fs.existsSync(imgPath)) {
                    const imgBASE64 = fs.readFileSync(imgPath, { encoding: 'base64' });
                    contentArray.push({ type: 'image', image: imgBASE64, mimeType: 'image/png' });
                }
            }
        }

        const newUserMessage: ModelMessage = {
            role: 'user',
            content: contentArray
        };
        messages.push(newUserMessage);



        let systemPrompt = this.getPrompt('planner').replace(/\$\{appListStr\}/g, appListStr);
        // 3. 执行 streamText（不传 tools）
        // 【格式强制】：针对 GitHub 模型的严格格式注入
        const forceFormatMessage: ModelMessage = {
            role: 'user',
            content: [{ type: 'text', text: "\n\nCRITICAL: DO NOT explain. DO NOT talk to user. KEEP <think> block under 3 sentences. ONLY output the required XML tags (<think>, <function>, <text>). If you generate plans, use <function>makePlan(...)</function> or <function>loopPlan(...)</function> only. Zero conversation." }]
        };

        const callOptions: any = {
            model: this.model,
            system: systemPrompt,
            messages: [...messages, forceFormatMessage],
            abortSignal: abortSignal,
            maxTokens: 3072,
            max_tokens: 3072,
            maxCompletionTokens: 3072,
            max_completion_tokens: 3072,
            // temperature: 0.1, // 规划任务需要高度确定性
            maxRetries: 1
        };

        logger(`[DEBUG/Planner] Final callOptions: maxTokens=${callOptions.maxTokens}, maxCompletionTokens=${callOptions.maxCompletionTokens}`, { debug: true });

        const startStreamTask = async () => {
            // logger(`\n--- [new_agent] (Planner) 执行决策任务 [Stream+正则] (${this.currentModelName}) ---`);
            return (streamText as any)(callOptions);
        };

        // payload 调试：打印消息数量和图片体积
        const imgCount = messages.reduce((count, msg) => count + (Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === 'image').length : 0), 0);
        const imgBytes = messages.reduce((total, msg) => total + (Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === 'image').reduce((s: number, c: any) => s + (c.image?.length || 0), 0) : 0), 0);
        logger(`[payload-Planner] 消息数: ${messages.length}, 图片数: ${imgCount}, 图片总大小: ${(imgBytes / 1024).toFixed(0)}KB, System Prompt: ${(systemPrompt.length / 1024).toFixed(0)}KB`, { debug: true });

        try {
            const http_proxy = params.http_proxy || process.env.HTTPPROXY;
            const https_proxy = params.https_proxy || process.env.HTTPPROXY;

            const streamResult = (http_proxy || https_proxy)
                ? await proxyHelper.useProxy(startStreamTask, {
                    http_proxy: http_proxy,
                    https_proxy: https_proxy
                })
                : await startStreamTask();

            // --- 流式消费 + Think 实时显示 ---
            let fullText = '';
            let thinkPrinted = 0;
            const STREAM_CHUNK_TIMEOUT = 60000;

            try {
                const iterator = streamResult.textStream[Symbol.asyncIterator]();
                logger(`[Planner] 规划任务流式数据传输开始...`, { debug: true });

                while (true) {
                    const chunkResult: any = await Promise.race([
                        iterator.next(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`Planner Stream chunk 超时 (90s 无数据)`)), 90000)
                        )
                    ]);

                    if (chunkResult.done) {
                        logger(`\n[Planner] 规划任务流式接收完成 (总长: ${fullText.length} 字符)`, { debug: true });
                        break;
                    }

                    const chunk = chunkResult.value;
                    fullText += chunk;

                    const isShowThink = process.env.SHOWTHINK === 'true';

                    // 寻找动作开始的位置
                    const funcIdx1 = fullText.indexOf('<function>');
                    const funcIdx2 = fullText.indexOf('[调用函数]');
                    const foundStart = [];
                    if (funcIdx1 >= 0) foundStart.push(funcIdx1);
                    if (funcIdx2 >= 0) foundStart.push(funcIdx2);
                    const functionStart = foundStart.length > 0 ? Math.min(...foundStart) : fullText.length;

                    if (isShowThink) {
                        // --- 模式 A: 完整显示规划者的思考内容 (SHOWTHINK=true) ---
                        if (functionStart === fullText.length) {
                            // 过滤掉标签本身
                            const cleanChunk = chunk.replace(/<\/?think>|<\/?text>/g, '');
                            process.stdout.write(`\x1b[90m${cleanChunk}\x1b[0m`);
                            thinkPrinted = 1;
                        }
                    } else {
                        // --- 模式 B: 原有的单行跑马灯模式 ---
                        const cleanTextToDisplay = fullText.slice(0, functionStart).replace(/\s+/g, ' ').trim();
                        const snippet = cleanTextToDisplay.length > 30 ? '...' + cleanTextToDisplay.slice(-30) : cleanTextToDisplay;

                        if (snippet.length > 0 && thinkPrinted !== -1) {
                            process.stdout.write(`\r\x1b[90m🤔 规划中: ${snippet}\x1b[0m\x1b[K`);
                            thinkPrinted = 1;
                        }
                    }

                    // 一旦进入真正动作（输出工具标签时）
                    if (functionStart < fullText.length && thinkPrinted > 0) {
                        if (!isShowThink) {
                            process.stdout.write(`\r\x1b[K`); // 擦除单行进度
                        } else {
                            process.stdout.write(`\n`); // 换行
                        }
                        thinkPrinted = -1;
                    }
                }
            } catch (streamError: any) {
                logger(`\n[Stream] Planner 流式接收异常 (已收集${fullText.length}字符): ${streamError.message}`);
            }

            if (thinkPrinted > 0 && process.env.SHOWTHINK !== 'true') {
                process.stdout.write(`\r\x1b[K`);
            }


            // --- 8. 获取 usage / finishReason (带超时保护防止挂起) ---
            let usage: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            let finishReason: string = 'unknown';
            try {
                usage = await Promise.race([
                    streamResult.usage,
                    new Promise(resolve => setTimeout(() => resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }), 5000))
                ]);
                finishReason = await Promise.race([
                    streamResult.finishReason,
                    new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
                ]) as string;
            } catch (e) {
                logger(`[Stream] Planner 获取 usage/finishReason 失败（请检查网络代理、API 额度或模型配置是否正确）。`, { debug: true, error: true });
            }

            // --- 解析 <function> 标签并生成任务列表 ---
            const parsedList = parseFunctionCall(fullText);
            let taskList = this._parsePlanningResponse(parsedList);

            // 如果本轮 AI 一无所获或只出了空，打印原始日志

            // --- 核心解析：提取 LLM 的推理思维链 (Chain of Thought) ---
            const thinkMatch = fullText.match(/<think>([\s\S]*?)<\/think>/);
            const thinkText = thinkMatch ? thinkMatch[1].trim() : fullText;

            const assistantMessage: ModelMessage = {
                role: 'assistant',
                content: fullText
            };

            return {
                text: thinkText || '',
                history: [newUserMessage, assistantMessage],
                taskList: taskList,
                usage: usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                finishReason: finishReason || 'stop',
                response: streamResult
            };
        } catch (err: any) {
            logger(`[new_agent] (Planner) 决策执行失败: ${err.message || err}`, { error: true, debug: true });
            throw err;
        }
    }

    /** ### 分配计划给执行者或者统筹者 并根据角色分配任务
     * @param planStr - 拆解后的具体单个子任务描述（如："点击京东首页顶部的搜索框"）
     * @param params - AI 运行配置参数，必填项包含 modelFamily, modelName, apiKey 等，用于初始化评估模型
     * @returns 返回表示任务角色及复杂度等级的对象
     */
    async plan_setStep(planStr: string, params: new_agent_run_params): Promise<{ role: 'executor' | 'coordinator' | 'restorer', level: number, text?: string }> {
        return new Promise(async (resolve, reject) => {
            try {
                const systemPrompt = this.getPrompt('plan_setStep')
                const result = await (generateText as any)({
                    model: this.model,
                    maxRetries: 2, // 增加重试防止因网络抖动导致的“评级失败”
                    system: systemPrompt,
                    maxTokens: 1024,
                    maxCompletionTokens: 1024,
                    abortSignal: params.signal, // 透传中断信号
                    // temperature: 0.1,
                    prompt: planStr
                });

                const textOutput = (result.text || '').trim();

                // --- 变量定义 (Boolean=false, String='', Number=0) ---
                let final: {
                    role: 'executor' | 'coordinator' | 'restorer',
                    level: number,
                    text?: string
                } = { role: 'executor', level: 0 }

                // 调用角色判定及内容解析
                if (textOutput.includes('<executor>')) {
                    // 当为执行人员时
                    final.role = 'executor'
                    let executorText = '';
                    let executorLevel = 0;
                    // 解析难度等级
                    const levelMatch = textOutput.match(/<executor_level>\s*([0-3])\s*<\/executor_level>/);
                    final.level = levelMatch ? parseInt(levelMatch[1]) : 0;
                    // 解析提示文本
                    const executorTextMatch = textOutput.match(/<executor_text>([\s\S]*?)<\/executor_text>/);
                    if (executorTextMatch) {
                        final.text = executorTextMatch[1].trim();
                    }
                    // 打印解析


                } else if (textOutput.includes('<coordinator>')) {
                    // 当为统筹人员时
                    final.role = 'coordinator'


                } else if (textOutput.includes('<restorer>')) {
                    // 当为计划人员/修补人员时
                    final.role = 'restorer'
                    // 解析提示文本
                    const restorerTextMatch = textOutput.match(/<restorer_text>([\s\S]*?)<\/restorer_text>/);
                    if (restorerTextMatch) {
                        final.text = restorerTextMatch[1].trim();
                    }
                    // 打印解析


                } else {                                                    // 错误返回默认
                    resolve({ role: 'executor', level: 0 })
                }

                resolve({ ...final });
            } catch (error: any) {
                logger(`\n[plan_setStep] 模型角色分配和估算难度失败，使用兜底值: ${error.message || error}`, { error: true });
                resolve({ role: 'executor', level: 0 }); // 发生错误默认交给执行员
            }
        });
    }

    /** ### 统筹员
     * @description 负责数据的统计、分析、整理，以及得出最终结论输出给用户
     * @param promptText - 外部传入的包含目标、任务和收集数据的统筹提示文本
     * @param isLastStep - 是否属于总体计划的最后一步
     * @param params - AI 运行配置参数
     */
    async coordinator_run(
        promptText: string,
        isLastStep: boolean,
        params: new_agent_run_params,
        /** 如果需要携带上下文历史记录可以写在这里，默认只携带提示词 */
        history: any[] = [],
        abortSignal?: AbortSignal
    ): Promise<{ result: string, history: any[], title: 'none' | 'stop' | 'restorer', restorerReason?: string }> {
        const systemPrompt = `你是一个专业的 Android 自动化数据整合与分析专家。\n` +
            `当任务交接给你时，说明前线的“执行人员”已经在前面的不同步骤中对手机进行了操作，并提取了相关的数据报表。\n` +
            `你的核心任务是：基于用户的【最终目标】、当前的【统筹任务描述】，结合前期收集到的【全部数据】，进行深入分析、对比、整理，并输出高质量的结论。\n\n` +
            `【执行规定】：\n` +
            `1. 聚焦目标：紧扣用户的最终目标和当前分配给你的具体统筹任务，剔除前线收集中无用的杂音数据。\n` +
            `2. 阶段性判定：由于你${isLastStep ? '【是】最后一步终结任务，你需要直接给用户输出符合最终目标的结论' : '【不是】最后一步，因此你只需要将当前收集到的杂乱数据进行极度简练的、高质量的降噪提炼，并交付出去即可'}。\n` +
            `3. 数据忠实：严格遵循收集到的真实数据进行分析，在对比、总结时（例如价格对比），绝对不得凭空捏造数据、名称。\n\n` +
            `【回答准则】：\n` +
            `- 直接切入主题，直接回答你的分析过程和结果。\n` +
            `- 采用友好、结构清晰的 markdown 格式排版（视情况使用加粗或列表）。\n` +
            `- 不需要表述你是谁，不用提“根据收集到的数据”、“我是AI”等任何不相关的废话。\n\n` +
            `【纠偏与终结指令 (重要)】：\n` +
            `- **判定是否达成 (核心)**：如果用户的总目标涉及具体的数量（如：沟通 10 个人），你必须核对历史记录中所有执行员通过 success(result="已完成第N位...") 汇报的成功编号。如果最大编号 < 总目标，说明任务尚未闭环。\n` +
            `- **主动纠偏 (<function>restorer(reason="...")</function>)**：若任务未闭环且有尝试余地，无论你认为后续步骤多简单，都**严禁**直接输出 text 结论。你必须调用 restorer 并描述当前的缺口（如：“已成功 2 位，还差 8 位，需要回退到列表页继续”）。\n` +
            `- **任务终结 (<function>stop()</function>)**：仅在以下两种情况调用：\n` +
            `  1. **成功终结**：确认所有目标（含数量需求）已 100% 达成。\n` +
            `  2. **不可抗力宣告 (终极逃逸)**：若确认环境遭遇不可修复的死局（如：账号被禁、App崩溃无法开启、必选强更弹窗、耗尽搜索结果），你必须在 text 中使用 ### ⚠️ 任务执行中断告警 详细说明阻塞点，然后调用 stop()。`;

        const messages: any[] = [
            ...history,
            { role: 'user', content: promptText }
        ];

        try {
            const result = await (generateText as any)({
                model: this.model,
                maxRetries: 1, // 这里给1次重试，防止网络抖动
                system: systemPrompt,
                abortSignal: abortSignal,
                // 【核心入口拦截】: 发起请求前进行最后一次历史清洗
                messages: this._sanitizeHistory(messages),
                maxTokens: 1536,
                maxCompletionTokens: 1536,
                // temperature: 0.1
            });

            const aiText = result.text || '';
            const isStop = aiText.includes('stop()');

            // 尝试提取 restorer(reason="...")
            const restorerMatch = aiText.match(/restorer\(\s*reason\s*=\s*["']([\s\S]*?)["']\s*\)/);
            const restorerReason = restorerMatch ? restorerMatch[1] : undefined;
            const isRestorer = !!restorerReason;

            const aiReply = aiText.trim() || "【系统提示】统筹员未能获取到有效分析结果或发生超时。";
            const finalHistory = this._sanitizeHistory([...messages, { role: 'assistant', content: aiReply }]);

            return {
                result: aiText.replace(/<(think|function)>[\s\S]*?<\/\1>/g, '').trim() || '统筹员未能获取到有效分析结果。',
                /** 本次统筹员产生的历史记录，错误为空 */
                history: finalHistory,
                title: isRestorer ? 'restorer' : (isStop ? 'stop' : 'none'),
                restorerReason: restorerReason
            };
        } catch (error: any) {
            logger(`\n[coordinator_run] 统筹员运行失败: ${error.message || error}`, { error: true });
            return {
                result: `统筹分析过程出现内部异常: ${error}`,
                history: history,
                title: 'none'
            };
        }
    }

    /** ### 修补员 / 审查员
     * @description 通用的修复与审查入口。根据外部传入的特定场景提示词，结合当前实时截图进行 AI 诊断。
     * @param promptText - 外部根据不同错误场景（验证码、偏离轨道、任务无法完成等）定制的提示词
     * @param params - AI 运行配置参数，包含设备实例、历史记录等
     * @returns 返回审查结果对象 { title: string, result?: any, history: any[], toolCalls: any[] }
     */
    async restorer(promptText: string, params: new_agent_run_params, abortSignal?: AbortSignal): Promise<any> {
        const timeoutSeconds = params.timeout || this.defaultTimeout;

        // 1. Android 代理
        const androidAgent = new AndroidAgent(params.device, 10);

        // 2. 实时采集故障现场截图（这是修补员进行判断的核心依据）
        logger(`[Restorer] 正在采集当前页面截图进行审查...`);
        const capResult = await androidAgent.screencap(80, 0, 'restore_scene.png', false, undefined, '修补员现场采集');

        // --- 坐标清理器：在截图采集后立即重置，确保“本次若无点击，下次则不显示” ---
        AndroidAgent.lastClick = { x: null, y: null, rawX: null, rawY: null };

        // 3. 构建消息历史：对传入的历史记录进行预清洗，切断之前的“空内容污染”，并注入现场截图
        const imageBASE64 = fs.readFileSync(capResult.filePath, { encoding: 'base64' });
        const messages: any[] = [
            ...this._sanitizeHistory(params.history || []),
            {
                role: 'user',
                content: [
                    { type: 'text', text: promptText },
                    { type: 'image', image: imageBASE64, mimeType: 'image/png' }
                ]
            }
        ];

        // 4. 执行 AI 诊断调用
        // 备注：目前采用 generateText 同步等待模式作为占位实现，后续可根据需求改为流式并添加正则解析逻辑
        logger(`[Restorer] 正在分析现场并尝试修复方案...`);

        // 加载并处理提示词
        const successHistoryStr = params.successHistory && params.successHistory.length > 0
            ? params.successHistory.join('\n')
            : '暂无已收集到的有效数据记录';

        const systemPrompt = this.getPrompt('restorer')
            .replace(/\$\{scaledWidth\}/g, '1000')
            .replace(/\$\{scaledHeight\}/g, '1000')
            .replace(/\$\{successHistory\}/g, successHistoryStr)
            .replace(/\$\{lastExecutorHistory\}/g, JSON.stringify(params.history || [])) // 将传入的操作历史转为字符串注入
            .replace(/\$\{reason\}/g, promptText)
            .replace(/\$\{input\}/g, params.input)
            .replace(/\$\{functionCalling\}/g, this.functionCalling_plan);

        try {
            const aiResponse = await (generateText as any)({
                model: this.model,
                system: systemPrompt,
                messages: messages,
                abortSignal: abortSignal,
                maxTokens: 1024,
                maxCompletionTokens: 1024,
                // temperature: 0.1,
            });

            // 4.5 解析回复中的工具调用 (使用共享解析私有方法)
            let parsedList = parseFunctionCall(aiResponse.text || '');

            // 【熔断机制】：修补员同样限制单次生成的任务基数，防止计划爆炸
            // if (parsedList.length > 5) {
            //     logger(`\n⚠️  [熔断] 诊断结论中生成的任务过多 (${parsedList.length} 个)，已自动截断为前 10 个。`, { error: true });
            //     parsedList = parsedList.slice(0, 10);
            // }
            const taskList = this._parsePlanningResponse(parsedList);
            const isWait = parsedList.some(p => p.tool === 'wait');
            const isStop = parsedList.some(p => p.tool === 'stop');

            // 5. 解析文本结果
            const thinkMatch = aiResponse.text?.match(/<think>([\s\S]*?)<\/think>/);
            const think = thinkMatch ? thinkMatch[1].trim() : '';
            const textMatch = aiResponse.text?.match(/<text>([\s\S]*?)<\/text>/);
            const parsedOutput = textMatch ? textMatch[1].trim() : (aiResponse.text || '').trim();
            const parsedText = parsedOutput || "【系统提示】修补员未能生成有效的修复策略。";

            const hasPlan = parsedList.some(p => ['makePlan', 'loopPlan', 'remakePlan'].includes(p.tool));

            // 6. 构造返回结构 (精简版：直接交付任务列表)
            // 6. 构造返回结构 (极致精简版：明确区分 停止、等待、重塑 或 仅诊断)
            let actionType: 'stop' | 'wait' | 'remakePlan' | 'none' = 'none';
            if (isWait) {
                actionType = 'wait';
            } else if (isStop) {
                actionType = 'stop';
            } else if (hasPlan) {
                actionType = 'remakePlan';
            }

            return {
                title: actionType,
                taskList: taskList,
                text: parsedText,
                think: think
            };

        } catch (error: any) {
            logger(`[Restorer] 运行失败: ${error.message || error}`, { error: true });
            return {
                title: "stop",
                text: error.message || "未知错误",
                think: ""
            };
        }
    }

    /** ### 检查员 (Inspector)
     * @description 根据 inspector.md 的逻辑，针对执行 Agent 的子任务报备进行视觉与逻辑审计。
     * @param params - 基础运行参数 (包含设备、缩放、超时等)。
     *   - `input`: **用户总需求**
     *   - `history`: **上一任务的操作历史**
     *   - `promptText`: **上一任务的完成报备** (success 内容)
     * @param allTaskList - 根据需求拆分的所有子任务清单
     * @param lastTask - 本次待检查的子任务内容记录
     * @param lastTaskInstructions - 在上个任务开始前给予执行 Agent 的操作提示及限制
     * @param abortSignal - 外部监控信号
     */
    async inspector(
        params: new_agent_run_params,
        allTaskList: any[],
        lastTask: string,
        lastTaskInstructions: string,
        abortSignal?: AbortSignal
    ): Promise<{ function: 'continue' | 'back' | 'restorer', text: string }> {
        const androidAgent = new AndroidAgent(params.device, params.waitingTime || 500);

        // 1. 准备系统提示词与业务数据拼接
        const systemPrompt = this.getPrompt('inspector');
        const taskListStr = allTaskList.map((t, i) => `${i + 1}. ${t.description}`).join('\n');
        const historyStr = (params.history || []).map(h => {
            if (h.role === 'assistant') return `[Action]: ${h.content}`;
            if (h.role === 'user' && typeof h.content === 'string') return `[Feedback]: ${h.content}`;
            return '';
        }).filter(Boolean).join('\n');

        // 1.1 获取当前页面层级状态 (包名/Activity/窗口栈)
        const currentState = await androidAgent.xml.getCurrentState();
        const hierarchyStr = currentState ?
            `当前应用：${currentState.context.current_app}\n  - 当前 Activity：${currentState.context.current_activity}\n  - 窗口堆栈：${currentState.context.window_stack.length > 0 ? `\n    ${currentState.context.window_stack.join('\n    ')}` : '无'}` :
            '获取失败';

        const inputPacket =
            `# 你获得的信息\n` +
            `- 用户需求：${params.input}\n` +
            `- 任务清单：\n${taskListStr}\n` +
            `- 上一任务：${lastTask}\n` +
            `- 上一任务历史记录：\n${historyStr}\n` +
            `- 上一任务的完成报备：${params.promptText || ''}\n` +
            `- 上一任务操作说明和限制：${lastTaskInstructions}\n` +
            // `- 页面层级：${hierarchyStr}\n` +
            `- 屏幕截图：已附加在消息中\n`;

        // 2. 获取环境截图 (优先使用外部传入，若无则实时截取)
        let imageBASE64 = '';
        const imagePath = params.images?.[0];
        if (imagePath && fs.existsSync(imagePath)) {
            imageBASE64 = fs.readFileSync(imagePath, { encoding: 'base64' });
        } else {
            logger(`[Inspector] 未能从外部获取到有效截图，正在实时截取验证...`, { debug: true });
            const capResult = await androidAgent.screencap(80, 0, 'inspector_screen.png', false, undefined, '检查员实时截图');
            imageBASE64 = fs.readFileSync(capResult.filePath, { encoding: 'base64' });
        }

        const messages: any[] = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: inputPacket },
                    { type: 'image', image: imageBASE64, mimeType: 'image/png' }
                ]
            }
        ];

        try {
            // 3. 发起 AI 请求 (使用 generateText 保证获取完整 XML)
            const result = await (generateText as any)({
                model: this.model,
                system: systemPrompt,
                messages: this._sanitizeHistory(messages),
                abortSignal: abortSignal,
                maxTokens: 1024,
                maxCompletionTokens: 1024,
                // temperature: 0.1,
                maxRetries: 1
            });

            const fullText = result.text || '';

            // 5. 正则解析结论及 logger 输出
            logger(`[Inspector] 本次核查任务: ${lastTask}`, { debug: true });

            if (fullText.includes('<continue>')) {
                logger(`\n[Inspector 审计结论]: 🟢 检查通过。`, { debug: true });
                return { function: 'continue', text: '' };
            } else if (fullText.includes('<back>')) {
                const backMatch = fullText.match(/<back>([\s\S]*?)<\/back>/);
                const backTextMatch = fullText.match(/<back_text>([\s\S]*?)<\/back_text>/);

                if (backMatch) {
                    logger(`\n[Inspector 审计结论 - BACK]:\n${backMatch[1].trim()}`, { debug: true });
                }

                return {
                    function: 'back',
                    text: backTextMatch ? backTextMatch[1].trim() : "执行员操作有误，请重新尝试。"
                };
            } else if (fullText.includes('<restorer>')) {
                const restorerMatch = fullText.match(/<restorer>([\s\S]*?)<\/restorer>/);
                const restorerText = restorerMatch ? restorerMatch[1].trim() : "计划偏离，需要重新梳理。";

                logger(`\n[Inspector 审计结论 - RESTORER]:\n${restorerText}`, { debug: true });
                return { function: 'restorer', text: restorerText };
            }

            // 兜底处理
            logger(`[Inspector] 未能精准匹配到函数标签，默认触发默认继续执行下一任务`, { error: true, debug: true });
            return { function: 'continue', text: '' };

        } catch (error: any) {
            logger(`[Inspector] 运行异常: ${error.message || error}`, { error: true, debug: true });
            return { function: 'back', text: `检查环节出现系统异常: ${error.message}` };
        }
    }

    /** ========== ⬆️ 角色板块 ⬆️ ============ */

    /** ### 内部私有方法：解析规划类（Planner/Restorer）生成的函数列表并转为任务列表
     * 支持 makePlan, remakePlan, loopPlan, restorer
     */
    private _parsePlanningResponse(parsedList: { tool: string, args: Record<string, any> }[]): { description: string, id: string, role: 'executor' | 'restorer', level: number }[] {
        const taskList: { description: string, id: string, role: 'executor' | 'restorer', level: number }[] = [];
        const generateId = (prefix = '') => prefix + Math.random().toString(36).substring(2, 9);

        parsedList.forEach(parsed => {
            const { tool, args } = parsed;
            // 1. 处理普通计划 (makePlan / remakePlan)
            if (tool === 'makePlan' || tool === 'remakePlan') {
                const items = args.allPlan || Object.values(args)[0];
                if (Array.isArray(items)) {
                    items.forEach(task => {
                        taskList.push({
                            description: String(task),
                            id: generateId(),
                            role: 'executor',
                            level: 0
                        });
                    });
                }
            }
            // 2. 处理循环计划 (loopPlan)
            else if (tool === 'loopPlan') {
                const items = args.allPlan || [];
                const count = parseInt(args.loopCount) || 0;
                const startNum = parseInt(args.startNumber) || 1;
                if (Array.isArray(items) && count > 0) {
                    for (let i = 0; i < count; i++) {
                        const currentNumber = startNum + i;
                        items.forEach(taskTemplate => {
                            const description = String(taskTemplate).replace(/\{\{startNumber\}\}/g, String(currentNumber));
                            taskList.push({
                                description,
                                id: generateId('loop-'),
                                role: 'executor',
                                level: 0
                            });
                        });
                    }
                }
            }
            // 3. 处理修补任务 (restorer) - 新增支持
            else if (tool === 'restorer') {
                const reason = args.reason || (typeof args === 'string' ? args : '数据填充与计划重塑');
                taskList.push({
                    description: String(reason),
                    id: generateId('restorer-'),
                    role: 'restorer',
                    level: 0
                });
            }
        });

        return taskList;
    }

    /** ### 内部私有方法：清洗历史记录，防止 API 400 报错
     * 规则：由于 Moonshot / Kimi 等 API 严禁 assistant 消息内容为空，在此进行强制占位符填充
     */
    private _sanitizeHistory(history: any[]): any[] {
        if (!Array.isArray(history)) return [];
        return history.map(msg => {
            if (msg.role === 'assistant' && (!msg.content || String(msg.content).trim().length === 0)) {
                return { ...msg, content: '【系统提示】该轮次 AI 未返回有效信息或发生响应异常，已自动填充占位。' };
            }
            return msg;
        });
    }
}
