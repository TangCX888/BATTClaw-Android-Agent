import chalk from 'chalk'
import inquirer from 'inquirer'
import { printTitle } from './ui.js';
import Settings from '../setting/settings.js';
import { presetModel } from './presetModel.js';


/** 模型设置入口 */
export default async function config_chooseModel() {

    const settings = await Settings.create();
    const lang = settings.getLanguage();

    const t: any = {
        'zh-CN': {
            title: '--- 选择模型 ---',
            customModels: '--- 自定义模型 ---',
            backPrev: '   返回上一级',
            noApiKey: '请先设置 API Key',
            selectModel: '请选择要使用的模型:',
            activated: '--- 模型已激活 ---',
            selected: (alias: string) => `已选中: ${alias}`,
            useModel: '   使用该模型',
            deleteConfig: '   删除该配置',
            back: '   返回',
            deleted: '--- 配置已删除 ---',
            notConfigured: '(未配置)',
            currentConfig: '--- 当前配置详情 ---',
        },
        'en-US': {
            title: '--- Select Model ---',
            customModels: '--- Custom Models ---',
            backPrev: '   Back',
            noApiKey: 'Please set API Key first',
            selectModel: 'Select model to use:',
            activated: '--- Model Activated ---',
            selected: (alias: string) => `Selected: ${alias}`,
            useModel: '   Use this model',
            deleteConfig: '   Delete config',
            back: '   Back',
            deleted: '--- Config Deleted ---',
            notConfigured: '(Not configured)',
            currentConfig: '--- Current Config ---',
        }
    };

    const i18n = t[lang] || t['zh-CN'];

    while (true) {
        const config = settings.setting;
        const modelApikey = config.modelApikey || {};
        const models = config.models || [];
        const activeModel = config.activeModel || {};

        printTitle(i18n.title); // 选择模型

        // 1. 构建选项列表
        const choices: any[] = [];

        // --- 预设厂商型号 ---
        let hasPresets = false;
        Object.keys(presetModel).forEach(brand => {
            const apikey = modelApikey[brand.toLowerCase()] || modelApikey[brand];
            if (apikey) {
                choices.push(new inquirer.Separator(`--- ${brand} ---`));
                presetModel[brand].modelName.forEach(mName => {
                    hasPresets = true;
                    const isActive = activeModel.modelFamily === brand && activeModel.modelName === mName;
                    choices.push({
                        name: `   ${isActive ? chalk.green('●') : ' '} ${brand.charAt(0).toUpperCase() + brand.slice(1)} - ${mName}`,
                        value: { type: 'preset', brand, modelName: mName }
                    });
                });
            }
        });

        // --- 自定义模型 ---
        if (models.length > 0) {
            choices.push(new inquirer.Separator(i18n.customModels)); // 自定义模型
            models.forEach((m: any, index: number) => {
                const isActive = activeModel.alias === m.alias;
                choices.push({
                    name: `   ${isActive ? chalk.green('●') : ' '} ${m.alias || `Custom-${index}`}`,
                    value: { type: 'custom', index, data: m }
                });
            });
        }

        // --- 返回选项 ---
        choices.push(new inquirer.Separator());
        choices.push({ name: chalk.red(i18n.backPrev), value: 'back' }); // 返回上一级

        // 2. 检查配置是否为空
        if (choices.filter(c => c.value && c.value !== 'back').length === 0) {
            printTitle(i18n.noApiKey, 'error'); // 请先设置 API Key
            await new Promise(r => setTimeout(r, 1500));
            return;
        }

        const { selection } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selection',
                message: chalk.bold.green(i18n.selectModel), // 请选择要使用的模型
                pageSize: 12,
                choices
            }
        ]);

        if (selection === 'back') return;

        // 3. 处理选择逻辑
        if (selection.type === 'preset') {
            // 激活预设模型
            const { brand, modelName } = selection;
            const presetInfo = presetModel[brand];

            config.activeModel = {
                modelFamily: brand,
                modelName: modelName,
                baseUrl: presetInfo.baseUrl,
                apikey: modelApikey[brand.toLowerCase()] || modelApikey[brand],
                alias: `${brand}-${modelName}`
            };

            await settings.save();
            printTitle(i18n.activated); // 模型已激活
            await new Promise(r => setTimeout(r, 1000));
            return; // 激活后通常返回
        }

        if (selection.type === 'custom') {
            // 自定义模型进入二级菜单 (按照流程图)
            const { index, data } = selection;
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: i18n.selected(data.alias), // 已选中: xxx
                    choices: [
                        { name: chalk.green(i18n.useModel), value: 'use' },      // 使用该模型
                        { name: chalk.red(i18n.deleteConfig), value: 'delete' },  // 删除该配置
                        { name: i18n.back, value: 'back' }                        // 返回
                    ]
                }
            ]);

            if (action === 'use') {
                config.activeModel = { ...data };
                await settings.save();
                printTitle(i18n.activated); // 模型已激活
                await new Promise(r => setTimeout(r, 1000));
                return;
            } else if (action === 'delete') {
                config.models.splice(index, 1);
                await settings.save();
                printTitle(i18n.deleted, 'warn'); // 配置已删除
                await new Promise(r => setTimeout(r, 1000));
                // 继续循环，重新渲染列表
            }
        }
    }
}


/** ### 获取当前配置 (工具函数) */
async function getModel() {
    const settings = await Settings.create();
    console.log(chalk.cyan('\n --- 当前配置详情 ---'));
    console.log(settings.setting.activeModel);
}


import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    getModel()
}