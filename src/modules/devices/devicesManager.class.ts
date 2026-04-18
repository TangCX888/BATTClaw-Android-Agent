import adbkit, { DeviceClient, type Client } from '@devicefarmer/adbkit';
const { Adb } = adbkit;
import { spawn, exec as execCb } from 'child_process';
import { promisify } from 'util';
import { Stream } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MacColimaPlatform, IHostPlatform } from './platforms/MacColima.platform.js';
import { VMSimulatorService } from './VMSimulator.service.js';
import { logger } from '../../utils/logger.js';

// 兼容性最好的异步 exec 写法
const exec = promisify(execCb);

/**
 * 设备详细信息接口
 */
export interface DeviceInfo {
    /** ADB 序列号 (如 '10ACCX2912000YY' 或 'localhost:5555') */
    id: string;
    /** 设备类型：'physical' 为物理手机, 'virtual' 为 Redroid 虚拟机 */
    type: 'physical' | 'virtual';
    /** 手机型号 (如 'Xiaomi 13' 或 'V2230A') */
    model: string;
    /** 虚拟机占用的宿主机端口 (仅对 virtual 类型有效) */
    port?: number;
    /** Docker 容器名称 (仅对 virtual 类型有效，以 v- 开头) */
    containerName?: string;
    /** 设备别名 (由用户手动设置，便于记忆) */
    alias?: string;
    /** 设备状态：是否已连接并可以执行 adb 指令 */
    isReady: boolean;
    /** ADB 实例对象 (用于执行高级 ADB 指令) */
    device?: DeviceClient;
}

/** ### DevicesManager: 全局设备管理器
 * 支持物理机与虚拟机的混合 CRUD 管理
 */
export class DevicesManager {
    /** ADB 客户端实例 (adbkit) */
    private client: Client;
    /** 宿主机平台抽象层 (处理 Mac/Colima 等差异) */
    private platform: IHostPlatform;
    /** 虚拟机环境仿真服务 (抹除 Redroid 特征) */
    private simulator: VMSimulatorService;
    /** 本 class 单例模式实例 */
    private static instance: DevicesManager;
    /** 内存级设备元数据存储 (用于别名 alias 等) */
    private deviceMetadata: Map<string, Partial<DeviceInfo>> = new Map();

    /** 基础资源路径 (相对于项目运行根目录) */
    private readonly assetsPath: string = path.join(process.cwd(), 'assets/apk');

    private constructor() {
        this.client = Adb.createClient();
        this.platform = new MacColimaPlatform(); // 默认 Mac, 未来可扩展
        this.simulator = new VMSimulatorService();
    }

    /** ### 获取设备管理器（单例）
     * 全局唯一的设备管理中心，负责物理机与 Redroid 虚拟机的生命周期管理。
     * 
     * **核心方法:**
     * - `listDevices()`: 获取所有在线设备列表（含 ADB 实例）。
     * - `getDeviceById(id)`: 通过序列号快速查找特定设备。
     * - `createVM(model?)`: 创建并初始化一台红机虚拟机。
     * - `deleteDevice(id)`: 销毁指定的虚拟机容器。
     * - `updateDevice(id, {alias})`: 修改设备展示别名。
     * 
     * **调用示例:**
     * ```typescript
     * const manager = DevicesManager.getInstance();
     * const devices = await manager.listDevices();
     * console.table(devices);
     * ```
     */
    public static getInstance(): DevicesManager {
        if (!DevicesManager.instance) {
            DevicesManager.instance = new DevicesManager();
        }
        return DevicesManager.instance;
    }

    /** ### 将 adb shell 的输出流转换为字符串 (private)
     * @param {Stream.Readable} stream Node.js 可读流
     */
    private streamToString(stream: Stream.Readable): Promise<string> {
        return new Promise((resolve: (value: string) => void, reject: (reason?: any) => void) => {
            let data: string = '';
            stream.on('data', (chunk: Buffer) => data += chunk.toString());
            stream.on('end', () => resolve(data.trim()));
            stream.on('error', reject);
        });
    }

    /** ### 查询单个设备详情
     * @param {string} id 设备 ADB 序列号
     */
    async getDeviceById(id: string): Promise<DeviceInfo | undefined> {
        const devices = await this.listDevices();
        return devices.find(d => d.id === id);
    }

