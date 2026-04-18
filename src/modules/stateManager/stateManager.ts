import { DevicesManager } from "../devices/devicesManager.class.js";
import { planner } from "../agent/role/planner.js";

/** ### planner 进度回调参数 */
export interface PlannerProgress {
    /** 当前步骤索引 (从 1 开始) */
    currentStep: number;
    /** 总步骤数 */
    totalSteps: number;
    /** 当前步骤描述 */
    stepDescription: string;
    /** 当前步骤角色 */
    role: string;
    /** 当前步骤结果摘要 (可选) */
    result?: string;
}

/** ### run_planner 返回值 */
export interface run_planner_result {
    state: "success" | "failure",
    message: string,
    deviceId?: string
}

/** ### 设备ID 对应的任务详情 */
export interface taskDetail {
    /** 设备 ID */
    deviceId: string;
    /** 用户输入的原始指令 */
    prompt: string;
    /** 任务当前状态 */
    status: 'running' | 'success' | 'failure';
    /** 实时日志（每一步执行的摘要） */
    logs: string[];
    /** 任务最终结果（完成后才有值） */
    result: string | null;
    /** 任务创建时间 */
    createdAt: Date;
    /** 当前进度描述 */
    completionRate: string;
    /** 任务中断控制器 (不参与序列化) */
    controller?: AbortController;
}

/** ### 状态管理器
 * @description 用来实现设备管理，任务开始，MCP任务进度查询，MCP设备任务状态，任务终止
 */
export class StateManager {
    /** 状态管理器单例 */
    private static instance: StateManager;
    /** ### 设备池
     * @description 里面存放当前设备的任务详情。Key 为 deviceId
     */
    private devicesPools: Map<string, taskDetail> = new Map();

    private constructor() {}

    /** ### 获取单例实例 */
    public static getInstance(): StateManager {
        if (!StateManager.instance) {
            StateManager.instance = new StateManager();
        }
        return StateManager.instance;
    }

    /** ### 获取设备号及详细信息
     * @description 获取设备的设备号及设备的详细信息，并对齐当前任务进度
     */
    async query_devices() {
        const manager = DevicesManager.getInstance();
        const connectedDevices = await manager.listDevices();

        return connectedDevices.map(device => {
            const task = this.devicesPools.get(device.id);
            
            return {
                id: device.id,
                model: device.model,
                type: device.type,
                isReady: device.isReady,
                alias: device.alias,
                // 只返回正在运行或有记录的任务详情
                currentTask: task ? {
                    status: task.status,
                    completionRate: task.completionRate,
                    prompt: task.prompt,
                    createdAt: task.createdAt
                } : null
            };
        });
    }

    /** ### 任务开始 planner.ts
     * @description 自动寻找空闲设备并开始 `planner.ts` 的计划任务
     * @param prompt 任务需求
     */
    async run_planner(prompt: string): Promise<run_planner_result> {
        // 1. 获取所有已连接设备
        const manager = DevicesManager.getInstance();
        const connectedDevices = await manager.listDevices();

        if (connectedDevices.length === 0) {
            return { state: "failure", message: "未检测到任何已连接的安卓设备" };
        }

        // 2. 找到空闲设备 (没有在 devicesPools 中，或者任务状态不是 running)
        const idleDevice = connectedDevices.find(device => {
            const task = this.devicesPools.get(device.id);
            return !task || task.status !== 'running';
        });

        if (!idleDevice) {
            return { state: "failure", message: "当前所有设备均在忙碌中，请稍后再试" };
        }

        if (!prompt || prompt.trim().length === 0) {
            return { state: "failure", message: "请提供有效的 prompt 指令" };
        }

        const deviceId = idleDevice.id;

        // 3. 初始化并存储任务状态
        const controller = new AbortController();
        const newTask: taskDetail = {
            deviceId: deviceId,
            prompt,
            status: 'running',
            logs: [],
            result: null,
            createdAt: new Date(),
            completionRate: "准备开始规划...",
            controller: controller
        };
        this.devicesPools.set(deviceId, newTask);

        // 4. 异步启动 planner (不使用 await，直接返回给 MCP 客户端)
        this.__execute_in_background(deviceId, prompt, controller.signal);

        return { 
            state: "success", 
            message: `任务已在设备 ${deviceId} 上开始`, 
            deviceId: deviceId 
        };
    }

    /** ### 任务进度查询 */
    async query_planner(deviceId: string): Promise<{state: "failure", message: string} | taskDetail> {
        const task = this.devicesPools.get(deviceId);
        if (!task) {
            return { state: "failure", message: `设备 ${deviceId} 当前没有活动任务或记录` };
        }

        // 如果任务正在运行中，额外检查下设备在线状态
        if (task.status === 'running') {
            const manager = DevicesManager.getInstance();
            const connectedDevices = await manager.listDevices();
            const isOnline = connectedDevices.some(d => d.id === deviceId);

            if (!isOnline) {
                return { 
                    state: "failure", 
                    message: `⚠️ 设备 ${deviceId} 已脱离连接，任务可能因为意外断线而中断。请检查手机 USB 连接、网络状态，并确保手机端已同意 ADB 调试授权。` 
                };
            }
        }

        return task;
    }

    /** ### 终止任务 */
    async abort_planner(deviceId: string): Promise<{ state: "success" | "failure", message: string }> {
        const task = this.devicesPools.get(deviceId);
        
        if (!task) {
            return { state: "failure", message: `未找到设备 ${deviceId} 的活动任务` };
        }

        if (task.status !== 'running') {
            return { state: "failure", message: `设备 ${deviceId} 当前没有正在运行的任务 (当前状态: ${task.status})` };
        }

        if (task.controller) {
            task.controller.abort();
            task.status = 'failure';
            task.result = "任务已被手动终止";
            task.completionRate = "已停止";
            task.logs.push(`[System] 用户通过指令终止了任务。`);
            
            return { state: "success", message: `设备 ${deviceId} 的任务已成功触发终止程序` };
        }

        return { state: "failure", message: `任务对象中缺失控制信号，无法终止` };
    }

    /** ### 后台执行逻辑 执行 planner.ts */
    private async __execute_in_background(deviceId: string, prompt: string, signal?: AbortSignal) {
        const task: taskDetail = this.devicesPools.get(deviceId)!;
        
        // 构造进度回调：每完成一步自动同步到 taskDetail
        const onProgress = (progress: PlannerProgress) => {
            if (signal?.aborted) return;
            task.completionRate = `[${progress.currentStep}/${progress.totalSteps}] ${progress.stepDescription}`;
            task.logs.push(`[${progress.role}] ${progress.stepDescription}${progress.result ? ' => ' + progress.result : ''}`);
        };

        try {
            const p = new planner();
            const result = await p.planning(prompt, deviceId, signal, onProgress);
            
            // 如果已被 abort_planner 终止，跳过状态更新，防止覆盖已设置的终止状态
            if (signal?.aborted) return;

            task.status = result.status === 'success' ? 'success' : 'failure';
            task.result = result.result;
            task.completionRate = task.status === 'success' ? '任务顺利完成' : '任务执行失败';
            
        } catch (error: any) {
            // 捕获 AbortError 或其他异常
            if (error.name === 'AbortError' || signal?.aborted) {
                task.status = 'failure';
                task.result = "任务已被手动终止";
                task.completionRate = "已停止";
            } else {
                task.status = 'failure';
                task.result = `发生异常: ${error.message || error}`;
                task.completionRate = '发生内部错误';
            }
        } finally {
            // 任务结束，释放控制器引用以防内存泄漏
            task.controller = undefined;
        }
    }
    
}