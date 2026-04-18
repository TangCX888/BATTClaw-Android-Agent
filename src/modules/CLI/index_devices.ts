import chalk from 'chalk';
import inquirer from 'inquirer';
import { printTitle } from './ui.js';
import { DevicesManager } from '../devices/devicesManager.class.js';
import Settings from '../setting/settings.js';

/** ### 设备选择 
 * @param manager 设备管理器 class
 * @param connectedDeviceId 已经连接的设备 ID
 * @returns 返回选中的新设备 ID，若无变更或返回则为 null
 */
export async function index_devices(manager: DevicesManager, connectedDeviceId: string | null): Promise<string | null> {
    const settings = await Settings.create();
    const lang = settings.getLanguage();

    const t: any = {
        'zh-CN': {
            deviceMgmt: '--- 设备管理 ---',
            noOnlineDevices: '\n目前没有检测到在线设备。',
            onlineDevicesList: '\n当前在线设备列表:',
            tableId: '设备ID',
            tableModel: '型号',
            tableType: '类型',
            tableStatus: '状态',
            statusReady: '就绪',
            statusNotReady: '未就绪',
            selectDevice: '请选择要连接的设备 (直接回车保持不变):',
            backToMain: '返回主菜单',
            switchSuccess: (id: string) => `\n已成功切换到设备: ${id}`,
        },
        'en-US': {
            deviceMgmt: '--- Device Management ---',
            noOnlineDevices: '\nNo online devices detected.',
            onlineDevicesList: '\nOnline Devices:',
            tableId: 'Device ID',
            tableModel: 'Model',
            tableType: 'Type',
            tableStatus: 'Status',
            statusReady: 'Ready',
            statusNotReady: 'Not Ready',
            selectDevice: 'Select device to connect (Enter to keep current):',
            backToMain: 'Back to Main Menu',
            switchSuccess: (id: string) => `\nSuccessfully switched to: ${id}`,
        }
    };

    const i18n = t[lang] || t['zh-CN'];

    printTitle(i18n.deviceMgmt, 'normal'); // 设备管理
    const devices = await manager.listDevices();

    if (devices.length === 0) {
        console.log(chalk.yellow(i18n.noOnlineDevices)); // 目前没有检测到在线设备
    } else {
        console.log(chalk.bold.green(i18n.onlineDevicesList)); // 当前在线设备列表
        console.table(devices.map(d => ({
            [i18n.tableId]: d.id,       // 设备ID
            [i18n.tableModel]: d.model, // 型号
            [i18n.tableType]: d.type,   // 类型
            [i18n.tableStatus]: d.isReady ? i18n.statusReady : i18n.statusNotReady // 状态：就绪/未就绪
        })));

        const { selectedId } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedId',
                message: i18n.selectDevice, // 请选择要连接的设备
                choices: [
                    ...devices.map(d => ({ name: `${d.id} (${d.model})`, value: d.id })),
                    { name: i18n.backToMain, value: 'back' } // 返回主菜单
                ]
            }
        ]);

        if (selectedId && selectedId !== 'back' && selectedId !== connectedDeviceId) {
            console.log(chalk.green(i18n.switchSuccess(selectedId))); // 已成功切换到设备
            await new Promise(r => setTimeout(r, 1500));
            return selectedId;
        }

        if (selectedId === connectedDeviceId) {
            return selectedId
        }
    }
    return null;
}