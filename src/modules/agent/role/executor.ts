import { agent_Index } from '../agent_index.class.js';
import adbkit from '@devicefarmer/adbkit';
const { Adb } = adbkit;
import readline from 'readline';
import { exit } from 'process';
import fs from 'fs/promises'
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { logger } from '../../../utils/logger.js';
import path from 'path';
import { BaseModule } from '../adb/tools/BaseModule.class.js';

/** ### 执行的最终结果 */
interface execute_return {
    /** ### 执行的结果说明
     * @description
     * - `success` - 成功完成，递交结果直接进入下一阶段
     * - `requireCheck` - 表示需要检查
     * - `stepLimitExceeded` - 超过了当前最大的步数
     * - `failure` - 表示任务失败，需要人工接管时才返回这里
     * - `report` - 表示任务由于外界不可抗力（验证码等）无法继续，需要修补员
     */
    status: 'success' | 'stepLimitExceeded' | 'failure' | 'requireCheck' | 'report' | 'auditFailed',
    /** ### 审计失败时的详情 (可选) */
    inspectorResult?: any,
    /** ### 执行最后返回的结果
     * @description 结果是否成功根据status判定，这里这里是对结果的总结，说明等
     */
    result: string,
    /** ### 对话历史记录
     * @description 不管成功与否全量返回本次对话的所有历史记录
     */
    history: any[],
    /** ### 本轮最后一张截图路径 (用于检查员审计) */
    imagePath?: string
}

/**
 * ### 任务执行者
 * @description 核心任务执行引擎。通过循环调用 AI 并执行其下发的原子化工具动作（点击、输入、滑动等）来完成子任务。
 * @param userInput - 本次子任务的目标描述及上下文指令
 * @param maxIterations - 最大迭代步数，超限后会返回 stepLimitExceeded 状态
 * @param device - 已初始化的设备实例
 * @param auditPromise - (可选) 用于投机执行时挂起等待的审计 Promise
 * @param signal - (可选) 中断信号
 * @returns {Promise<execute_return>} 返回执行结果对象，包含状态（status）、结果总结（result）以及完整的对话上下文（history）
 */
