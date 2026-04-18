import { tool } from 'ai'
import { number, object, z } from 'zod'
import { AndroidAgent } from './tools/AndroidAgent.class.js'
import { ActivityManager } from './tools/ActivityManager.class.js'
import type { ActivityManager_class_keys } from './tools/ActivityManager.class.js'
import type { PackageManager_class_keys } from './tools/PackageManager.class.js'
import type { AndroidAgent_class_keys } from './tools/AndroidAgent.class.js'
import type { XmlManager_class_keys } from './tools/XmlManager.class.js'
import { logger } from '@/utils/logger.js'

/** 所有 ADB 工具的 key 联合类型 */
type AllAdbToolKeys =
    | ActivityManager_class_keys
    | PackageManager_class_keys
    | AndroidAgent_class_keys
    | XmlManager_class_keys
    | executorTool

/** 执行者特
 * @description
 * - `success` - 任务完成
 * - `待添加`
 */
type executorTool = "success"

/** ### 安卓 ADB Agent 工具集工厂函数
 * 接受一个已连接的 AndroidAgent 实例，返回包含全部 ADB 工具的对象。
 * 工具集使用 TS 类型约束，少写任何一个 key → 编译期报错。
 * @param agent 已初始化的 AndroidAgent 实例
 * 
 * **跳转:** {@link createAdbTools}
 * 
 * @example
 * // 输出示例:
 * // {
 * //   start: tool({ ... }),
 * //   forceStop: tool({ ... }),
 * //   click: tool({ ... }),
 * //   screencap: tool({ ... }),
 * //   ...
 * // }
 */
