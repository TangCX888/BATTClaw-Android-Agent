import chalk from 'chalk'
import inquirer from 'inquirer'
import { printTitle ,userInput} from './ui.js';
import Settings from '../setting/settings.js';


/** 代理设置 */
export async function config_proxy() {

    const settings = await Settings.create();
    const lang = settings.getLanguage();

    const t: any = {
        'zh-CN': {
            title: '--- 代理设置 ---',
            selectOp: '请选择操作:',
            proxyOn: '已开启 [ON]',
            proxyOff: '已关闭 [OFF]',
            proxyStatus: '   1. 代理状态: ',
            proxyAddr: '   2. 代理地址: ',
            notSet: '(未设置)',
            back: '   返回',
            toggled: (on: boolean) => `--- 代理已${on ? '开启' : '关闭'} ---`,
            inputAddr: '请输入代理地址 (如 http://127.0.0.1:8888):',
            addrSubtitle: '--- 设置代理地址 ---',
            addrUpdated: '--- 代理地址已更新 ---',
        },
        'en-US': {
            title: '--- Proxy Settings ---',
            selectOp: 'Select action:',
            proxyOn: 'Enabled [ON]',
            proxyOff: 'Disabled [OFF]',
            proxyStatus: '   1. Proxy Status: ',
            proxyAddr: '   2. Proxy Address: ',
            notSet: '(Not set)',
            back: '   Back',
            toggled: (on: boolean) => `--- Proxy ${on ? 'Enabled' : 'Disabled'} ---`,
            inputAddr: 'Enter proxy address (e.g. http://127.0.0.1:8888):',
            addrSubtitle: '--- Set Proxy Address ---',
            addrUpdated: '--- Proxy Address Updated ---',
        }
    };

    const i18n = t[lang] || t['zh-CN'];

    while (true) {
        const proxy = settings.setting.proxy;

        printTitle(i18n.title); // 代理设置

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: chalk.bold.green(i18n.selectOp), // 请选择操作
                choices: [
                    { 
                        name: `${i18n.proxyStatus}${proxy.enable ? chalk.green(i18n.proxyOn) : chalk.red(i18n.proxyOff)}`, // 代理状态：已开启/已关闭
                        value: 'toggle' 
                    },
                    { 
                        name: `${i18n.proxyAddr}${proxy.path ? chalk.blue(proxy.path) : chalk.gray(i18n.notSet)}`, // 代理地址
                        value: 'setPath' 
                    },
                    { name: chalk.red(i18n.back), value: 'back' } // 返回
                ]
            }
        ]);

        if (action === 'back') return;

        if (action === 'toggle') {
            proxy.enable = !proxy.enable;
            await settings.save();
            printTitle(i18n.toggled(proxy.enable)); // 代理已开启/关闭
            await new Promise(r => setTimeout(r, 1000));
        }

        if (action === 'setPath') {
            const newPath = await userInput({
                message: i18n.inputAddr, // 请输入代理地址
                defaultValue: proxy.path,
                showDefaultValue: true,
                subtitle: i18n.addrSubtitle // 设置代理地址
            });

            if (newPath) {
                proxy.path = newPath.trim();
                await settings.save();
                printTitle(i18n.addrUpdated); // 代理地址已更新
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
}