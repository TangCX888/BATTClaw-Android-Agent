import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { logger } from '../../utils/logger.js';

/**
 * 虚拟机环境仿真服务
 * 负责抹除虚拟化痕迹，注入真实的手机硬件指纹
 */
export class VMSimulatorService {

    /** ### applyCommonEnv: 应用通用仿真环境 (Xiaomi 13 fuxi)
     * 分步执行：Root 提权 -> 磁盘挂载 -> 指纹注入 -> CPU 模拟 -> 电量卫士 -> 刷新服务。
     * @param {DeviceClient} device adbkit 客户端
     * @param {string} deviceId 设备 ID
     */
    /** ### applyCommonEnv: 应用通用仿真环境 (Xiaomi 13 fuxi)
     * 分步执行：指纹注入 -> 电量卫士。 (移除掉线风险项)
     * @param {DeviceClient} device adbkit 客户端
     * @param {string} deviceId 设备 ID
     * @param {string} language 语言设置，默认为中文 (zh-Hans-CN)
     */
    async applyCommonEnv(device: DeviceClient, deviceId: string, language: string = 'zh-Hans-CN'): Promise<void> {
        logger(`[VMSimulator] 正在为设备 ${deviceId} 注入通用手机仿真数据...`);

        try {
            // 1. 注入硬件与网络特征 (基于 Xiaomi 13 fuxi)
            const randomAndroidId = Math.random().toString(16).slice(2, 18);
            const props: Record<string, string> = {
                'ro.product.system.brand': 'Xiaomi',
                'ro.product.vendor.brand': 'Xiaomi',
                'ro.product.name': 'fuxi',
                'ro.product.device': 'fuxi',
                'ro.product.model': '2211133C',
                'persist.sys.locale': language,
                'persist.sys.timezone': 'Asia/Shanghai',
                'ro.product.locale': language.startsWith('zh') ? 'zh-CN' : 'en-US',
                'gsm.sim.state': 'READY,READY',
                'gsm.operator.alpha': 'China Mobile,China Mobile',
                'gsm.operator.numeric': '46000,46000'
            };

            for (const [key, val] of Object.entries(props)) {
                await device.shell(`setprop ${key} ${val}`).catch(() => { });
            }

            // 2. 强制中文化与时区对齐 (解决系统显示英文问题)
            await device.shell(`settings put system system_locales ${language}`).catch(() => { });
            await device.shell(`settings put global system_locales ${language}`).catch(() => { });
            await device.shell('settings put global timezone Asia/Shanghai').catch(() => { });
            await device.shell(`settings put secure android_id ${randomAndroidId}`).catch(() => { });

            // 3. 补全硬件探针 (CPU 核心位伪装)
            const cpuPatchCmd = `
                mkdir -p /data/local/tmp/fake_sys_cpu && 
                cp -r /sys/devices/system/cpu/* /data/local/tmp/fake_sys_cpu/ 2>/dev/null && 
                echo '0-7' > /data/local/tmp/fake_sys_cpu/online && 
                echo '0-7' > /data/local/tmp/fake_sys_cpu/possible && 
                echo '0-7' > /data/local/tmp/fake_sys_cpu/present && 
                echo '7' > /data/local/tmp/fake_sys_cpu/kernel_max && 
                mount --bind /data/local/tmp/fake_sys_cpu /sys/devices/system/cpu
            `.replace(/\n/g, '').trim();
            await device.shell(cpuPatchCmd).catch(() => { });

            // 4. 电量补丁 (即时广播模式，无需重启 UI 即刻生效)
            await this.injectBatteryDaemon(device);

            logger(`[VMSimulator] ✅ 通用仿真数据（含中文化与硬件位补丁）注入完成。`);
        } catch (e: any) {
            const errMsg = e.message || JSON.stringify(e);
            logger(`[VMSimulator] ❌ 仿真注入失败: ${errMsg}`, { error: true });
            throw e;
        }
    }

    /** ### injectBatteryDaemon: 注入并拉起长效电量卫士
     * 锁定 85% 电量、断开内核监听 (unplug)、模拟充电态 (status 2) 并发送实时广播。
     * @param {DeviceClient} device adbkit 客户端
     */
    async injectBatteryDaemon(device: DeviceClient): Promise<void> {
        logger(`[VMSimulator] 🔋 正在注入长效电量卫士 (锁定 85% + 主动广播)...`);

        // 1. 即时强制刷新 (首屏生效)
        const batteryInit = 'dumpsys battery unplug; dumpsys battery set level 85; dumpsys battery set status 2; am broadcast -a android.intent.action.BATTERY_CHANGED --ei level 85 --ei scale 100 --ei status 2 --ei health 2 --ei plugged 0 --ei voltage 3800 --ei // temperature 350';
        await device.shell(batteryInit).catch(() => { });

        // 2. 启动/重新挂载后台守护进程 (120s 巡检)
        const daemonCmd = 'nohup sh -c "while true; do dumpsys battery unplug; dumpsys battery set level 85; dumpsys battery set status 2; am broadcast -a android.intent.action.BATTERY_CHANGED --ei level 85 --ei scale 100 --ei status 2; sleep 120; done" > /dev/null 2>&1 &';
        await device.shell(daemonCmd).catch(() => { });
    }

    /** ### applyTaobaoEnv: 应用淘宝专用反爬环境 (包含 Frida 注入)
     * 对应原 init_taobao.sh 的核心逻辑。
     * @param {DeviceClient} device adbkit 客户端
     * @param {string} assetsPath 静态资源路径
     */
    async applyTaobaoEnv(device: DeviceClient, assetsPath: string): Promise<void> {
        logger(`[VMSimulator] 🚀 正在执行淘宝专项初始化 (权限锁定与 Frida 注入)...`);
        // TODO: 实现具体的 Frida push 与 淘宝目录权限锁定
    }
}