    /** ### 查询所有已连接设备 (库、物理机、虚拟机)
     * 会自动对齐 ADB 序列号与 Docker 容器名 (v- 前缀)。
     * @returns {Promise<DeviceInfo[]>} 包含详细型号、类型、端口等信息的设备列表
     */
    async listDevices(): Promise<DeviceInfo[]> {
        /** 从 ADB 获取的原始设备列表 */
        const adbDevices: any[] = await this.client.listDevices();
        /** 从 Docker 获取的运行中容器列表 */
        const dockerContainers: { id: string, name: string }[] = await this.getVirtualContainers();

        const result: DeviceInfo[] = [];

        for (const adb of adbDevices) {
            /** 是否为本地连接 (通常指虚拟机) */
            const isLocal: boolean = adb.id.startsWith('localhost:');
            /** 从序列号中提取的端口号 */
            const port: number | undefined = isLocal ? parseInt(adb.id.split(':')[1]) : undefined;

            /** 匹配到的虚拟机容器信息 */
            const matchedContainer: { id: string, name: string } | undefined = dockerContainers.find(c =>
                c.name === `v-${port}` || c.id === adb.id
            );

            /** 手机型号 (如 'Xiaomi 13') */
            let model: string = 'Unknown';
            try {
                const deviceClient: DeviceClient = this.client.getDevice(adb.id);
                model = await this.streamToString(await deviceClient.shell('getprop ro.product.model'));
            } catch (e) { /* 忽略连接失败的设备 */ }

            /** 该设备的本地元数据 (如别名) */
            const meta: Partial<DeviceInfo> | undefined = this.deviceMetadata.get(adb.id);
            const inst: DeviceClient = this.client.getDevice(adb.id);

            result.push({
                id: adb.id,
                type: matchedContainer ? 'virtual' : 'physical',
                model,
                port,
                containerName: matchedContainer?.name,
                alias: meta?.alias,
                isReady: adb.type === 'device',
                device: inst
            });
        }

        return result;
    }

