import chalk from 'chalk'
import inquirer from 'inquirer'
import { printTitle, userInput } from './ui.js';
import config_chooseModel from './config_chooseModel.js';
import config_configModel from './config_configModel.js';
import { config_proxy } from './config_proxy.js';
import Settings from '../setting/settings.js';




/** 配置设置 */
export default async function config () {

    const settings = await Settings.create();
    const lang = settings.getLanguage();

    const t: any = {
        'zh-CN': {
            sysSettings: '--- 系统设置 ---',
            chooseSetting: '请选择设置内容',
            chooseModel: '   1. 选择模型',
            configModel: '   2. 模型配置',
            proxy: '   3. 代理',
            back: '   返回',
        },
        'en-US': {
            sysSettings: '--- System Settings ---',
            chooseSetting: 'Please select setting item',
            chooseModel: '   1. Select Model',
            configModel: '   2. Model Config',
            proxy: '   3. Proxy',
            back: '   Back',
        }
    };

    const i18n = t[lang] || t['zh-CN'];

    while (true) {

        printTitle(i18n.sysSettings) // 系统设置

        // 设置入口
        const choose = await inquirer.prompt([
            {
                type: 'list',
                name: 'setting',
                message: chalk.bold.green(i18n.chooseSetting) + '', // 请选择设置内容
                choices: [
                    { name: i18n.chooseModel, value: 'config_chooseModel' },  // 选择模型
                    { name: i18n.configModel, value: 'config_configModel' },  // 模型配置
                    { name: i18n.proxy, value: 'proxy' },                     // 代理
                    { name: chalk.red(i18n.back), value: 'back' },            // 返回
                ]
            }
        ])

        switch (choose.setting) {

            // 选择模型  --->  可以选择配置过的自定义模型，或配置了预设厂商 apiKey 的模型
            case 'config_chooseModel': {
                await config_chooseModel()
                break;
            }

            // 模型配置  --->  1. apikey 配置 。  2. 自定义/本地模型配置
            case 'config_configModel': {
                await config_configModel()
                break;
            }

            // 配置本地代理 ---> 本地代理配置
            case 'proxy': {
                await config_proxy()
                break;
            }

            // 返回上一级
            case 'back': {
                return;
            }
            default: {
                return
            }
        }

    }
}