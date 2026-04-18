import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { logger } from '@/utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type BaseModule_class_keys = BaseModule

export abstract class BaseModule {
    /** 静态全局指令执行队列，确保多个并行工具指令在物理设备层面串行化执行 */
    private static commandQueue: Promise<any> = Promise.resolve();

    /** 设备实例 */
    protected device: DeviceClient;
    /** 默认指令执行后的等待时间 (ms) */
    protected waitingTime_default: number;

    constructor(device: DeviceClient, waitingTime: number) {
        this.device = device;
        this.waitingTime_default = waitingTime;

        // 确保临时目录存在
        const tempDir = path.join(BaseModule.getRootPath(), 'agentData', 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    }

    /**
     * ### 串行化任务执行器
     * 将任务加入全局队列，并在执行后附加指定的等待时间。
     * 
     * @param task 具体要执行的异步 ADB 指令任务
     * @param waitingTime 可选的自定义等待时间，若不传则使用构造函数中的 waitingTime_default
     * @returns {Promise<T>} 返回任务的原始执行结果
     */
    protected async runQueued<T>(task: () => Promise<T>, waitingTime?: number): Promise<T> {
        const delay = waitingTime !== undefined ? waitingTime : this.waitingTime_default;
        // 将新任务追加到 Promise 链条末端
        const resultPromise = BaseModule.commandQueue.then(async () => {
            try {
                const result = await task();
                // 任务执行成功后，按需进行冷却等待
                if (delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                return result;
            } catch (err) {
                // 如果任务执行抛错，也要确保不阻塞后续队列，并透传错误
                throw err;
            }
        });

        // 更新全局队列引用（忽略失败分支，确保后续任务仍能继续）
        BaseModule.commandQueue = resultPromise.catch(() => { });

        return resultPromise;
    }

    /**
     * ### 获取项目根路径
     * @returns {string} 根路径
     */
    static getRootPath(): string {
        // 计算逻辑：BaseModule 在 src/modules/agent/adb/tools/BaseModule.class.ts
        // 向上五级到达根目录：tools -> adb -> agent -> modules -> src -> root
        const settingPath = path.join(__dirname, '../../../../../data', 'setting.json');
        try {
            if (fs.existsSync(settingPath)) {
                const content = fs.readFileSync(settingPath, 'utf-8');
                const setting = JSON.parse(content);
                if (setting.root && setting.root.trim().length > 0) {
                    return setting.root;
                }
            }
        } catch {
            // 解析失败，走默认逻辑
        }

        const defaultRoot = process.cwd();
        try {
            const settingDir = path.dirname(settingPath);
            if (!fs.existsSync(settingDir)) {
                fs.mkdirSync(settingDir, { recursive: true });
            }
            if (!fs.existsSync(settingPath)) {
                fs.writeFileSync(settingPath, JSON.stringify({ root: defaultRoot }, null, 4), 'utf-8');
            }
        } catch (e) {
            console.warn(`[BaseModule] 自动初始化配置文件失败(权限受限): ${settingPath}`);
        }
        return defaultRoot;
    }

    /**
     * ### 执行 Shell 命令并获取全部输出内容
     * @param cmd 要执行的 ADB Shell 命令
     * @returns {Promise<string>} 命令的标准输出内容
     */
    public async runShell(cmd: string): Promise<string> {
        return new Promise(async (resolve, reject) => {
            try {
                const stream = await this.device.shell(cmd);
                let output = '';
                stream.on('data', (data: Buffer) => output += data.toString());
                stream.on('end', () => resolve(output.trim()));
                stream.on('error', (err: Error) => reject(new Error(`Shell 命令执行失败: ${err.message}`)));
            } catch (err: any) {
                reject(new Error(`Shell 启动异常: ${err.message || err}`));
            }
        });
    }

    /** ### 获取屏幕分辨率 */
    public async internalGetScreenSize(): Promise<{ width: number; height: number } | null> {
        const cmd = 'wm size';
        try {
            const output = await this.runShell(cmd);
            const matches = output.match(/(\d+)\s*x\s*(\d+)/g);
            if (matches && matches.length > 0) {
                const lastMatch = matches[matches.length - 1];
                const [width, height] = lastMatch.split(/x|\s+x\s+/).map(s => parseInt(s.trim()));
                if (!isNaN(width) && !isNaN(height)) {
                    return { width, height };
                }
            }
            return null;
        } catch (err: any) {
            return null;
        }
    }

    /** ### 获取屏幕分辨率 (已排队) */
    public async getScreenSize(waitingTime?: number): Promise<{ width: number; height: number } | null> {
        return this.runQueued(async () => {
            return this.internalGetScreenSize();
        }, waitingTime);
    }

    /**
     * ### 将 AI 的 1000x1000 坐标还原为物理坐标
     * @param x AI 坐标 (0-1000)
     * @param y AI 坐标 (0-1000)
     * @param imageSize 预期画布大小，默认 1000
     * @returns { { x: number, y: number } } 还原后的物理像素坐标
     */
    protected async getOriginalCoordinate(x: number, y: number, imageSize: number = 1000): Promise<{ x: number, y: number, warning?: string }> {
        const size = await this.internalGetScreenSize();
        if (!size) {
            throw new Error("[BaseModule] 无法获取屏幕尺寸，比例换算失败");
        }

        const maxDim = Math.max(size.width, size.height);
        const scale = imageSize / maxDim;

        let warning: string | undefined;

        if (x <= 1 && y <= 1 && (x > 0 || y > 0)) {
            const oldX = x;
            const oldY = y;
            x = x * imageSize;
            y = y * imageSize;
            warning = `检测到你传入了 0-1 的比例坐标 [${oldX}, ${oldY}]，系统已自动按 ${imageSize}px 画布换算为 [x: ${x.toFixed(0)}, y: ${y.toFixed(0)}]。请注意，后续操作请直接参考 1000x1000 网格图传入绝对像素值。`;
        }

        x = Math.max(0, Math.min(x, imageSize));
        y = Math.max(0, Math.min(y, imageSize));

        let finalX = Math.floor(x / scale);
        let finalY = Math.floor(y / scale);

        finalX = Math.max(0, Math.min(finalX, size.width - 1));
        finalY = Math.max(0, Math.min(finalY, size.height - 1));

        return { x: finalX, y: finalY, warning };
    }
}