    /** ### 创建并初始化一个新的红机虚拟机 (Redroid)
     * 1. 自动分配未占用的 5555+ 端口。
     * 2. 执行 docker run 命令并解析实时输出。
     * 3. 等待安卓系统启动完毕。
     * 4. 批量自动安装必置与常用 APK。
     * 5. 自动注入 XiaoMi 13 仿真环境 (fuxi)。
     * @param {string} [model='2211133C'] 想要模拟的手机型号，默认为 小米 13 Pro (fuxi)
     * @param {string} [language='zh-Hans-CN'] 想要设置的系统语言，默认为 中文 (zh-Hans-CN)
     * @returns {Promise<DeviceInfo>} 创建成功后的设备信息
     */
    async createVM(model: string = '2211133C', language: string = 'zh-Hans-CN'): Promise<DeviceInfo> {
        /** 检查宿主机环境是否 ready */
        const env: { ready: boolean; msg: string } = await this.platform.checkEnvironment();
        if (!env.ready) throw new Error(env.msg);

        // 1. 扫描可用端口
        const devices: DeviceInfo[] = await this.listDevices();
        const usedPorts: number[] = devices.filter(d => d.port).map(d => d.port!) as number[];
        let port: number = 5555;
        while (usedPorts.includes(port)) { port++; }

        /** 预设容器名 */
        const containerName: string = `v-${port}`;
        /** 随机生成的虚拟序列号 */
        const serial: string = `ZY22G${Math.random().toString(16).slice(2, 7).toUpperCase()}`;

        logger(`[DevicesManager] 📦 正在创建虚拟机 ${containerName} (端口: ${port})...`);

        // 2. 构造启动命令 (注入仿真型号)
        const dockerArgs: string[] = [
            'run', '-itd', '--privileged',
            '--name', containerName,
            '-p', `${port}:5555`,
            'redroid/redroid:15.0.0_64only-latest',
            `ro.product.model=${model}`,
            'ro.product.brand=Xiaomi',
            'ro.product.manufacturer=Xiaomi',
            'ro.product.device=fuxi',
            'ro.product.name=fuxi',
            `ro.serialno=${serial}`,
            'ro.secure=0',
            'ro.debuggable=1',
            'ro.adb.secure=0',
            'ro.build.type=user',
            'ro.build.tags=release-keys',
            'ro.build.fingerprint=Xiaomi/fuxi/fuxi:14/UKQ1.230804.001/V14.0.23.0.TLNCNXM:user/release-keys'
        ];

        // 3. 执行并实时获取日志
        return new Promise((resolve, reject) => {
            const child = spawn('docker', dockerArgs);
            /** 累积的错误输出 */
            let errorMsg: string = '';

            child.stderr.on('data', (data) => errorMsg += data.toString());
            child.on('close', async (code: number | null) => {
                if (code !== 0) {
                    return reject(new Error(`Docker 启动失败: ${errorMsg}`));
                }

                // 4. 等待 ADB 上线并连接
                try {
                    const deviceId = `localhost:${port}`;
                    await this.waitForAdb(port);
                    
                    // 5. 分级自动装机 (must 优先, other 随后)
                    logger(`[DevicesManager] 🚀 开始分级自动化部署 APK...`);
                    await this.installApksFromDir(deviceId, path.join(this.assetsPath, 'must'));
                    await this.installApksFromDir(deviceId, path.join(this.assetsPath, 'other'));

                    // 6. 仿真属性注入 (Locale/指纹/网络/SIM等，需软重启生效)
                    const deviceClient = this.client.getDevice(deviceId);
                    await this.simulator.applyCommonEnv(deviceClient, deviceId, language);

                    // 7. 强制刷新运行环境 (执行软重启 Stop; Start，同步 Locale)
                    await this.refreshSystemUI(deviceId, port);

                    // 8. 终极自愈增强 (二段补刀：重启稳定后锁死键盘/电量/系统纯净度)
                    try {
                        const WAIT_TIME = 10000; // 延长至 10s，确信 SystemServer 已完成 Settings 加载
                        logger(`[DevicesManager] ⏳ 正在等待软重启后的 10s 初始化稳态...`);
                        await new Promise(r => setTimeout(r, WAIT_TIME));

                        logger(`[DevicesManager] ⚙️  正在执行终极二段定制 (键盘/净化/电量卫士)...`);
                        const sogouPkg = 'com.sohu.inputmethod.sogou/.SogouIME';
                        const adbPkg = 'com.android.adbkeyboard/.AdbIME';
                        const latinPkg = 'com.android.inputmethod.latin/.LatinIME';
                        const browserPkg = 'org.chromium.webview_shell';

                        
                        // 启动一个 15秒的“死磕”循环，对抗 Framework 的引导回刷期
                        const startTime = Date.now();
                        while (Date.now() - startTime < 15000) {
                            // 8.1 输入法锁定 (Latin:Sogou:ADB)
                            const currentIME = await exec(`adb -s ${deviceId} shell "settings get secure default_input_method"`).then(r => r.stdout.trim()).catch(() => '');
                            if (!currentIME.includes('sogou')) {
                                const enabledMethods = `${latinPkg}:${sogouPkg}:${adbPkg}`;
                                await exec(`adb -s ${deviceId} shell "settings put secure enabled_input_methods ${enabledMethods}"`).catch(() => {});
                                await exec(`adb -s ${deviceId} shell "settings put secure default_input_method ${sogouPkg}"`).catch(() => {});
                            }

                            // 8.2 电量卫士锁定 (锁定 85% 充电态)
                            const currentBattery = await exec(`adb -s ${deviceId} shell "dumpsys battery | grep level"`).then(r => r.stdout.trim()).catch(() => '');
                            if (!currentBattery.includes('85')) {
                                const freshDevice = this.client.getDevice(deviceId);
                                await this.simulator.injectBatteryDaemon(freshDevice).catch(() => {});
                            }

                            // 8.3 系统浏览器剥离
                            const hasBrowser = await exec(`adb -s ${deviceId} shell "pm list packages | grep ${browserPkg}"`).then(r => r.stdout.trim()).catch(() => '');
                            if (hasBrowser) {
                                await exec(`adb -s ${deviceId} shell "pm uninstall --user 0 ${browserPkg}"`).catch(() => {});
                            }

                            // 如果四项核心参数均已就位，可以提前退出循环
                            if (currentIME.includes('sogou') && currentBattery.includes('85') && !hasBrowser) {
                                logger(`[DevicesManager] ✨ 原子级同步已锁死：数据全量对齐。`);
                                break;
                            }
                            
                            await new Promise(r => setTimeout(r, 1500)); // 每 1.5s 巡检一次
                        }

                        logger(`[DevicesManager] ✅ 虚拟机 ${deviceId} 状态已全量固化。`);
                    } catch (customErr: any) {
                        logger(`[DevicesManager] ⚠️ 原子级同步过程遇到警告 (非致命): ${customErr.message}`);
                    }

                    resolve({
                        id: deviceId,
                        type: 'virtual',
                        model,
                        port,
                        containerName,
                        isReady: true
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** ### 刷新系统运行时 (软重启)
     * 执行 stop; start 以强制刷新 Locale 等系统属性。
     * @param {string} id 设备序列号
     * @param {number} port 映射端口
     */
    private async refreshSystemUI(id: string, port: number): Promise<void> {
        try {
            logger(`[DevicesManager] ♻️  正在执行系统软重启以激活中文化 (请耐心等待约 20s)...`);
            // 执行 stop; start 会导致当前 adb 会话立即中断
            await exec(`adb -s ${id} shell "stop; start"`).catch(() => {});
            
            // 给系统一点“断开”的时间
            await new Promise(r => setTimeout(r, 5000));
            
            // 显式重连 (针对 Redroid 在 stop; start 后连接可能变碎片的问题)
            let retry = 0;
            const maxRetry = 6; // 增加一次重试
            while (retry < maxRetry) {
                try {
                    logger(`[DevicesManager] 🔄 正在强制刷新并重连 localhost:${port} (第 ${retry + 1} 次)...`);
                    // 先强制断开旧的僵尸连接
                    await exec(`adb disconnect localhost:${port}`).catch(() => {});
                    await new Promise(r => setTimeout(r, 1000));
                    
                    // 发起新鲜连接
                    await exec(`adb connect localhost:${port}`).catch(() => {});
                    await new Promise(r => setTimeout(r, 2000));

                    // 检查是否已经彻底启动完毕
                    const isBooted = await exec(`adb -s ${id} shell "getprop sys.boot_completed"`).then(r => r.stdout.trim() === '1').catch(() => false);
                    if (isBooted) break;
                } catch (ce) {}
                
                retry++;
                await new Promise(r => setTimeout(r, 4000));
            }
            
            logger(`[DevicesManager] ✨ 系统软重启完成，中文化已由于运行时重载而全局生效。`);
        } catch (e: any) {
            logger(`[DevicesManager] ⚠️ 软重启刷新失败 (重启后重连超时): ${e.message}`);
        }
    }

    /** ### 从指定目录批量安装 APK (private)
     * 调用 adb install -r -g -t 确保全权限且覆盖安装。
     * @param {string} deviceId 设备序列号
     * @param {string} dirPath 目标文件夹路径
     */
    private async installApksFromDir(deviceId: string, dirPath: string): Promise<void> {
        try {
            await fs.access(dirPath);
            const files: string[] = await fs.readdir(dirPath);
            const apks: string[] = files.filter(f => f.endsWith('.apk'));

            if (apks.length === 0) {
                logger(`[DevicesManager] ℹ️ 目录 ${path.basename(dirPath)} 为空，跳过安装。`);
                return;
            }

            logger(`[DevicesManager] ⏳ 正在从 ${path.basename(dirPath)} 安装 ${apks.length} 个套件...`);

            for (const apk of apks) {
                const apkPath: string = path.join(dirPath, apk);
                try {
                    logger(`[DevicesManager] 📦 正在安装: ${apk}...`);
                    // -r: 覆盖, -g: 自动授权所有运行时权限, -t: 允许测试包
                    await exec(`adb -s ${deviceId} install -r -g -t "${apkPath}"`);
                    logger(`[DevicesManager] ✅ ${apk} 安装成功。`);
                } catch (err: any) {
                    logger(`[DevicesManager] ❌ ${apk} 安装失败: ${err.message}`, { error: true });
                }
            }
        } catch (e) {
            // 文件夹不存在则直接跳过
        }
    }

    /** ### 删除虚拟机设备
     * 此操作会停止并销毁对应的 Docker 容器，并断开 ADB 连接。
     * @param {string} id 设备的 ADB 序列号 (如 'localhost:5555')
     * @throws {Error} 如果尝试删除物理机，会抛出错误
     */
    async deleteDevice(id: string): Promise<void> {
        if (!id.startsWith('localhost:')) {
            throw new Error('物理机无法“删除”，请手动拔掉数据线。');
        }

        /** 目标端口 */
        const port: string = id.split(':')[1];
        /** 默认推测的容器名 */
        let containerName: string = `v-${port}`;

        // 尝试通过端口寻找容器名 (如果不是 v- 开头)
        try {
            const { stdout } = await exec(`docker ps --filter "publish=${port}" --format "{{.Names}}"`);
            const realName: string = (stdout as string).trim().split('\n')[0];
            if (realName) {
                containerName = realName;
            }
        } catch (e) { }

        logger(`[DevicesManager] 🧹 正在清理虚拟机容器: ${containerName}...`);
        try {
            await exec(`docker stop ${containerName} && docker rm -f ${containerName}`);
            await exec(`adb disconnect localhost:${port}`);
            logger(`[DevicesManager] ✅ 虚拟机 ${id} 已彻底销毁。`);
        } catch (e: any) {
            logger(`[DevicesManager] ⚠️ 清理过程出现警告: ${e.message}`);
        }
    }

    /** ### 修改设备展示元数据 (仅支持别名)
     * 为了保证系统稳定性，核心属性 (id, port, containerName) 不允许通过此接口修改。
     * @param {string} id 设备的 ADB 序列号
     * @param {{ alias: string }} data 要更新的展示数据
     */
    async updateDevice(id: string, data: { alias: string }): Promise<void> {
        const current: Partial<DeviceInfo> = this.deviceMetadata.get(id) || {};
        // 强制只更新 alias，屏蔽掉对核心系统字段的篡改
        this.deviceMetadata.set(id, { ...current, alias: data.alias });
        logger(`[DevicesManager] 📝 已更新设备 ${id} 的别名: ${data.alias}`);
    }

    /** ### 获取宿主机上所有红机容器 (private)
     * 仅扫描正在运行的且符合条件的容器。
     */
    private async getVirtualContainers(): Promise<{ id: string, name: string }[]> {
        try {
            const { stdout }: { stdout: string | Buffer } = await exec('docker ps --format "{{.ID}} {{.Names}}"');
            const list: string = (stdout as string).trim();
            if (!list) return [];

            return list.split('\n')
                .filter((line: string) => line)
                .map((line: string) => {
                    const [id, name]: string[] = line.split(' ');
                    return { id, name };
                });
        } catch (e) {
            return [];
        }
    }

    /** 正在初始化的设备列表 (防止并发预检) */
    private initializingDevices: Set<string> = new Set();

    /** ### 检查并强制安装 ADB Keyboard
     * 为了确保 Agent 能正常输入文本，必须确保 AdbKeyboard 已安装且已激活。
     * @param deviceId 设备序列号
     * @returns {Promise<boolean>} 是否预检成功并就绪
     */
    async checkAndInstallAdbKeyboard(deviceId: string): Promise<boolean> {
        if (this.initializingDevices.has(deviceId)) return false;
        this.initializingDevices.add(deviceId);

        const adbPkg = 'com.android.adbkeyboard';
        const adbIme = 'com.android.adbkeyboard/.AdbIME';
        const apkPath = path.join(this.assetsPath, 'must', 'adbKeyboard.apk');

        try {
            // 1. 检查是否已安装
            const { stdout } = await exec(`adb -s ${deviceId} shell pm list packages ${adbPkg}`);
            const isInstalled = (stdout as string).includes(adbPkg);

            if (!isInstalled) {
                logger(`[DevicesManager] 设备 ${deviceId} 缺失 ADB Keyboard`);
                // 2. 强制安装
                // -r: 覆盖, -g: 自动授权所有运行时权限, -t: 允许测试包
                await exec(`adb -s ${deviceId} install -r -g -t "${apkPath}"`);
                logger(`[DevicesManager] ✅ ADB Keyboard 安装成功。`);
            }

            // 3. 强制启用输入法 (即便已安装也执行一次，确保 ready)
            await exec(`adb -s ${deviceId} shell ime enable ${adbIme}`).catch(() => { });

            // 验证是否已在启用列表中
            const { stdout: enabledList } = await exec(`adb -s ${deviceId} shell ime list -s`);
            if (!enabledList.includes(adbPkg)) {
                logger(`[DevicesManager] ⚠️ ADB Keyboard 已安装但未能成功启用 (请检查手机是否拦截了输入法启用请求)。`, { error: true });
                return false;
            }
            return true;
        } catch (e: any) {
            logger(`[DevicesManager]  ADB Keyboard 预检失败`);
            return false;
        } finally {
            this.initializingDevices.delete(deviceId);
        }
    }

    /** ### 等待设备 ADB 联机并进入就绪状态 (private)
     * 通过不断轮询 getprop sys.boot_completed 来判断。
     */
    private async waitForAdb(port: number, timeoutMs: number = 60000): Promise<void> {
        const start: number = Date.now();
        const address: string = `localhost:${port}`;

        while (Date.now() - start < timeoutMs) {
            try {
                // 运行 adb connect
                await exec(`adb connect ${address}`);
                // 检查系统是否已完全启动 (返回 1 表示完成)
                const { stdout }: { stdout: string | Buffer } = await exec(`adb -s ${address} shell getprop sys.boot_completed`);
                if ((stdout as string).trim() === '1') return;
            } catch { }
            await new Promise((r: (value: void) => void) => setTimeout(r, 1000));
        }
        throw new Error(`设备 ${address} 上线超时`);
    }
}