export async function Executor(userInput: string, maxIterations: number = 15, device: any, auditPromise?: Promise<any>, signal?: AbortSignal): Promise<execute_return> {
    if (signal?.aborted) {
        return { status: 'failure', result: "任务已被手动终止", history: [] };
    }
    if (!userInput || userInput.trim().length < 1) {
        throw Error('请输入提示词');
    }

    // 1. 获取设备实例 (已通过参数传入)
    if (!device) {
        throw Error('❌ 未提供有效的设备实例');
    }

    // 2. 初始状态
    let history: any[] = [];
    let currentInput = userInput;
    let currentImages: string[] | undefined = undefined; // 存放本轮要发给 AI 的图片路径
    let finalStatus: 'success' | 'stepLimitExceeded' | 'failure' | 'requireCheck' | 'report' = 'failure';
    let finalResult = '';
    let lastImagePath = ''; // <--- 记录最后一次交互的图片路径
    const cleanInput = userInput.replace(/\n/g, '  '); // 将换行替换为空格保持单行紧凑
    const snipInput = cleanInput.length > 200 ? cleanInput.slice(0, 200) + '... (已省略)' : cleanInput;

    /** ### 上一轮 AI 返回的情况总结（用于带入下一轮增强感知） */
    let lastRoundFeedback = "";

    /** ### 上个回合是否调用函数，如果上个回合没有调用函数的话则为 true，下次提示词中需要增加提示 */
    let noFunction = false
    // 3. 初始化 Agent (自动加载系统设置)
    const agent = await agent_Index.create();
    logger(`\x1b[32m当前执行员已就绪，正在使用模型: ${agent.getCurrentModelName()}\x1b[0m`);

    try {
        for (let i = 0; i < maxIterations; i++) {
            logger(`\n[第 ${i + 1} 次迭代]...`);

            // 1. 核心需求：由 agent_index 自行处理上下文精简，此处不再硬编码过滤 user 角色
            // history = history.filter(msg => msg.role !== 'user');

            // 2. 构建本步的引导词 (currentInput)
            if (i === maxIterations - 1) {
                // 最后一步的特殊引导
                currentInput = `【最终任务检查】\n当前任务是：“${userInput}”。\n` +
                    `这是执行的最后一步，请根据当前屏幕状态严格检查：\n` +
                    `1. 如果任务已完成：请调用 [success] 工具详细交接你完成的结果。\n` +
                    `2. 如果任务未完成：请总结目前的历史对话内容，说明已完成的进度、收集到的数据以及未完成的原因，且**必须调用 [report] 工具进行汇报**，严禁只输出文本回复。` +
                    `**请如实回答当前的状态。完成了就调用 success 递交结果，如果没有完成任务\`必须调用 report\` 函数并描述现状，严禁在未完成时调用 success！**`;
            } else {
                // 如果不是最后一步，直接使用用户的原始任务描述
                currentInput = userInput;
                // 如果当前有拦截到的新图片，可以在输入中提示一下 AI
                if (currentImages && (currentImages as string[]).length > 0) {
                    currentInput += `\n(备注：已附带你上一轮截获的屏幕图像，请结合分析进度继续执行任务。)`;
                }
            }

            // 当上一轮未调用任何函数时增加提示（移出 if-else 确保在最后一步也能触发）
            if (noFunction) {
                noFunction = false;
                currentInput += `\n提示：上一轮你未调用任何函数，请仔细分析当前的任务与状况，如果已经完成任务请调用 success ，如果未能完成或发生异常请**必须调用 report** 并详细说明情况，如果你需要等待请调用 wait 。`;
            }

            const response = await agent.chat('run', {
                input: currentInput,
                images: currentImages,
                sendState: true,
                device: device,
                waitingTime: 1000,
                history: history,
                auditPromise: auditPromise // 透传审计 Promise
            });

            // 记录本轮图片路径，供后续审计使用
            if (response.imagePath) {
                lastImagePath = response.imagePath;
            }

            // 更新历史记录 (逻辑修正：由于 agent.run 已经返回了全量包含旧历史的结果，直接赋值即可，避免 push 导致重复翻倍)
            history = (response as any).history;




            // 存入本轮返回的总结，用于下一轮迭代带入
            lastRoundFeedback = (response as any).text || "";

            // 显示 AI 本轮的状态总结和思考结论
            if ((response as any).text) {
                // logger(`\n🤖 AI 回复: ${(response as any).text}`, { debug: false });
            }

            // 重置本轮附加图片，准备拦截新的一轮
            currentImages = undefined;

            // 1. 【核心优化】优先打印工具执行情况并拦截图片，确保护理所有共存的工具调用
            response.toolResults?.forEach((tr: any) => {
                const resultData = tr.result || tr.output;
                // 控制台精简：底层 agent_index 已打印结果（带防刷屏截断），这里不再重复全量铺屏打印
                // console.log(`   🛠️  工具 [${tr.toolName}] 执行结果: ${JSON.stringify(resultData)}`);

                if (tr.toolName === 'scrollScreencap' && resultData && resultData.filePaths) {
                    currentImages = resultData.filePaths;
                    logger(`[agent] >>> 成功拦截滚动截屏，下轮将发送 ${currentImages?.length} 张图片证据`);
                }

                if (tr.toolName === 'gridScreencap' && resultData && resultData.filePath) {
                    currentImages = [resultData.filePath];
                    logger(`[agent] >>> 成功拦截网格截屏，下轮将发送该网格图片证据`);
                }
            });

            // 2. 检测并处理任务完成信号
            const successCall = response.toolCalls?.find((tc: any) => tc.toolName === 'success');
            if (successCall) {
                finalStatus = 'success';
                // [Debug] 打印原始注入参数以便排查为什么结果为 {}
                const rawArgs = successCall.args || successCall.input || {};
                // 控制台精简：如果传的字符串太大，我们屏蔽它，避免长篇大论的报告霸屏
                // console.log(`[Debug] 命中成功指令，参数详情:`, JSON.stringify(rawArgs));

                if (typeof rawArgs === 'string' && rawArgs.trim() !== '') {
                    finalResult = rawArgs;
                } else if (typeof rawArgs === 'object' && rawArgs !== null && Object.keys(rawArgs).length > 0) {
                    // 逻辑增强：优先取 result，其次取 description (部分模型幻觉)，最后取第一个有效字符串值
                    finalResult = (rawArgs as any).result || (rawArgs as any).description || Object.values(rawArgs).find(v => typeof v === 'string') as string || JSON.stringify(rawArgs);
                } else {
                    // 兜底：AI 经常把详细数据写在 text 中但 success 工具不传参数
                    // 从工具执行结果中取 message，再拼接 AI 本轮 text 回复，确保数据不丢失
                    const successResult = response.toolResults?.find((tr: any) => tr.toolName === 'success');
                    const toolMessage = successResult?.result?.message;
                    finalResult = toolMessage || response.text?.trim() || '任务已顺利完成';
                }
                const snipSuccess = finalResult.length > 80 ? finalResult.slice(0, 80) + '... (已省略长摘要)' : finalResult;
                logger(`\n✅ 任务执行成功`, { debug: true });
                break;
            }

            // 2.5 检测并处理报告/异常上报信号 (触发修补员关键点) - 报告异常，退出循环触发修补员
            const reportCall = response.toolCalls?.find((tc: any) => tc.toolName === 'report');
            if (reportCall) {
                finalStatus = 'report';
                const rawArgs = reportCall.args || reportCall.input || {};
                finalResult = typeof rawArgs === 'string' ? rawArgs : (rawArgs.reason || rawArgs.text || JSON.stringify(rawArgs));
                logger(`\n🚩 任务由于不可抗力上报异常: ${finalResult}`, { debug: true });
                logger(`* 正在修复异常`, { debug: false });
                break;
            }

            // 3. 容错判断：如果 AI 既没说成功也没调用动作工具
            if (!response.toolCalls || response.toolCalls.length === 0) {
                // 如果是物理网络超时导致的空返回，需要特殊上报
                if (response.finishReason === 'timeout') {
                    logger(`\n❌ [Executor 异常] AI 响应超时 (Stream Timeout)，已强制中断并上报原因给修补员。`, { error: true });
                    finalStatus = 'report';
                    finalResult = `AI 生成流在执行过程中超时（可能由于代理不稳定或模型负载过高），无法获取有效动作。`;
                    break;
                }

                logger(`\n[Debug] ⚠️ AI 未调用任何工具，暂时关闭任务终止。`);
                finalStatus = 'requireCheck';
                finalResult = `【严重警告】：检测到你本轮未能成功调用工具函数（或者参数格式错误）。请务必检查你的输出格式，确保在 <function> 标签中调用定义的工具函数（例如：<function>click(x=100, y=200)</function>），且参数必须符合 key=value 的定义。上一轮回复为：${response.text || '未接受到信息或传入<text>调用错误'}`;
                noFunction = true
                // break;
            }

            // 步数超限检查
            if (i === maxIterations - 1) {
                finalStatus = 'stepLimitExceeded';
                // 确保将 AI 最后一轮的回复告知规划器，以便修补员接手
                const aiThoughts = response.text ? ` AI 最后一次尝试的回复是: "${response.text}"` : ' AI 未留下最后回复。';
                finalResult = `子任务执行步数已达上限 (${maxIterations} 步)，任务未完全结束。${aiThoughts}`;
            }
        }
    } catch (error: any) {
        if (error.name === 'AuditFailedError') {
            return {
                status: 'auditFailed',
                result: error.message,
                history: history,
                inspectorResult: error.inspectorResult
            };
        }
        logger(`Executor 运行异常: ${error}`, { error: true });
        return {
            status: 'failure',
            result: `程序运行出错: ${error.message || '未知错误'}`,
            history: history
        };
    }

    logger(`\n--- [任务结束] ---`);
    return {
        status: finalStatus,
        result: finalResult,
        history: history,
        imagePath: lastImagePath // 返回最后一张截图路径
    };
}

