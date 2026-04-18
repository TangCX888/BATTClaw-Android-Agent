import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { BaseModule } from './BaseModule.class.js';
import { logger } from '../../../../utils/logger.js';
import { createAdbTools } from '../adb.tools.js';

/** 包管理模块 (pm): 安装/卸载 APK、清空缓存、禁用应用、应用列表查询等 */
export type PackageManager_class_keys = Exclude<keyof PackageManager, 'constructor' | 'runShell' | 'device' | 'isInstalled' | 'installLocal' | 'waitingTime_default' | 'internalGetScreenSize' | 'runQueued'>;
export class PackageManager extends BaseModule {
    constructor(device: DeviceClient, waitingTime: number) {
        super(device, waitingTime);
    }

    /** ### 检查应用是否已安装
     * @param packageName 应用包名
     * @returns {Promise<boolean>} 是否已安装
     */
    async isInstalled(packageName: string): Promise<boolean> {
        const list = await this.applist();
        return list.includes(packageName);
    }

    /** ### 从本地电脑安装 APK 到手机
     * 该方法会自动处理文件上传 (push) 和安装 (pm install) 过程。
     * @param localPath 电脑端 APK 的绝对路径
     * @returns {Promise<void>} 
     */
    async installLocal(localPath: string): Promise<void> {
        return this.runQueued(async () => {
            logger(`[PackageManager] 正在从本地安装: ${localPath}`);
            await this.device.install(localPath);
        });
    }

    /** ### 安装应用 (pm install)
     * 安装位于**手机端**指定路径的 APK 文件。
     * 注意：APK 需要先通过 `adb push` 上传到手机，再调用此方法安装。
     * 关联工具: {@link createAdbTools}
     * @param apkPath 手机端的 APK 绝对路径，例如 `/sdcard/app.apk`
     * @returns {Promise<void>} 安装命令执行完成后返回
     * @example
     * ```typescript
     * // 先 push 文件到手机，再安装
     * await device.push('./app.apk', '/sdcard/app.apk');
     * await pm.install('/sdcard/app.apk');
     * ```
     */
    async install(apkPath: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            logger(`[PackageManager] 队列执行: pm install -r ${apkPath}`);
            await this.device.shell(`pm install -r ${apkPath}`);
        }, waitingTime);
    }

    /** ### 卸载应用 (pm uninstall)
     * 根据包名卸载指定应用，会同时删除应用数据和缓存。
     * 关联工具: {@link createAdbTools#uninstall}
     * @param packageName 应用包名，例如 `com.tencent.mobileqq`
     * @returns {Promise<void>} 卸载命令执行完成后返回
     * @example
     * ```typescript
     * await pm.uninstall('com.tencent.mobileqq'); // 卸载 QQ
     * ```
     */
    async uninstall(packageName: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            logger(`[PackageManager] 队列执行: pm uninstall ${packageName}`);
            await this.device.shell(`pm uninstall ${packageName}`);
        }, waitingTime);
    }

    /** ### 清除应用数据和缓存 (pm clear)
     * 清空指定应用的全部数据（包括账号信息、设置、缓存），相当于恢复到初次安装状态。
     * 应用不会被卸载，清除后仍可正常打开。
     * 关联工具: {@link createAdbTools#clear}
     * @param packageName 应用包名，例如 `com.tencent.mobileqq`
     * @returns {Promise<void>} 清除命令执行完成后返回
     * @example
     * ```typescript
     * await pm.clear('com.tencent.mobileqq'); // 清空 QQ 的全部数据
     * ```
     */
    async clear(packageName: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            logger(`[PackageManager] 队列执行: pm clear ${packageName}`);
            await this.device.shell(`pm clear ${packageName}`);
        }, waitingTime);
    }

    /** ### 列出所有已安装的包名 (pm list packages)
     * 获取设备上所有已安装的应用包名列表（包含系统应用）。
     * 关联工具: {@link createAdbTools#applist}
     * @returns {Promise<string[]>} 返回所有已安装应用的包名数组
     * @example
     * ```typescript
     * const packages = await pm.applist();
     * console.log(packages); // ['com.android.settings', 'com.tencent.mobileqq', ...]
     * ```
     */
    async applist(): Promise<string[]> {
        const output = await this.runShell('pm list packages');
        return output.split('\n')
            .map((line: string) => line.replace('package:', '').trim())
            .filter((line: string) => line.length > 0);
    }

    /** ### 列出所有可启动应用的入口点 (Package/Activity)
     * 利用 monkey 指令获取设备上所有具备 Launcher 入口的应用及其主 Activity。
     * 返回格式为 `packageName/activityName`，可直接用于 `am start`。
     * 关联工具: {@link createAdbTools#launcherAppList}
     * @returns {Promise<string[]>} 返回所有可启动应用的入口列表
     * @example
     * ```typescript
     * const apps = await pm.launcherAppList();
     * console.log(apps); // ['com.android.settings/.Settings', ...]
     * ```
     */
    async launcherAppList(): Promise<string[]> {
        // 设置两个版本的指令：
        // 1. 现代版 (cmd package): 性能更好，兼容 Android 10+
        const cmdModern = `cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep "/" | grep -v "Activity #" | grep -v "filter" | sed 's/^[[:space:]]*//'`;
        
        // 2. 传统版 (pm query-intent): 兼容部分旧机型
        const cmdLegacy = `pm query-intent-activities -c android.intent.category.LAUNCHER -a android.intent.action.MAIN | grep "package=" | sed -E 's/.*package=([^ ]+) class=([^ ]+).*/\\1\\/\\2/'`;

        let output = "";
        try {
            // 优先尝试现代版
            output = await this.runShell(cmdModern);
        } catch (e) {
            // 失败则回退到传统版
            try {
                output = await this.runShell(cmdLegacy);
            } catch (err) {
                console.error("[PackageManager] 获取应用列表失败:", err);
            }
        }

        return output.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && line.includes('/'));
    }

    /** ### 彻底禁用应用 (pm disable-user)
     * 在用户级别禁用指定应用，禁用后该应用会从桌面消失并停止运行，但数据保留。
     * 可通过 `pm enable` 命令重新启用。
     * 关联工具: {@link createAdbTools#disableUser}
     * @param packageName 应用包名，例如 `com.android.camera2`
     * @returns {Promise<void>} 禁用命令执行完成后返回
     * @example
     * ```typescript
     * await pm.disableUser('com.android.camera2'); // 禁用系统相机
     * ```
     */
    async disableUser(packageName: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            logger(`[PackageManager] 队列执行: pm disable-user --user 0 ${packageName}`);
            await this.device.shell(`pm disable-user --user 0 ${packageName}`);
        }, waitingTime);
    }
}
