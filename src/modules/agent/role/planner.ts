import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { Executor } from "./executor.js";
import { agent_Index } from "../agent_index.class.js";
import adbkit from '@devicefarmer/adbkit';
const { Adb } = adbkit;
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { logger } from "../../../utils/logger.js";
import { DevicesManager, type DeviceInfo } from "../../devices/devicesManager.class.js";
import Settings from "@/modules/setting/settings.js";

// 颜色控制辅助函数
const useColor = process.env.NO_COLOR !== 'true';
const color = {
    green: (text: string) => useColor ? `\x1b[32m${text}\x1b[0m` : text,
    red: (text: string) => useColor ? `\x1b[31m${text}\x1b[0m` : text,
    gray: (text: string) => useColor ? `\x1b[90m${text}\x1b[0m` : text,
    yellow: (text: string) => useColor ? `\x1b[33m${text}\x1b[0m` : text,
    blue: (text: string) => useColor ? `\x1b[34m${text}\x1b[0m` : text,
    reset: (text: string) => useColor ? `\x1b[0m${text}` : text,
};

/** ### 任务列表中的子任务
 * @returns
 * ```
 * [
 *      { description: '打开淘宝应用', level: 1 },
 *      { description: '点击淘宝首页搜索框', level: 1 }
 * ]
 * ```
 */
interface taskChild {
    /** ### 子任务内容描述 */
    description: string,
    /** ### 任务难度
     * @description 表示任务的难度等级，共四级，0,1,2,3 级
     * 最终难度等级都会被换算成 step 步数
     * - `1` - 简单 5步
     * - `2` - 中等 10步
     * - `3` - 复杂 15步
     * - `0` - 难度不确定 8步
     */
    level: number,
    /** ### 任务执行角色
     * @description
     * - `executor` - 执行人员（默认，负责操作设备并收集数据）
     * - `coordinator` - 统筹员（负责分析、对比和总结已收集的数据）
     */
    role?: 'executor' | 'coordinator' | 'restorer',
    /** ### 任务唯一识别码 */
    id?: string,
    /** ### 任务辅助提示或调整说明（由分配专家分析得出） */
    text?: string
}

/** ### 计划者的最终执行结果 */
export interface planner_return {
    /** ### 任务最终执行状态
     * @description
     * - `success` - 任务顺利完成（由统筹员判定或自然结束）
     * - `failure` - 任务由于中间过程报错、环境、配置问题而失败
     * - `interrupted` - 任务被外部中断或中途停止
     */
    status: 'success' | 'failure' | 'interrupted',
    /** ### 最终结论 
     * @description 通常是统筹员对整个任务执行后的数据汇总或状态说明
     */
    result: string,
    /** ### 全量历史记录 
     * @description 包含规划、执行、统筹、修补的所有对话上下文
     */
    history: any[],
    /** ### 最终的任务列表 
     * @description 任务结束时实际生成的任务清单（包含动态新增的修补任务）
     */
    taskList: taskChild[]
}



/** ### 计划者
 *  
 */
export class planner {

    /** ### 是否继续执行任务
     *  @description 
     *  - `true` - 接下来需要继续执行任务
     *  - `false` - 任务执行完毕，或者计划有变等情况需要结束执行任务时使用
     */
    private continue: boolean
    /** ### 当前计划者的主历史记录，最终任务结束或终止的历史记录也会被加到这里来 */
    private history: any[]
    /** ### 最近一次执行任务的历史记录详情 (用于带给修补员进行分析) */
    private lastExecutorHistory: any[]
    /** ### 全部的任务列表 (动态变动) */
    private taskList: taskChild[]
    /** ### 最初生成的原始任务列表 (静态锚点) */
    private primaryTaskList: taskChild[]
    /** ### 当前执行到的任务 index */
    private current_task: number
    /** ### 挂起的审计任务
     * @description 如果当前任务需要检查时会在执行结束后生成 `检查人员` promise 后等待下一轮开始后传入 `执行人员` 中与下一轮的执行人员并行处理，但是执行人员 function calling 阶段会进行等待，如果检查成功则正常执行，检查失败则推出并返回检查失败，在外部会退回上一操作步骤重新操作
     */
    private pendingInspectorPromise: Promise<any> | undefined = undefined;


    constructor() {
        this.continue = true
        this.history = []
        this.lastExecutorHistory = []
        this.current_task = 0
        this.taskList = []
        this.primaryTaskList = []
        this.pendingInspectorPromise = undefined
    }

    /** ### 检查运行环境 (模型配置与设备连接)
     * @returns 返回设备列表，如果校验失败返回 null
     */
    public static async checkEnvironment(): Promise<DeviceInfo[] | null> {
        try {
            await agent_Index.create();
        } catch (e: any) {
            console.log(color.red(`\n❌ [模型配置故障]：${e.message}`));
            return null;
        }

        const list: DeviceInfo[] = await DevicesManager.getInstance().listDevices();
        if (!list || list.length === 0) {
            console.log(color.red("\n❌ 错误：未检测到任何在线安卓设备。"));
            console.log(color.gray("提示：请确保设备已连接并开启 ADB 调试模式，且在控制台中能看到设备列表。"));
            return null;
        }

        // 打印设备列表
        const printList = list.map(i => {
            const { device, ...rest } = i;
            return rest;
        });
        console.table(printList);
        return list;
    }