export function createAdbTools(agent: AndroidAgent): Record<AllAdbToolKeys, any> {
    return {

        // ============ ActivityManager (am) ============

        success: tool({
            description: '任务完成。【当你已经完成任务 或 者确定本次操作后可完成任务可以同步调用此工具】',
            parameters: z.object({
                result: z.string().describe('**强制要求** 调用时你必须要在这里说明总结情况。**回复规则** 说明当前你的任务和你完成的结果，如果任务中涉及重要信息应当全部且详细的在这里说明')
            }),
            //@ts-ignore
            execute: async (args: any) => {
                return { status: 'success', message: args.result };
            }
        }),


        /** 启动指定应用或网页 URL (am start) 
         * 
         * 实现方法: {@link ActivityManager.start}
         */
        start: tool({
            description: '启动指定应用或网页。注意：app启动路径应该从 [launcherAppList] 获取。',
            parameters: z.object({
                intent: z.string().describe(
                    '1. 启动应用：需要传入从 [launcherAppList] 获取的完整启动路径选择后完整传入，不需要传key。2. 启动网页：传入完整的 URL (例如 "https://www.google.com")'
                ),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let intent = typeof args === 'string' ? args : (args.intent || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 start(intent=${intent}) - 启动应用/页面`);
                logger(`🚀 启动了应用`, { debug: false });
                if (!intent || intent === 'undefined') {
                    return { status: 'error', message: `请务必提供 intent 参数 (包名/Activity 或 URL)，参考格式: {"intent": "..."}` };
                }
                await agent.am.start(intent);
                return { status: 'success', message: `已启动: ${intent}` };
            }
        }),

        /** 强制停止指定应用 (am force-stop) 
         * 
         * 实现方法: {@link ActivityManager.forceStop}
         */
        forceStop: tool({
            description: '强制停止指定应用 (am force-stop)',
            parameters: z.object({
                packageName: z.string().describe('应用包名，例如 com.tencent.mobileqq'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let packageName = typeof args === 'string' ? args : (args.packageName || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 forceStop(packageName=${packageName}) - 强制停止应用`);
                logger(`🛑 停止了应用`, { debug: false });
                if (!packageName || packageName === 'undefined') {
                    return { status: 'error', message: `请务必提供 packageName 参数，参考格式: {"packageName": "..."}` };
                }
                await agent.am.forceStop(packageName);
                return { status: 'success', message: `已强制停止: ${packageName}` };
            }
        }),

        /** 发送系统广播 (am broadcast) 
         * 
         * 实现方法: {@link ActivityManager.broadcast}
         */
        broadcast: tool({
            description: '发送系统广播 (am broadcast)',
            parameters: z.object({
                action: z.string().describe('广播动作，例如 android.intent.action.BOOT_COMPLETED'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let action = typeof args === 'string' ? args : (args.action || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 broadcast(action=${action}) - 发送系统广播`);
                if (!action || action === 'undefined') {
                    return { status: 'error', message: `请务必提供 action 参数，参考格式: {"action": "..."}` };
                }
                await agent.am.broadcast(action);
                return { status: 'success', message: `广播已发送: ${action}` };
            }
        }),

        /** 查看当前所有后台任务栈 (am stack list) 
         * 
         * 实现方法: {@link ActivityManager.getStackList}
         */
        getStackList: tool({
            description: '查看当前所有后台任务栈 (am stack list)',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 getStackList() - 查看后台任务栈`);
                const result = await agent.am.getStackList();
                return { status: 'success', data: result };
            }
        }),

        /** 获取当前前台运行的应用包名和 Activity 名 
         * 
         * 实现方法: {@link ActivityManager.getCurrentApp}
         */
        getCurrentApp: tool({
            description: '获取当前前台运行的应用包名和 Activity 名',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 getCurrentApp() - 获取当前前台应用`);
                const result = await agent.am.getCurrentApp();
                return { status: 'success', data: result };
            }
        }),

        // ============ PackageManager (pm) ============

        /** 安装 APK（需先将 APK push 到手机）(pm install) 
         * 
         * 实现方法: {@link PackageManager.install}
         */
        install: tool({
            description: '安装 APK（需先将 APK push 到手机）(pm install)',
            parameters: z.object({
                apkPath: z.string().describe('手机端 APK 绝对路径，例如 /sdcard/app.apk'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let apkPath = typeof args === 'string' ? args : (args.apkPath || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 install(apkPath=${apkPath}) - 安装APK`);
                if (!apkPath || apkPath === 'undefined') {
                    return { status: 'error', message: `请务必提供 apkPath 参数，参考格式: {"apkPath": "..."}` };
                }
                await agent.pm.install(apkPath);
                return { status: 'success', message: `已安装: ${apkPath}` };
            }
        }),

        /** 卸载应用 (pm uninstall) 
         * 
         * 实现方法: {@link PackageManager.uninstall}
         */
        uninstall: tool({
            description: '卸载应用 (pm uninstall)',
            parameters: z.object({
                packageName: z.string().describe('应用包名'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let packageName = typeof args === 'string' ? args : (args.packageName || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 uninstall(packageName=${packageName}) - 卸载应用`);
                if (!packageName || packageName === 'undefined') {
                    return { status: 'error', message: `请务必提供 packageName 参数，参考格式: {"packageName": "..."}` };
                }
                await agent.pm.uninstall(packageName);
                return { status: 'success', message: `已卸载: ${packageName}` };
            }
        }),

        /** 清空应用数据和缓存 (pm clear) 
         * 
         * 实现方法: {@link PackageManager.clear}
         */
        clear: tool({
            description: '清空应用数据和缓存 (pm clear)',
            parameters: z.object({
                packageName: z.string().describe('应用包名'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let packageName = typeof args === 'string' ? args : (args.packageName || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 clear(packageName=${packageName}) - 清空应用数据/缓存`);
                if (!packageName || packageName === 'undefined') {
                    return { status: 'error', message: `请务必提供 packageName 参数，参考格式: {"packageName": "..."}` };
                }
                await agent.pm.clear(packageName);
                return { status: 'success', message: `已清空数据: ${packageName}` };
            }
        }),

        /** 列出设备上所有已安装的应用包名 (pm list packages) 
         * 
         * 实现方法: {@link PackageManager.applist}
         */
        applist: tool({
            description: '列出设备上所有已安装的应用包名 (pm list packages) , 注意包名称无法使用 am start 启动！',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 applist() - 获取已安装应用列表`);
                const packages = await agent.pm.applist();
                return { status: 'success', count: packages.length, data: packages };
            }
        }),

        /** 禁用指定应用，禁用后从桌面消失并停止运行 (pm disable-user) 
         * 
         * 实现方法: {@link PackageManager.disableUser}
         */
        disableUser: tool({
            description: '禁用指定应用，禁用后从桌面消失并停止运行 (pm disable-user)',
            parameters: z.object({
                packageName: z.string().describe('应用包名'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let packageName = typeof args === 'string' ? args : (args.packageName || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 disableUser(packageName=${packageName}) - 禁用应用`);
                if (!packageName || packageName === 'undefined') {
                    return { status: 'error', message: `请务必提供 packageName 参数，参考格式: {"packageName": "..."}` };
                }
                await agent.pm.disableUser(packageName);
                return { status: 'success', message: `已禁用: ${packageName}` };
            }
        }),

        /** 列出设备上所有可启动应用的入口点 (package/activity) 
         * 
         * 实现方法: {@link PackageManager.launcherAppList}
         */
        launcherAppList: tool({
            description: '列出设备上所有可从桌面启动的应用入口 (package/activity)，可以使用 [start] 工具启动获取的应用入口',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 launcherAppList() - 获取可启动应用列表`);
                const apps = await agent.pm.launcherAppList();
                return { status: 'success', count: apps.length, data: apps };
            }
        }),

        // ============ AndroidAgent (直接操作) ============

        /** 点击屏幕指定坐标 (input tap) 
         * 
         * 实现方法: {@link AndroidAgent.click}
         */
        click: tool({
            description: '点击屏幕指定坐标。【注意】：如果无法确定具体坐标可以看下 [gridScreencap] 方法',
            parameters: z.object({
                x: z.coerce.number().describe('传入 x轴横坐标 (像素)'),
                y: z.coerce.number().describe('传入 y轴纵坐标 (像素)'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let { x, y } = args as any;
                const numX = Number(x);
                const numY = Number(y);

                if (Number.isNaN(numX) || Number.isNaN(numY)) {
                    logger(`[tools-adb] 参数解析失败: ${JSON.stringify(args)}`, { error: true });
                    return {
                        status: 'failure',
                        message: `点击坐标无效。期望: {"x":number, "y":number}。当前真值: ${JSON.stringify(args)}`
                    };
                }
                logger(`[tools-adb] AI正在调用 click(x=${numX},y=${numY})`);
                logger(`🤖 点击了屏幕`, { debug: false });
                const warning = await agent.click(numX, numY);
                return { status: 'success', message: `已点击坐标 (${numX}, ${numY})${warning ? "。提醒：" + warning : ""}` };
            }
        }),

        /** 截取当前屏幕并保存为 PNG 文件 
         * 
         * 实现方法: {@link AndroidAgent.gridScreencap}
         */
        gridScreencap: tool({
            description: '获取带分区的屏幕截图。当页面结构无 XML 具体坐标无法分析时调用此方法，会在下一轮返回一张坐标图，可以通过截图对应的坐标图中的代号调用 [clickByGrid] 方法实现无坐标点击',
            parameters: z.object({
                // waitingTime: z.number().optional().describe('截图前的等待时间 (ms)')
            }),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 gridScreencap() - 获取带分区的屏幕截图`);
                const { filePath } = await agent.gridScreencap();
                return { status: 'success', filePath };
            }
        }),

        /** 通过网格分区点击屏幕 (clickByGrid)
         * 
         * 实现方法: {@link AndroidAgent.clickByGrid}
         */
        clickByGrid: tool({
            description: '根据网格代号点击屏幕指定区域。请务必在调用此工具前先通过 [gridScreencap] 获取最新的带网格截图，并根据截图中的代号（如 "A1", "D5"）进行点击。',
            parameters: z.object({
                gridCode: z.string().describe('网格区域代号，如 "A1", "C22", "AA5"'),
            }),
            //@ts-ignore
            execute: async (args) => {
                let gridCode = typeof args === 'string' ? args : (args as any).gridCode;
                if (!gridCode && typeof args === 'object') {
                    gridCode = Object.values(args)[0];
                }
                logger(`[tools-adb] AI正在调用 clickByGrid - 转换后参数: "${gridCode}" 原始入参: ${JSON.stringify(args)}`);
                logger(`🤖 点击了屏幕区域`, { debug: false });
                if (!gridCode || typeof gridCode !== 'string') {
                    return { status: 'failure', message: `传递的 gridCode 无效，你传入的是 ${JSON.stringify(args)}，请直接传入代号字符串，例如: "A1"` };
                }
                const warning = await agent.clickByGrid(gridCode.trim().toUpperCase());
                /** 是否点击了顶部状态栏 */
                const rowNumMatch = gridCode.match(/\d+/);
                const isTop = rowNumMatch ? Number(rowNumMatch[0]) === 1 : false;
                let message = isTop ? "请勿点击顶部状态栏！请仔细核对需要点击的位置" : "已点击网格区域 " + gridCode;
                if (warning) {
                    message += "。提醒：" + warning;
                }
                return { status: 'success', message };
            }
        }),

        /** 进行网格滑动 (swipeByGrid) */
        swipeByGrid: tool({
            description: '根据网格代号在两个区域之间滑动。',
            parameters: z.object({
                startCode: z.string().describe('起点网格代号，如 "A1"'),
                endCode: z.string().describe('终点网格代号，如 "C5"'),
                duration: z.number().optional().describe('滑动时长 (ms)'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                const { startCode, endCode, duration } = args as any;
                logger(`[tools-adb] AI正在调用 swipeByGrid(from=${startCode}, to=${endCode})`);
                logger(`↔️ 滑动了屏幕`, { debug: false });
                const warning = await agent.swipeByGrid(startCode, endCode, duration);
                return { status: 'success', message: `已从 ${startCode} 滑动到 ${endCode}${warning ? "。提醒：" + warning : ""}` };
            }
        }),

        /** 通过网格清空文本 (clearAllTextByGrid) */
        clearAllTextByGrid: tool({
            description: '根据网格代号清空输入框内的所有文本。',
            parameters: z.object({
                gridCode: z.string().describe('输入框所在的网格代号，如 "B2"'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                const gridCode = typeof args === 'string' ? args : (args.gridCode || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 clearAllTextByGrid(gridCode=${gridCode})`);
                logger(`⌨️ 正在清理文本...`, { debug: false });
                await agent.clearAllTextByGrid(gridCode);
                return { status: 'success', message: `已清空网格 ${gridCode} 处的输入框` };
            }
        }),

        /** 进行连续的多屏滚动截屏
         * 
         * 实现方法: {@link AndroidAgent.scrollScreencap}
         */
        scrollScreencap: tool({
            description: '连续滚动屏幕并收集屏幕信息，需要传入屏幕滚动次数',
            parameters: z.object({
                number: z.number().describe('参数传入滚动截屏的数量（截屏数量）')
            }),
            //@ts-ignore
            execute: async (args) => {
                // 可能会传一个对象过来  {"scrollCount":5} ，需要处理
                args = typeof args === 'string' ? JSON.stringify(args || {}) : args
                args = typeof args === 'object' ? Object.values(args)[0] : args
                // 做一个参数兜底，防止大模型漏传该参数
                let num = args || 3;
                logger(`[tools-adb] AI正在调用 scrollScreencap(number=${num}) - 原始入参: ${JSON.stringify(num)}`);
                logger(`↔️ 正在进行长图滚动截屏...`, { debug: false });
                const filePaths = await agent.scrollScreencap(num);
                return { status: 'success', filePaths };
            }
        }),

        /** 模拟按下返回键 (KEYCODE_BACK) 
         * 
         * 实现方法: {@link AndroidAgent.back}
         */
        back: tool({
            description: '模拟按下返回键 (KEYCODE_BACK)',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 back() - 按返回键`);
                logger(`🔙 返回上一级`, { debug: false });
                return { status: 'success', message: '已按下返回键' };
            }
        }),

        /** 模拟按下 Home 键，返回桌面 (KEYCODE_HOME) 
         * 
         * 实现方法: {@link AndroidAgent.home}
         */
        home: tool({
            description: '模拟按下 Home 键，返回桌面 (KEYCODE_HOME)',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 home() - 按Home键回桌面`);
                logger(`🏠 回到了桌面`, { debug: false });
                await agent.home();
                return { status: 'success', message: '已按下 Home 键' };
            }
        }),

        /** 模拟按下电源键，锁定或唤醒屏幕 (KEYCODE_POWER) 
         * 
         * 实现方法: {@link AndroidAgent.switchScreen}
         */
        switchScreen: tool({
            description: '模拟按下电源键，锁定或唤醒屏幕 (KEYCODE_POWER)',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 switchScreen() - 锁定/唤醒屏幕`);
                logger(`🔌 切换了屏幕状态`, { debug: false });
                await agent.switchScreen();
                return { status: 'success', message: '已切换屏幕状态' };
            }
        }),

        /** 模拟按下音量键 (KEYCODE_VOLUME_UP / DOWN) 
         * 
         * 实现方法: {@link AndroidAgent.volume}
         */
        volume: tool({
            description: '模拟按下音量键 (KEYCODE_VOLUME_UP / DOWN)',
            parameters: z.object({
                direction: z.enum(['up', 'down']).describe("'up' 调大音量，'down' 调小音量"),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let direction = typeof args === 'string' ? args : (args.direction || Object.values(args)[0]);
                logger(`[tools-adb] AI正在调用 volume(direction=${direction}) - 调节音量`);
                if (direction !== 'up' && direction !== 'down') {
                    return { status: 'error', message: `请提供有效的 direction 参数 ('up' 或 'down')，参考格式: {"direction": "up"}` };
                }
                await agent.volume(direction);
                return { status: 'success', message: `音量已${direction === 'up' ? '调大' : '调小'}` };
            }
        }),

        /** 获取屏幕分辨率 (wm size) 
         * 
         * 实现方法: {@link AndroidAgent.getScreenSize}
         */
        getScreenSize: tool({
            description: '获取屏幕分辨率 (wm size)',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 getScreenSize() - 获取屏幕分辨率`);
                const result = await agent.getScreenSize();
                return { status: 'success', data: result };
            }
        }),

        /** 输入文本 (并自动清空原内容)
         * 
         * 实现方法: {@link AndroidAgent.inputText}
         */
        inputText: tool({
            description: '在当前聚焦的输入框中输入文本，该操作会自动清空输入框内已有的旧内容。',
            parameters: z.object({
                text: z.string().describe('要输入的文本内容'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let text = typeof args === 'string' ? args : (args.text || Object.values(args)[0]);

                if (!text || text === 'undefined') {
                    return { status: "failure", message: `输入的文本有误，你输入的是: ${text}，请通过 {"text": "..."} 格式传入字符串文本` };
                }

                logger(`[tools-adb] AI正在调用 inputText(text=${text}) - 输入文本`);
                logger(`⌨️ 正在输入文本...`, { debug: false });
                await agent.inputText(text);
                return { status: 'success', message: `已输入文本: ${text}` };
            }
        }),

        /** 删除指定数量的字符 (KEYCODE_DEL) 
         * 
         * 实现方法: {@link AndroidAgent.clearText}
         */
        clearText: tool({
            description: '从当前光标位置向前删除指定数量的字符',
            parameters: z.object({
                count: z.number().describe('需要删除的字符数量'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                let count = typeof args === 'number' ? args : (args.count || Object.values(args)[0]);
                count = Number(count);
                if (isNaN(count)) {
                    return { status: 'error', message: `请提供有效的 count 参数 (数字)，参考格式: {"count": 1}` };
                }
                logger(`[tools-adb] AI正在调用 clearText(count=${count}) - 删除指定数量字符`);
                await agent.clearText(count);
                return { status: 'success', message: `已删除 ${count} 个字符` };
            }
        }),

        /** 清空当前输入框的所有内容 (三击坐标 + DEL) 
         * 
         * 实现方法: {@link AndroidAgent.clearAllText}
         */
        clearAllText: tool({
            description: '清空输入框中的所有文本',
            parameters: z.object({
                resourceId: z.string().optional().describe('输入框的 resource-id，例如 "com.example:id/input_field"，从 analyze 结果中获取。如果没有可以不传。'),
                fallbackX: z.number().describe('必传！AI需要点击清空文本的横坐标 (像素)。基于截图分辨率。'),
                fallbackY: z.number().describe('必传！AI需要点击清空文本的纵坐标 (像素)。基于截图分辨率。'),
            }),
            //@ts-ignore
            execute: async (args: any) => {
                const { resourceId, fallbackX, fallbackY } = args as any;
                logger(`[tools-adb] AI正在调用 clearAllText - 参数详情: ${JSON.stringify(args)}`);
                logger(`⌨️ 正在清理输入框...`, { debug: false });

                const numX = Number(fallbackX);
                const numY = Number(fallbackY);

                if (isNaN(numX) || isNaN(numY)) {
                    return {
                        status: 'error',
                        message: `请务必提供有效的 fallbackX 和 fallbackY 数字坐标以便点击输入框。参考格式: {"fallbackX": 100, "fallbackY": 200}`
                    };
                }
                const warning = await agent.click(numX, numY)
                await agent.clearAllText()
                // await agent.clearAllText(resourceId, numX, numY);
                return { status: 'success', message: `已尝试清空输入框内容${warning ? "。提醒：" + warning : ""}` };
            }
        }),
        // ============ XmlManager (xml) ============

        /** 抓取并分析当前屏幕的 UI 结构，返回所有可交互元素及其坐标 
         * 
         * 实现方法: {@link XmlManager.analyze}
         */
        // analyze: tool({
        //     description: '抓取并分析当前屏幕的 UI 结构，返回所有可交互元素及其坐标',
        //     parameters: z.object({}),
        //     //@ts-ignore
        //     execute: async () => {
        //         console.log(`[tools-adb] AI正在调用 analyze() - 分析当前UI结构`);
        //         const result = await agent.xml.analyze();
        //         return result;
        //     }
        // }),

        /** 模拟滑动 (input swipe) 
         * 
         * 实现方法: {@link AndroidAgent.swipe}
         */
        swipe: tool({
            description: '触摸交互工具：滑动、长按或拖拽。通过起点与终点的关系自动判定：1. 起点=终点：长按。2. 起点!=终点：滑动。可通过 duration 控制按压/移动时长。',
            parameters: z.object({
                x1: z.coerce.number().describe('起始横坐标'),
                y1: z.coerce.number().describe('起始纵坐标'),
                x2: z.coerce.number().describe('结束横坐标'),
                y2: z.coerce.number().describe('结束纵坐标'),
                duration: z.number().optional().describe('持续时长 (ms)。长按默认 1500ms，滑动默认随机 1000-1500ms'),
                waitingTime: z.number().optional().describe('动作完成后的等待时长 (ms)')
            }),
            //@ts-ignore
            execute: async (args: any) => {
                const { x1, y1, x2, y2, duration, waitingTime } = args as any;
                const nx1 = Number(x1); const ny1 = Number(y1);
                const nx2 = Number(x2); const ny2 = Number(y2);

                if ([nx1, ny1, nx2, ny2].some(n => isNaN(n))) {
                    return {
                        status: 'failure',
                        message: `滑动坐标无效。示例格式: {"x1": 500, "y1": 1500, "x2": 500, "y2": 500}`
                    };
                }

                logger(`[tools-adb] AI正在调用 swipe(from=${nx1},${ny1}, to=${nx2},${ny2})`);
                logger(`↔️ 滑动了屏幕`, { debug: false });
                const warning = await agent.swipe(nx1, ny1, nx2, ny2, duration, waitingTime);
                return { status: 'success', message: `已从 (${nx1}, ${ny1}) 滑动到 (${nx2}, ${ny2})${warning ? "。提醒：" + warning : ""}` };
            }
        }),

        /** 获取当前屏幕的 XML 结构和屏幕截图信息
        //  *  <div id="my-note"></div> MD 文档锚点
        //  * 实现方法: {@link XmlManager.analyze} + {@link AndroidAgent.screencap}
        //  */
        // // screenData: tool({
        // //     description: '获取当前屏幕的xml和屏幕截图信息',
        // //     parameters: z.object({
        // //         grid: z.boolean().optional().describe('是否开启红线辅助网格 (100px 步长)，默认 false')
        // //     }),
        // //     //@ts-ignore
        // //     execute: async () => {
        // //         console.log(`[tools-adb] AI正在调用 screenData() - 同时获取XML结构和屏幕截图`);
        // //         const [xmlResult, filePath] = await Promise.all([
        // //             agent.xml.analyze(),
        // //             agent.screencap()
        // //         ]);
        // //         return { status: 'success', xml: xmlResult, screenshot: filePath };
        // //     }
        // // }),

        /** 获取当前系统的深度上下文信息 (App, Activity, Window Stack, Dimmed) 
         * 
         * 实现方法: {@link XmlManager.getCurrentState}
         */
        getCurrentState: tool({
            description: '获取当前系统的深度上下文信息，包含前台应用、Activity、10层窗口堆栈以及界面是否变暗（弹窗判定）',
            parameters: z.object({}),
            //@ts-ignore
            execute: async () => {
                logger(`[tools-adb] AI正在调用 getCurrentState() - 获取环境深度上下文`);
                const result = await agent.xml.getCurrentState();
                return result;
            }
        }),

    }
}