import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

/**
 * 宿主机平台抽象接口
 * 用于处理不同操作系统下（Mac/Windows）Docker 宿主机的特殊逻辑
 */
export interface IHostPlatform {
    /** 检查运行环境（如 Colima/Docker 是否就绪） */
    checkEnvironment(): Promise<{ ready: boolean; msg: string }>;
    /** 获取平台特定的 Docker 额外的启动参数 */
    getExtraDockerArgs(): string[];
    /** 预处理宿主机（如挂载内核驱动） */
    prepareHost(): Promise<void>;
}

/**
 * Mac Colima 平台实现
 */
export class MacColimaPlatform implements IHostPlatform {
    /** ### checkEnvironment: 检查运行环境 (Colima/Docker)
     * 首先检查 Docker 是否响应，若无响应则检查 Colima 状态。
     */
    async checkEnvironment(): Promise<{ ready: boolean; msg: string }> {
        try {
            // 首先尝试检查 Docker 是否响应，这是最直接的判据
            const { stdout: dockerInfo } = await exec('docker info');
            if ((dockerInfo as any).includes('Server Version')) {
                return { ready: true, msg: 'Docker is ready' };
            }

            // 如果 Docker 没响应，再尝试看看 Colima 状态
            const { stdout, stderr } = await exec('colima status');
            const totalOut = (stdout as any) + (stderr as any);
            if (totalOut.includes('running')) {
                return { ready: true, msg: 'Colima is running' };
            }
            return { ready: false, msg: 'Colima is not running' };
        } catch (e: any) {
            return { ready: false, msg: `Docker/Colima 环境异常: ${e.message}` };
        }
    }

    /** ### getExtraDockerArgs: 获取平台特定的 Docker 启动参数
     * 目前 Mac Colima 平台返回 --privileged 以支持 Redroid 运行。
     */
    getExtraDockerArgs(): string[] {
        // Colima 上运行 Redroid 通常需要特权模式
        return ['--privileged'];
    }

    /** ### prepareHost: 预处理宿主机 (内核驱动挂载)
     * 这里可以放置 binderfs 等驱动的特殊初始化逻辑。
     */
    async prepareHost(): Promise<void> {
        // 这里可以放入原本 start.sh 中对 Colima 进行内核挂载的代码
        console.log('[MacColima] 正在检测/配置宿主机内核驱动...');
        // TODO: 可选地通过 colima ssh 执行 binderfs 挂载逻辑
    }
}