    /** ### 任务分解
     * @param input 用户输入
     */
    public static async decompose(input: string): Promise<any | null> {
        try {
            return await agent_Index.beforePlanning(input);
        } catch (planError: any) {
            console.log(color.red(`\n[模型配置错误] 规划任务失败：`));
            console.log(color.yellow(`原因: ${planError.message}`));
            return null;
        }
    }

    /** ### 计划任务
     * @description 对一项完整的任务进行细分后分发给执行者，或者当计划有变的时候对任务进行修订
     * @param input 用户输入问题
     * @param deviceId 设备ID
     * @param signal 中断信号
     * @param onProgress 进度回调
     */
    async planning(input: string, deviceId: string, signal?: AbortSignal, onProgress?: (progress: { currentStep: number; totalSteps: number; stepDescription: string; role: string; result?: string }) => void): Promise<planner_return> {
        if (signal?.aborted) {
            return { status: 'failure', result: "任务已被手动终止", history: this.history, taskList: this.taskList };
        }
        logger(`\n[Planner] 正在思考规划任务: "${input}"`);
        let finalResult = "";

        // 1. 初始化 Agent (自动从系统设置加载激活的模型)
        const agent = await agent_Index.create();
        logger(`\x1b[32m当前计划者已就绪，正在使用模型: ${agent.getCurrentModelName()}\x1b[0m`);

        // 连接设备
        const client = Adb.createClient();
        const device = client.getDevice(deviceId);
        if (device) {
            logger(`[Planner] 已成功连接设备: ${deviceId}`);
        } else {
            return { status: 'failure', result: "设备连接失败", history: this.history, taskList: this.taskList };
        }

        // 打印“任务开始”提示信息
        const isDebug = process.env.DEBUG === 'true';
        if (!isDebug) {
            logger(`\x1b[32m正在生成计划...\x1b[0m`, { debug: false });
            // process.stdout.write(`\n\x1b[34m 正在规划任务....\x1b[0m\r`);
        } else {
            logger(`\n[Planner] 正在思考规划任务: "${input}"`);
        }

        // 开始计划任务
        const res = await agent.chat('plan', {
            input: input,
            history: this.history,
            sendState: false,
            device: device,
            signal: signal // 透传中断信号
        } as any);
        this.history = res.history;
        if (!(res.taskList && res.taskList.length > 0)) {           // 校验计划结果
            logger(`\n[Planner 错误] AI 未能生成任何有效的任务计划。`, { error: true });
            if (res.finishReason === 'stop' && res.text === '') {
                logger(`提示: 模型返回了空结果（可能是由于安全策略拒答或模型名错误）。`, { debug: true });
            }
            logger(`[Planner 错误详情]:\n ${JSON.stringify({ finishReason: res.finishReason, usage: res.usage }, null, 2)}`);
            return { status: 'failure', result: "AI 未能生成任何有效的任务计划", history: this.history, taskList: this.taskList };
        }
        this.taskList = res.taskList;
        this.primaryTaskList = JSON.parse(JSON.stringify(res.taskList));

        // 打印“计划完成”提示信息 和 打印任务列表
        if (!isDebug) {
            process.stdout.write(`\r\x1b[K\x1b[32m* 任务规划已完毕 \x1b[0m\n`);
        }
        this.printTaskList();

        // 等待检查屏幕状态，如果熄屏系统自动先唤起屏幕
        try {
            const { AndroidAgent } = await import("../adb/tools/AndroidAgent.class.js");
            const androidAgent = new AndroidAgent(device as any, 0);
            const isOn = await androidAgent.isScreenOn();
            if (!isOn) {
                logger(`\n[Planner] 🚀 检测到设备屏幕处于熄灭状态，正在执行唤醒并自动解锁...`);
                await androidAgent.unlockScreen();
                logger(`[Planner] ✨ 屏幕唤醒与自动解锁流程已完成。`);
            }
        } catch (e: any) {
            logger(`[Planner] 自动唤醒屏幕失败: ${e.message || e}`, { error: true });
        }

        // 初始化步骤分析池 （拆解每一步的步数）
        const resolvedPool = new Map<string, { level: number, role: any }>();
        /** ### 上一个任务的名称 */
        let lastTaskName = "";
        /** ### 上一个任务的执行结果说明 */
        let lastTaskResult = "";
        /** ### 执行的 success 结果 */
        const collectedResults: string[] = [];

        while (this.continue && this.current_task < this.taskList.length) {
            // 每轮循环开始前检查中断信号
            if (signal?.aborted) {
                logger(`\n[Planner] 🛑 接收到终止信号，正在停止任务...`);
                return { status: 'failure', result: "任务已被手动终止", history: this.history, taskList: this.taskList };
            }
            /** ### 当前任务 */
            const task = this.taskList[this.current_task];
            /** 是否原地重试本轮任务 (用于审计失败时的纠偏) */
            let isRetry = false;
            /** ### 评审人员任务 + 本轮角色任务 promise.all 池 */
            let allTask: Promise<any>[] = [];

            /** 评审人员任务 */
            const task1 = (async () => {
                // 步数评估，任务分析 人员   （针对下一步骤，本次步骤不做评价）  
                const nextIdx = this.current_task + 1;
                if (nextIdx < this.taskList.length) {
                    const nextT = this.taskList[nextIdx];
                    if (nextT.role !== 'restorer' && nextT.level === 0) {
                        if (nextT.id && resolvedPool.has(nextT.id)) {   // 评估过此类型不再进行二次评估
                            const cached = resolvedPool.get(nextT.id)!;
                            nextT.level = cached.level;
                            nextT.role = cached.role;
                        } else {        // 从这里启动评估   
                            try {
                                // 构造全局上下文提示词，给评估专家提供完整视野
                                const evalPrompt =
                                    `# 信息包\n` +
                                    `- 当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n` +
                                    `- 用户需求：${input}\n` +
                                    `- 子任务清单：\n${this.taskList.map((t, idx) => `  ${idx + 1}. ${t.description}`).join('\n')}\n` +
                                    `- 下一子任务：${nextT.description}`;

                                const evalRes = await agent.plan_setStep(evalPrompt, {
                                    input: nextT.description,
                                    sendState: false,
                                    device: null as any,
                                    signal: signal // 透传中断信号
                                } as any);

                                // 角色锁定检查：如果已经被修改为其他角色了直接跳过修改防止撞车
                                const isBeModified = nextT.role && nextT.role !== 'executor';
                                if (isBeModified) return;

                                switch (evalRes.role) {
                                    case 'executor':        // 执行人员
                                        // 更新难度评级
                                        nextT.level = evalRes.level;
                                        // 注入专家辅助提示 (如果有)
                                        if (evalRes.text) {
                                            nextT.text = evalRes.text;
                                        }
                                        break;

                                    case 'coordinator':     // 统筹人员
                                        nextT.role = 'coordinator';
                                        nextT.level = 0; // 统筹员固定 0 级
                                        break;

                                    case 'restorer':        // 计划/修补人员
                                        // 插入一个新的修补任务，而不是覆盖原任务项
                                        const restorerStep: taskChild = {
                                            description: evalRes.text || "计划重塑与数据注入",
                                            level: 0,
                                            role: 'restorer',
                                            id: `restorer-${Math.random().toString(36).substring(2, 9)}`,
                                            text: evalRes.text // 同时保留在 text 中
                                        };
                                        // 将修补任务插入到当前任务的后方（即下一个执行位置）
                                        this.taskList.splice(nextIdx, 0, restorerStep);
                                        // 打印插入提醒
                                        logger(`\n[Planner] 🛠️  发现专家建议进行计划重塑，已自动在步骤 [${nextIdx + 1}] 插入修补任务。`, { debug: true });
                                        break;
                                }

                                // 2. 同步状态到已解决池
                                if (nextT.id) {
                                    resolvedPool.set(nextT.id, {
                                        level: nextT.level || 0,
                                        role: nextT.role || 'executor'
                                    });
                                }


                            } catch (e: any) {
                                /* 评级失败保持默认 */
                                logger(`[plan_setStep] 评级失败已使用默认值, ${e.message || e}`);
                            }
                        }
                    }
                }
            })()


            /** 对应的角色任务 */
            const task2 = (async () => {

                // --- 上一步操作的检查 promise ，后续操作如果不是执行人员 Executor 则直接进行检查，不采用并行 ---
                if (this.pendingInspectorPromise && task.role !== 'executor') {
                    logger(`[Planner] ⏳ 正在等待上一步审计结果以继续 [${task.role}] 任务...`);
                    const inspectorResult = await this.pendingInspectorPromise;
                    this.pendingInspectorPromise = undefined;

                    if (inspectorResult.function === 'back') {
                        logger(`[Planner/审计同步] ❌ 上一步审计未通过。正在回退...`);
                        const failedTask = this.taskList[this.current_task - 1];
                        failedTask.text = inspectorResult.text;

                        collectedResults.pop();     // 清除上一步存入的成功数据
                        this.current_task--;
                        isRetry = true;
                        return;
                    } else if (inspectorResult.function === 'restorer') {
                        logger(`[Planner/审计同步] ⚠️ 上一步审计触发计划重塑。`);
                        const restorerReason = inspectorResult.text || "检查员由于审计异常触发计划重塑";

                        // 由于触发了重塑，上一步的结果也是无效的，同步清理
                        collectedResults.pop();     // 清除上一步存入的成功输出
                        this.taskList.splice(this.current_task, 0, {
                            description: restorerReason,
                            level: 0,
                            role: 'restorer'
                        });
                        // 插入后保持当前索引不变，下一轮循环将执行这个 restorer
                        isRetry = true;
                        return;
                    }
                }

                // 本次执行的角色判定
                if (task.role === 'coordinator') {

                    // 【角色分支】：统筹员任务
                    //  角色说明：当任务结束的时候对数据进行整理并返回给用户

                    logger(`\n[Planner] >>>>>>>>>> 正在执行第 ${this.current_task + 1}/${this.taskList.length} 个子任务: ${task.description} <<<<<<<<<<`);
                    logger(`\n\x1b[36m*  正在处理任务结果...\x1b[0m`, { debug: true });

                    const promptText = `【最终目标】\n${input}\n\n` +
                        `【所有子任务】\n${this.taskList.map((t, idx) => `${idx + 1}. ${t.description}`).join('\n')}\n\n` +
                        `【子任务完成后整理出来的有效结果】\n${collectedResults.length > 0 ? collectedResults.join('\n') : '暂无有效数据'}\n\n` +
                        `【子任务任务描述】\n${task.description}`;

                    const coordinatorResponse = await agent.chat('coordinator', {
                        input: task.description,
                        sendState: false,
                        device: null as any,
                        promptText,
                        isLastStep: this.current_task === this.taskList.length - 1,
                        history: this.lastExecutorHistory,
                        signal: signal // 透传中断信号
                    } as any);

                    const coordinatorResult = coordinatorResponse.result;
                    finalResult = coordinatorResult;

                    logger(`\n[Coordinator / 统筹分析结论]:\n${coordinatorResult}\n\n-----------------------------------------------------------`);
                    logger(`\n\x1b[32m* 任务执行结论：\x1b[0m\n${coordinatorResult}\n`, { debug: false });

                    // 判定是否主动停机或申请纠偏
                    if (coordinatorResponse.title === 'stop') {
                        logger(`[Planner] 统筹员判定任务已完成，正在主动结束任务...`);
                        this.history.push({ role: 'assistant', content: `[任务完成] 统筹员最终结论：${coordinatorResult}` });
                        this.continue = false;
                    } else if (coordinatorResponse.title === 'restorer') {
                        logger(`\n[Planner] 统筹员判定任务【未真正完成】，正在请求修补员介入纠偏...`);
                        logger(`[纠偏原因]: ${coordinatorResponse.restorerReason}`);
                        logger(`\x1b[33m⚠️  正在重新调整计划...\x1b[0m`, { debug: false });

                        // 在当前任务之后立即插入一个修补任务，由修补员执行最终重塑
                        this.taskList.splice(this.current_task + 1, 0, {
                            description: `[统筹层发现偏差] ${coordinatorResponse.restorerReason}`,
                            level: 0,
                            role: 'restorer'
                        });
                    }

                    lastTaskName = task.description;
                    lastTaskResult = coordinatorResult; // 把统筹结果传递下去，当作下一步执行的基础

                } else if (task.role === 'restorer') {

                    // 【角色分支】：修补员
                    //  角色说明：当子任务发现当前状态已经偏离预定轨道的时候发送计划重组调用

                    logger(`\n` + color.red(`[Planner] >>>>>>>>>> 大模型执行第 ${this.current_task}/${this.taskList.length} 个子任务时当前状态可能已经偏离预定轨道正在申请重新规划任务 <<<<<<<<<<`));
                    logger(`\n\x1b[33m🛠️  正在修正执行偏差...\x1b[0m`, { debug: true });

                    const promptText =
                        `【用户需求】\n${input}\n\n` +
                        `【原定计划】\n${this.taskList.map((t, idx) => `${idx + 1}. ${t.description}`).join('\n')}\n\n` +
                        `【已完成任务】\n${collectedResults.length > 0 ? collectedResults.join('\n') : '暂无有效数据'}\n\n` +
                        `【上一子任务操作历史】\n${this.lastExecutorHistory}\n\n` +
                        `【反馈问题】\n${task.description}\n\n`

                    const restorerResult = await agent.chat('restorer', {
                        input: task.description,
                        device: device,
                        sendState: true,
                        history: this.lastExecutorHistory,
                        successHistory: collectedResults, // 注入已成功获取到的记录
                        promptText: promptText,
                        signal: signal // 透传中断信号
                    } as any);

                    // 打印修补员的思考与结论
                    if (restorerResult.text) {
                        logger(`\n[Restorer 诊断结论]:\n${restorerResult.text}`);
                        logger(`\x1b[33m💡 修正诊断：${restorerResult.text.slice(0, 50)}...\x1b[0m`, { debug: true });
                    }

                    // 处理修补员返回的新计划 (识别结果并根据 title 分支处理)
                    if (restorerResult.title === 'wait') {
                        logger(`[Planner/等待接管] 修补员申请人工智能辅助接管（如：输入验证码、登录账号等），正在暂停任务并寻求人工介入...`);
                        logger(`\x1b[33m⏳ 任务等待中：${restorerResult.text}\x1b[0m`, { debug: false });


                        /* 
                            
                        ===================================================
                        此处 wait 方案需要后期修改，当前沿用的是 stop 后续方法执行
                        ===================================================
                            
                            */


                        const coordinatorSummaryTask = {
                            description: `[系统提示] 由于修补员申请人工接管（原因：${restorerResult.text}），当前流程已暂停。请对当前已执行的所有操作、已收集的数据以及修补员的诊断结论进行最后的统筹汇总，并向用户提供清晰的最终报告，说明需要哪些人工操作方可继续。`,
                            level: 0,
                            role: 'coordinator' as const,
                            id: 'coordinator_wait_summary'
                        };
                        // 保持计划，仅在当前任务后插入一个暂停汇总任务
                        this.taskList.splice(this.current_task + 1, 0, coordinatorSummaryTask);
                        logger(`[Planner] 已安排统筹员进行任务暂停前的状态汇总。`);
                    } else if (restorerResult.title === 'stop') {
                        logger(`[Planner/停机报告] 修补员判定任务无法继续，已主动停止任务。\n${restorerResult.text}`);
                        logger(`\x1b[31m⛔ 计划已终止。\x1b[0m`, { debug: false });

                        const coordinatorSummaryTask = {
                            description: `[系统提示] 由于修补员评估任务无法继续（原因：${restorerResult.text}），当前流程已提前终止。请对当前所有的任务计划执行情况、已收集的数据以及修补员的诊断结论进行最后的统筹汇总，并向用户提供清晰的最终报告。`,
                            level: 0,
                            role: 'coordinator' as const,
                            id: 'coordinator_final_summary'
                        };

                        // 真正的停止，则截断后续任务
                        this.taskList.splice(this.current_task + 1, this.taskList.length - (this.current_task + 1), coordinatorSummaryTask);
                        logger(`[Planner] 已安排统筹员进行最后的任务汇总报告。`);
                    } else if (['remakePlan', 'loopPlan', 'makePlan'].includes(restorerResult.title) && restorerResult.taskList && restorerResult.taskList.length > 0) {
                        // 直接注入底层生成的结构化任务表，不再需要手动创建 ID 和 Level
                        this.taskList.splice(this.current_task + 1, this.taskList.length - (this.current_task + 1), ...restorerResult.taskList);
                        // 同步更新原始清单，确保后续修补审计基于最新的有效里程碑
                        this.primaryTaskList = JSON.parse(JSON.stringify(this.taskList));

                        logger(`\n[Planner] 修补员已成功介入，新生成了 ${restorerResult.taskList.length} 个任务步骤。修正后的执行序列如下：`);
                        if (isDebug) this.printTaskList();
                        logger(`\x1b[32m✅ 计划已重组，新增 ${restorerResult.taskList.length} 个步骤。\x1b[0m`, { debug: true });
                    } else {
                        // 【异常兜底逻辑】：修补员仅返回了诊断文字（none）或生成的计划为空时
                        logger(`\n[Planner/修复受阻] 修补员未提供有效修正计划，仅提供了诊断结论。正在切换到终审模式...`);

                        // 1. 记录该诊断信息到最终结果集，防止统筹员丢失上下文
                        collectedResults.push(`[修补员诊断结论]: ${restorerResult.text}`);

                        // 2. 构造一个包含“修复失败”专项提示词的统筹任务
                        const repairFailureSummaryTask = {
                            description: `[系统提示] 前序修补员未能给出有效的修正计划（仅提供诊断：${restorerResult.text}）。当前计划未做更新，请统筹员检查当前还能继续完成任务。如果可以，请给出具体补救操作建议；如果不能，请客观说明具体阻碍因素并调用 stop。`,
                            level: 0,
                            role: 'coordinator' as const,
                            id: 'repair_failure_summary'
                        };

                        // 仅插入诊断任务，保留原本的后续计划，防止由于个别步骤抖动导致全局计划丢失
                        this.taskList.splice(this.current_task + 1, 0, repairFailureSummaryTask);
                        logger(`[Planner] 已强制追加统筹任务以处理修复受阻情况。`, { error: true });
                    }

                } else {

                    // 【角色分支】：执行人员任务
                    // 1. 根据 level 换算步数 (1级:5步, 2级:10步, 3级:15步, 0级:8步)
                    const levelToSteps: Record<number, number> = { 1: 5, 2: 10, 3: 15, 0: 8 };
                    const steps = levelToSteps[task.level] || 8;

                    // 提取下一步计划（如果存在的话）
                    const nextTask = this.current_task + 1 < this.taskList.length ? this.taskList[this.current_task + 1] : null;

                    /** ### 是否需要后续检查  -->  是否包含 success 字段 */
                    const needCheck = task.text?.toLowerCase().includes('success') || false;

                    // 构建增强后的上下文边界输入：上一步（如有）、这一步、下一步（如有）
                    let taskExecutionInput = "";
                    if (this.current_task === 0) {
                        // 第一次执行：任务1 (当前), 任务2 (后续)
                        taskExecutionInput = `任务刚刚开始：你的【本次任务】是: ${task.description} \n`;
                        if (nextTask) {
                            taskExecutionInput += `你的【下个任务】是: ${nextTask.description} \n 。你需要先检查你的【本次任务】，确认完成了后，当你开始执行此任务的时候最后调用 success 函数`;
                        }
                    } else {
                        // 非第一次：上一个是任务1，当前是任务2
                        const lastTask = this.taskList[this.current_task - 1];
                        // 逻辑优化：如果是执行员任务则正常显示名称，否则显示通用完成状态，防止干扰
                        const lastTaskDesc = lastTask.role === 'executor' ? lastTaskName : "任务已完成，继续执行下一任务";

                        taskExecutionInput = `【上个任务】: ${lastTaskDesc}\n`
                        taskExecutionInput += `【本次任务】: ${task.description} \n`;

                        // 如果有本次操作的专家提示，则注入到这里 (紧跟任务2)
                        if (task.text) {
                            logger(`[plan_setStep] 🔔 本轮存在执行提示，提示词：\n\x1b[32m${task.text}\x1b[0m`)
                            taskExecutionInput += `【本次操作说明】: ${task.text} \n`;
                            if (needCheck) {
                                taskExecutionInput += `\n【⚠️ 重要审计提示】：在本任务最后调用 success 函数时，请务必保证停留在关键验证页面，不要进行任何多余操作，等待系统审计。`;
                            }
                        }
                        taskExecutionInput += `\n`;

                        // 如果有下一步，则是任务3 (展望下一步)
                        if (nextTask) {
                            taskExecutionInput += `【下个任务】: ${nextTask.description} \n ${needCheck ? '' : '当你开始执行此任务的时候同步调用 success 函数'}`;
                        }
                    }



                    logger(`\n[Planner] >>>>>>>>>> 正在执行第 ${this.current_task + 1}/${this.taskList.length} 个子任务: ${task.description} <<<<<<<<<<`);
                    logger(`\n\x1b[34m🚀 正在执行 [${this.current_task + 1}/${this.taskList.length}]: ${task.description}\x1b[0m`, { debug: true });

                    // 2. 执行当前的步数
                    // 2. 执行当前的步数 (透传审计 Promise 实现并行化)
                    const result = await Executor(taskExecutionInput, steps, device, this.pendingInspectorPromise, signal);
                    this.pendingInspectorPromise = undefined; // 消费后置空

                    // 执行人员 Promise 中断执行
                    if (result.status === 'auditFailed') {
                        const inspectorResult = result.inspectorResult || {};
                        const failedTask = this.taskList[this.current_task - 1];

                        if (inspectorResult.function === 'back') {
                            logger(`[Planner/审计同步] ❌ 投机执行被拦截。上一步审计未通过，正在回退重试...`);
                            failedTask.text = inspectorResult.text;

                            // --- 关键修正：清理已记录的脏数据 ---
                            collectedResults.pop();
                            this.current_task--;
                            isRetry = true;
                        } else if (inspectorResult.function === 'restorer') {
                            logger(`[Planner/审计同步] ⚠️ 投机执行被拦截。上一步审计触发计划重塑。`);
                            const restorerReason = inspectorResult.text || "检查员由于审计异常触发计划重塑";

                            // 由于触发了重塑，上一步的结果也是无效的，同步清理
                            collectedResults.pop();
                            this.taskList.splice(this.current_task, 0, {
                                description: restorerReason,
                                level: 0,
                                role: 'restorer'
                            });
                            isRetry = true;
                        }
                        return;
                    }

                    // 2. 将结果同步到“上次执行现场”历史记录中 (注意：这里不再污染主计划的 history)
                    this.lastExecutorHistory = result.history;

                    // 3. 分析执行的结果并判断是否继续执行
                    if (result.status === 'success') {
                        logger(`[Planner] 子任务执行成功: ${task.description}`);
                        logger(`\x1b[32m* 执行成功\x1b[0m`, { debug: false });

                        // 记录本次执行的任务名和结果，供下一轮拼装使用
                        lastTaskName = task.description;
                        lastTaskResult = result.result;

                        // 收集结果内容，留存给后续统筹任务使用
                        if (result.result) {
                            collectedResults.push(`[${task.description}] => ${result.result}`);
                        }

                        // 本次操作需要检查结果 (异步开启审计，不阻塞本轮循环)
                        if (needCheck) {
                            logger(`[Planner/检查员] 🔍 异步启动审计：${task.description}`);
                            this.pendingInspectorPromise = agent.chat('inspector', {
                                device: device,
                                input: input, // 用户总需求
                                history: result.history, // 上一任务历史
                                promptText: result.result, // 上一任务报备
                                images: [result.imagePath].filter(Boolean) as string[], // 透传截图路径
                                sendState: false, // 补充必填参数
                                allTaskList: this.taskList,
                                lastTask: task.description,
                                lastTaskInstructions: task.text || "",
                                signal: signal // 透传中断信号
                            } as any);
                        }


                    } else if (result.status === 'report') {
                        // 当执行员主动上报问题时
                        logger(`\n[Planner] 检测到执行员上报异常 [report]，正在请求修补员介入...`);

                        // 核心逻辑：即使遭遇异常，也将当时的反馈存入结果集，供统筹员最终分析
                        collectedResults.push(`[异常上报]: 子任务 【${task.description}】 遭遇阻断。上报原因: ${result.result}`);

                        const reportReason = `前序任务 [${task.description}] 执行时遇到异常，执行员请求重新规划任务，上报原因为: ${result.result}`;

                        if (this.current_task + 1 < this.taskList.length) {
                            // 将原本的下一步改为修补员
                            this.taskList[this.current_task + 1].role = 'restorer';
                            this.taskList[this.current_task + 1].description = reportReason;
                        } else {
                            // 追加一个修补专员任务
                            // 修复逻辑：使用 splice 在当前任务后立即插入修补员，确保下一轮循环直接进入修复流程
                            this.taskList.splice(this.current_task + 1, 0, {
                                description: reportReason,
                                level: 0,
                                role: 'restorer'
                            });
                        }
                    } else if (result.status === 'stepLimitExceeded') {
                        // 当执行员步骤超限时
                        logger(`\n[Planner] 检测到子任务步骤超限 [stepLimitExceeded]，正在请求修补员介入...`);

                        // 核心逻辑：即使超限，也将当时的反馈存入结果集，供统筹员最终分析
                        collectedResults.push(`[任务步骤超限]: 子任务 【${task.description}】 已执行达到上限。反馈内容: ${result.result}`);

                        // 构造包含 AI 最后思考内容的描述，让修补员知道进度
                        let limitReason = `任务 [${task.description}] 步数超限。执行反馈: ${result.result}`;

                        if (this.current_task + 1 < this.taskList.length) {
                            // 将接下来的任务替换为修补专员
                            this.taskList[this.current_task + 1].role = 'restorer';
                            this.taskList[this.current_task + 1].description = limitReason;
                        } else {
                            // 如果已经是最后一步，则追加修补员
                            // 修复逻辑：使用 splice 在当前任务后立即插入修补员，确保下一轮循环直接进入修复流程
                            this.taskList.splice(this.current_task + 1, 0, {
                                description: limitReason,
                                level: 0,
                                role: 'restorer'
                            });
                        }
                    } else if (result.status === 'failure') {
                        // 当执行员发生严重运行异常时
                        logger(`\n[Planner] 检测到子任务运行崩溃 [failure]，正在请求修补员进行紧急诊断...`, { error: true });

                        const failureReason = `任务 [${task.description}] 发生严重运行异常。报错详情: ${result.result}`;

                        if (this.current_task + 1 < this.taskList.length) {
                            this.taskList[this.current_task + 1].role = 'restorer';
                            this.taskList[this.current_task + 1].description = failureReason;
                        } else {
                            this.taskList.splice(this.current_task + 1, 0, {
                                description: failureReason,
                                level: 0,
                                role: 'restorer'
                            });
                        }
                    }

                }
            })()

            allTask.push(task1, task2)




            // --- 统一等待异步评级并递增任务索引 ---
            await Promise.all(allTask);
            if (!isRetry) {
                this.current_task++;

                // 调用进度回调，通知外部当前步骤已完成
                const finishedTask = this.taskList[this.current_task - 1];
                onProgress?.({
                    currentStep: this.current_task,
                    totalSteps: this.taskList.length,
                    stepDescription: finishedTask.description,
                    role: finishedTask.role || 'executor',
                    result: finalResult || undefined
                });
            }

            // 【兜底逻辑】：如果计划走到最后一步，且没有任何角色主动下达 stop 指令（意味着没能完美闭环并输出总结报告）
            // 此时必须强制追加一个统筹员进行“终审”，防止任务无声无息地结束，并强制 AI 检查是否有遗漏的里程碑。
            // 注意：通过判断最后一个任务的 ID 为 final_auto_checker，避免在 AI 没响应时陷入循环追加。
            if (this.current_task === this.taskList.length && this.continue && this.taskList[this.taskList.length - 1]?.id !== 'final_auto_checker') {
                logger(`\n[Planner/系统终审] 原始计划已执行完毕，正在强制追加“终审”统筹任务以确保目标达成...`);
                this.taskList.push({
                    description: `
[系统终审] 当前所有计划步骤已执行完毕。请务必结合【全量历史记录】进行最后的深度走读与复核：
1. 核心目标查验：对比原始总目标 "${input}"，检查是否已经达到用户的最终目标？
2. 数量与闭合检查：如果任务涉及具体的数量（如投递 10 份简历），由于你已经读到了任务列表末尾，请核对历史记录中所有执行成功的编号（success(...)报备内容）。如果当前成功数量小于目标总数，严禁直接停机！
3. 最终决策执行：
   - 若目标已百分百达成：请整理汇总所有关键数据，并调用 <function>stop()</function> 输出最终结论；
   - 若发现任务未闭环（如漏发了短信、查到了价格但没汇报、数量未达标）：请严禁调用 stop()，必须调用 <function>restorer(reason="说明缺失项")</function> 申请计划补丁以完成剩余任务；
   - 若确认存在为不可抗力导致失败（如账号封禁、App 必选更新、崩溃）：请调用 <function>stop()</function> 首先对用户已经完成的任务进行总结，最后并详细说明失败的具体原因。`,
                    level: 0,
                    role: 'coordinator',
                    id: 'final_auto_checker'
                });
            }
        }



        // 任务最终结束，输出全量结果
        return {
            status: this.continue ? 'interrupted' : 'success',
            result: finalResult || "任务规划执行完毕，但未产生具体的最终结论",
            history: this.history,
            taskList: this.taskList
        };
    }

