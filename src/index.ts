import inquirer from 'inquirer';
import chalk from 'chalk';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import config from './modules/CLI/config.js';
import { planner_start } from './modules/agent/role/planner.js';
import { DevicesManager } from './modules/devices/devicesManager.class.js';
import { index_devices } from './modules/CLI/index_devices.js';
import { printTitle } from './modules/CLI/ui.js';

import Settings from './modules/setting/settings.js';

// --- 全局属性 ---
/** 是否已连接设备并可以开始任务 */
let isReady = false;
/** 当前选中的设备 ID */
let connectedDeviceId: string | null = null;

/** 正在执行自动刷新（由哨兵触发） */
let isAutoRefreshing = false;

async function main() {
    // --- 初始化设置与语言 ---
    const settings = await Settings.create();
    const lang = settings.setting.language || 'zh-CN';

    // 翻译字典
    const t: any = {
        'zh-CN': {
            startup: '--- 启动中 ---',
            waitingDevice: '--- 正在等待安卓设备连接 ---',
            detectingDevice: (id: string) => `  [i] 检测到设备 [${id}]，正在预检初始化环境...`,
            checkPhone: '  [i] 请检查手机是否弹出"确认安装"或"授权请求"窗口并点击允许。',
            retryIn3s: '  [i] 3秒后自动重试...',
            noDevice: '  [!] 未检测到设备，正在尝试重新连接,请通过 USB 连接您的安卓手机并开启开发者模式...',
            disconnected: '--- 设备连接已断开 ---',
            deviceInvalid: (id: string) => `\n  ⚠️  之前连接的设备 [${id}] 已失效。正在重置状态...`,
            hi: '--- hi! ---',
            chooseAction: '请选择你要执行的操作：',
            start: '   1. 启动',
            settings: '   2. 设置',
            device: (id: string) => '   3. 设备 ' + chalk.green(` => [${id}]`),
            language: '   4. 语言/language',
            help: '   5. 帮助',
            langNotOpen: '\n语言设置暂未开放',
            helpInfo: '\n帮助信息：请访问项目文档或咨询开发人员。',
            errorChoice: '\n选择错误',
            selectLang: '请选择语言 / Please select language'
        },
        'en-US': {
            startup: '--- Starting ---',
            waitingDevice: '--- Waiting for Android device ---',
            detectingDevice: (id: string) => `  [i] Detected [${id}], checking environment...`,
            checkPhone: '  [i] Please check your phone for "Allow installation" prompt and click OK.',
            retryIn3s: '  [i] Retrying in 3 seconds...',
            noDevice: '  [!] No device detected. Please connect via USB and enable Developer Mode...',
            disconnected: '--- Device Disconnected ---',
            deviceInvalid: (id: string) => `\n  ⚠️  Previous device [${id}] is offline. Resetting...`,
            hi: '--- hi! ---',
            chooseAction: 'Please select an action:',
            start: '   1. Start',
            settings: '   2. Settings',
            device: (id: string) => '   3. Devices ' + chalk.green(` => [${id}]`),
            language: '   4. Language/语言',
            help: '   5. Help',
            langNotOpen: '\nLanguage settings not yet available',
            helpInfo: '\nHelp: Please check documentation or contact support.',
            errorChoice: '\nInvalid choice',
            selectLang: 'Please select language / 请选择语言'
        }
    };

    let i18n = t[lang] || t['zh-CN'];

    printTitle(i18n.startup); // 启动中


    const manager = DevicesManager.getInstance();

    // --- 后台哨兵：仅负责监听设备断开事件 ---
    setInterval(async () => {
        try {
            const devices = await manager.listDevices();
            const found = devices.find(d => d.id === connectedDeviceId);

            if (isReady && !found) {
                // 情况 A: 设备断开了
                isReady = false;
                connectedDeviceId = null;
                isAutoRefreshing = true;
                process.stdin.emit('data', Buffer.from('\n')); // 唤醒 inquirer
            }
        } catch (e) {
            // 忽略哨兵异常
        }
    }, 500);

    while (true) {

        // --- 阶段 1: 确保设备已连接 ---
        if (!isReady || !connectedDeviceId) {
            printTitle(i18n.waitingDevice, 'warn'); // 正在等待安卓设备连接

            // 主动查询当前在线设备
            const devices = await manager.listDevices();

            if (devices.length > 0) {
                const deviceId = devices[0].id;
                console.log(chalk.blue(i18n.detectingDevice(deviceId))); // 检测到设备，正在预检初始化环境

                // 环境预检：确保必备插件 (如 ADB Keyboard) 已就绪方可连接成功
                const isEnvReady = await manager.checkAndInstallAdbKeyboard(deviceId);

                if (isEnvReady) {
                    connectedDeviceId = deviceId;
                    isReady = true;
                    continue; // 立即重跳循环进入存活检查与主菜单
                } else {
                    console.log(chalk.yellow(i18n.checkPhone)); // 请检查手机确认安装弹窗
                    console.log(chalk.yellow(i18n.retryIn3s)); // 3秒后自动重试
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }
            }

            console.log(chalk.yellow(i18n.noDevice)); // 未检测到设备

            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        // --- 阶段 2: 存活检查 (防止刚进入或循环中设备被拔出) ---
        const currentDevices = await manager.listDevices();
        const isStillAlive = currentDevices.find(d => d.id === connectedDeviceId);

        if (!isStillAlive) {
            printTitle(i18n.disconnected, 'error',); // 设备连接已断开
            console.log(chalk.red(i18n.deviceInvalid(connectedDeviceId!))); // 之前连接的设备已失效
            isReady = false;
            connectedDeviceId = null;
            await new Promise(r => setTimeout(r, 2000));
            continue; // 回到阶段 1
        }

        // --- 阶段 3: 显示主菜单 ---
        printTitle(i18n.hi, 'normal'); // 主菜单欢迎语

        // 菜单内容
        const answers = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: chalk.bold.green(i18n.chooseAction), // 请选择你要执行的操作
                choices: [
                    { name: i18n.start, value: 'start' },              // 启动
                    { name: i18n.settings, value: 'settings' },        // 设置
                    { name: i18n.device(connectedDeviceId!), value: 'devices' },  // 设备
                    { name: i18n.language, value: 'language' },        // 语言/language
                    // { name: i18n.help, value: 'help' },             // 帮助
                ]
            }
        ]);

        // 如果是由于设备变动触发的"自动刷新"，忽略当前的 action
        if (isAutoRefreshing) {
            isAutoRefreshing = false;
            continue;
        }

        // 开始 start
        if (answers.action === 'start') {
            await planner_start(connectedDeviceId)

        } else if (answers.action === 'settings') {
            // printTitle('--- 系统设置 ---', 'normal', connectedDeviceId);
            await config()

        } else if (answers.action === 'devices') {
            // 设备管理菜单
            const newId = await index_devices(manager, connectedDeviceId);
            if (newId) {
                connectedDeviceId = newId;
                isReady = true;
            }
        } else if (answers.action === 'language') {
            printTitle(i18n.hi, 'normal'); // 清屏并打印标题
            const langAnswers = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'lang',
                    message: i18n.selectLang, // 请选择语言
                    choices: [
                        { name: '简体中文', value: 'zh-CN' },
                        { name: 'English', value: 'en-US' }
                    ]
                }
            ]);
            settings.setting.language = langAnswers.lang;
            await settings.save();
            i18n = t[langAnswers.lang];
            // 简单提示后继续循环
            await new Promise(r => setTimeout(r, 500));

        } else if (answers.action === 'help') {
            console.log(chalk.blue(i18n.helpInfo)); // 帮助信息
            await new Promise(r => setTimeout(r, 2000));
        } else {
            console.log(chalk.red(i18n.errorChoice)); // 选择错误
        }

    }

}



if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    main().catch(err => {
        console.error(chalk.red('发生错误:'), err);
    });
}
