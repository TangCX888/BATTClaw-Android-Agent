import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { BaseModule } from './BaseModule.class.js';
import { logger } from '@/utils/logger.js';
import { createAdbTools } from '../adb.tools.js';
/** Activity 管理模块 (am): 启动应用、强杀进程、发送广播、任务栈查询等 */
export type ActivityManager_class_keys = Exclude<keyof ActivityManager, 'constructor' | 'runShell' | 'device' | 'waitingTime_default' | 'internalGetScreenSize' | 'runQueued'>;
export class ActivityManager extends BaseModule {
    constructor(device: DeviceClient, waitingTime: number) {
        super(device, waitingTime);
    }

    /** ### 启动应用或网页 (am start)
     * 通过 Android `ActivityManager` 发送 Intent，启动目标 Activity 或在浏览器中打开 URL。
     * 
     * 关联工具: {@link createAdbTools}
     * @param intent 意图字符串，支持以下两种格式：
     *   - 包名/Activity：`com.example.app/.MainActivity`
     *   - URL：`https://www.example.com`
     * @returns {Promise<void>} 命令发送后返回，不等待 Activity 完全加载
     * @example
     * ```typescript
     * await am.start('com.tencent.mobileqq/.activity.SplashActivity'); // 启动 QQ
     * await am.start('https://www.baidu.com'); // 在默认浏览器开网页
     * ```
     */
    async start(intent: string, waitingTime?: number): Promise<string> {
        return this.runQueued(async () => {
            let cmd = `am start ${intent}`;
            
            // 增强逻辑：如果是纯包名（不包含 / 或空格），则使用 monkey 命令启动，这是最稳健的 LAUNCHER 启动方式
            if (!intent.includes('/') && !intent.includes(' ') && intent.includes('.')) {
                logger(`[ActivityManager] 检测到纯包名，使用 monkey 万能启动模式...`);
                cmd = `monkey -p ${intent} -c android.intent.category.LAUNCHER 1`;
            }

            logger(`[ActivityManager] 队列执行: ${cmd}`);
            const output = await this.runShell(cmd);
            if (output) {
                logger(`[ActivityManager] 启动结果回传: \n${output}`, { debug: true });
            }
            return output;
        }, waitingTime);
    }

    /** ### 强制停止应用 (am force-stop)
     * 立即杀死指定包名的应用进程,等同于手动在系统设置中"强行停止"。
     * 
     * 关联工具: {@link createAdbTools}
     * @param packageName 应用包名，例如 `com.tencent.mobileqq`
     * @returns {Promise<void>} 命令执行完成后返回
     * @example
     * ```typescript
     * await am.forceStop('com.tencent.mobileqq'); // 强制停止 QQ
     * ```
     */
    async forceStop(packageName: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            logger(`[ActivityManager] 队列执行: am force-stop ${packageName}`);
            await this.device.shell(`am force-stop ${packageName}`);
        }, waitingTime);
    }

    /** ### 发送系统广播 (am broadcast)
     * 向系统或指定应用发送一个 Android 广播事件。
     * 常用于触发应用内部逻辑，例如通知刷新、系统设置变更等。
     * 
     * 关联工具: {@link createAdbTools}
     * @param action 广播动作字符串，例如 `android.intent.action.BOOT_COMPLETED`
     * @returns {Promise<void>} 命令执行完成后返回
     * @example
     * ```typescript
     * await am.broadcast('android.intent.action.BOOT_COMPLETED');
     * ```
     */
    async broadcast(action: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            logger(`[ActivityManager] 队列执行: am broadcast -a ${action}`);
            await this.device.shell(`am broadcast -a ${action}`);
        }, waitingTime);
    }

    /** ### 查看后台任务栈 (am stack list)
     * 返回当前系统所有 Activity 栈的详细信息，可用于分析应用的运行状态。
     * 
     * 关联工具: {@link createAdbTools}
     * @returns {Promise<string>} 包含所有 Activity 栈信息的原始字符串输出
     * @example
     * ```typescript
     * const stacks = await am.getStackList();
     * console.log(stacks); // 打印所有后台任务栈
     * ```
     */
    async getStackList(): Promise<string> {
        return this.runShell('am stack list');
    }

    /** ### 获取当前前台运行的应用信息
     * 基于 `dumpsys window` 命令，从系统窗口焦点信息中提取当前前台应用的包名和 Activity 名。
     * 
     * 关联工具: {@link createAdbTools}
     * @returns {Promise<{ package: string; activity: string } | null>}
     *   - 成功时返回 `{ package: '包名', activity: 'Activity全名' }`
     *   - 如果无法解析（例如桌面或系统界面），则返回 `null`
     * 
     * @example
     * ```typescript
     * const app = await am.getCurrentApp();
     * if (app) {
     *     console.log(`当前包名: ${app.package}, Activity: ${app.activity}`);
     * }
     * ```
     */
    async getCurrentApp(): Promise<{ package: string; activity: string } | null> {
        const output = await this.runShell("dumpsys window | grep mCurrentFocus");
        const match = output.match(/([a-zA-Z0-9._]+)\/([a-zA-Z0-9._$]+)/);
        if (match) {
            return { package: match[1], activity: match[2] };
        }
        return null;
    }
}