    /** ### 打印当前的任务清单列表 */
    public printTaskList() {
        logger(`\n[Planner/计划清单] (当前进度: ${this.current_task + 1}/${this.taskList.length})`);
        this.taskList.forEach((element, index) => {
            const roleTag = element.role === 'restorer' ? color.red('[RESTORER]') : (element.role === 'coordinator' ? color.blue('[COORDINATOR]') : color.gray('[EXECUTOR]'));
            // 如果是当前正在执行的任务，增加标记
            const currentTag = index === this.current_task ? color.yellow(' >>>') : '    ';
            logger(`${currentTag} ${index + 1}. ${roleTag} [${element.id}] ${element.description}`);
        });
    }

}





import { printTitle, userInput } from '@/modules/CLI/ui.js';
import chalk from 'chalk'
import ora from 'ora'



/** CLI Agent 入口 */
export async function planner_start(deviceId?: string | null) {

    printTitle('--- 配置检查 ---', 'error');
    const list = await planner.checkEnvironment();


    if (!list) {

        // 环境检查失败，直接返回，主菜单会自动重新显示
        await new Promise(r => setTimeout(r, 2000))
        return;
    }

    // 优先使用传入的 deviceId，如果没有则使用自动检测到的第一个设备
    const targetDeviceId = deviceId || (list[0]?.id);

    const settings = await Settings.create();
    const modelName = settings.setting.activeModel?.modelName || '未知模型';

    const lang = settings.setting.language || 'zh-CN';
    const inputPlanMsg = lang === 'zh-CN' ? '请输入执行计划：' : 'Please enter your plan:';

    const input = await userInput({
        message: `${chalk.gray(`(${modelName})`)} ${inputPlanMsg}`
        // subtitle: '--- 请输入执行计划 ---'
    });

    if (!input || input.trim() === '') {
        printTitle('--- 未输入任何内容 ---', 'error');
        return;
    }

    printTitle('--- 任务开始 ---');

    try {

        const lang = settings.setting.language;
        const msg = lang === 'zh-CN' ? '* 正在规划任务...' : '* Planning tasks...';
        const greenPrint = (text: string) => chalk.green(text)
        const loadingORA = ora({
            spinner: {
                interval: 200, // Optional
                frames: [greenPrint('* 正在规划任务'), greenPrint('* 正在规划任务.'), greenPrint('* 正在规划任务..'), greenPrint('* 正在规划任务...')]
            }
        }).start()
        const beforePlanning = await planner.decompose(input);

        loadingORA.stop()

        if (!beforePlanning) {
            printTitle('--- 执行失败 ---', 'error')
            await new Promise(r => setTimeout(r, 2000))
            return
        };

        if (beforePlanning.agentTasks) {
            console.log(`任务规划完成`);
            console.table(beforePlanning.agentTasks);

            interface taskResultType {
                question: string;
                result: string;
            }
            const taskResult: taskResultType[] = [];
            for (const index in beforePlanning.agentTasks) {
                const p = new planner();
                const t = beforePlanning.agentTasks[index];

                console.log(`正在进行任务 ${Number(index) + 1}: ${t}`);

                // 使用 targetDeviceId
                const planResult = await p.planning(t, targetDeviceId);

                // 如果单项任务执行失败，直接抛出异常中断
                if (planResult.status === 'failure') {
                    throw new Error(planResult.result || '任务执行失败');
                }

                const result: taskResultType = {
                    question: t,
                    result: planResult.result
                };
                taskResult.push(result);
            }

            // 执行结束获取并美化打印结果
            const lang = settings.setting.language;
            const isZh = lang === 'zh-CN';

            // 执行结束获取并美化打印结果
            const totalWidth = 60;
            const reportTitle = isZh ? ' 任务执行报告 ' : ' Execution Report ';

            // 计算中文字符（占位 2 个单位）与英文字符
            const titleVisualLength = reportTitle.replace(/[\u4e00-\u9fa5]/g, 'aa').length;
            const sidePadding = Math.max(0, Math.floor((totalWidth - titleVisualLength) / 2));
            const headerLine = '='.repeat(sidePadding) + reportTitle + '='.repeat(totalWidth - sidePadding - titleVisualLength);

            logger('\n' + chalk.bold.green(headerLine));

            taskResult.forEach((res, i) => {
                const subTaskLabel = isZh ? '子任务' : 'Sub-task';
                const resultLabel = isZh ? '结果' : 'Result';
                logger(`\n${chalk.bold(`${i + 1}. ${subTaskLabel}:`)} ${res.question}`);
                logger(`${chalk.green(`   ${resultLabel}:`)} ${res.result}`);
            });

            logger(chalk.bold.green(`\n${'='.repeat(60)}\n`));

            // 等待用户确认，禁止清屏以保留上述报告
            await userInput({
                message: isZh ? '按回车键返回主菜单' : 'Press Enter to return to main menu',
                // subtitle: isZh ? '--- 任务已完成 ---' : '--- Task Completed ---',
                clear: false
            });
        }

    } catch (error: any) {
        console.error(chalk.red("\n❌ 执行时发生严重错误:"));
        console.error(chalk.yellow(error.stack || error.message || error));
        // 显式等待，防止 UI 被快速清除
        await userInput({
            message: '请检查上方错误信息后，按回车键返回主菜单',
            subtitle: '--- 执行异常 ---'
        });
    }

}


import { string } from "zod";
if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    planner_start()
}
