import chalk from 'chalk'
import inquirer from 'inquirer'
import { printTitle ,userInput} from './ui.js';
import Settings from '../setting/settings.js';
import { presetModel } from './presetModel.js';




/** ### 模型操作主入口
 * @description 提供预设厂商配置和自定义模型配置的入口
 */
export default async function config_configModel() {
    const settings = await Settings.create();
    const lang = settings.getLanguage();

    const t: any = {
        'zh-CN': {
            title: '--- 自定义/本地模型配置 ---',
            selectOp: '   请选择模型操作',
            configApiKey: '   1. 配置 API Key (预设厂商)',
            customModel: '   2. 自定义/本地模型配置',
            backPrev: '   返回上一级',
            apiKeyTitle: '--- API Key 配置 ---',
            selectBrand: '请选择要配置的厂商',
            notConfigured: '(未配置)',
            back: '   返回',
            inputApiKey: (brand: string) => `请输入 ${brand} 的 API Key:`,
            apiKeySaved: (brand: string) => `\n   [√] ${brand} API Key 已保存！\n`,
            apiKeyError: '--- API Key 输入错误 ---',
            customTitle: '--- 自定义/本地模型配置 ---',
            fillConfig: '   请完成如下配置',
            notFilled: '(未填写)',
            inputApiKeyLabel: '请输入 API 密钥 (API Key)',
            inputFamily: '请输入模型系列 (Family, 如: openai, groq)',
            inputModel: '请输入模型型号 (Model, 如: gpt-4o)',
            inputBaseUrl: '请输入接口地址 (如: https://api.openai.com/v1)',
            inputAlias: '请输入配置别名 (Alias, 可选)',
            submit: '   [ 提交 ]',
            cancel: '   [ 取消 ]',
            requiredFields: '请务必填写：API Key、系列/厂商、模型型号和接口地址。',
            saved: (alias: string) => `自定义模型 "${alias}" 已保存！\n`,
            labelFamily: '系列/厂商',
            labelModel: '模型型号',
            labelBaseUrl: '接口地址',
            labelAlias: '自定义名称',
            hintFamily: '(如: openai, groq)',
            hintModel: '(如: gpt-4o, llama3)',
            hintBaseUrl: '(如: https://api.openai.com/v1)',
            hintAlias: '(可选, 留空则自动生成)',
        },
        'en-US': {
            title: '--- Custom/Local Model Config ---',
            selectOp: '   Select model operation',
            configApiKey: '   1. Configure API Key (Preset)',
            customModel: '   2. Custom/Local Model Config',
            backPrev: '   Back',
            apiKeyTitle: '--- API Key Config ---',
            selectBrand: 'Select provider to configure',
            notConfigured: '(Not configured)',
            back: '   Back',
            inputApiKey: (brand: string) => `Enter API Key for ${brand}:`,
            apiKeySaved: (brand: string) => `\n   [√] ${brand} API Key saved!\n`,
            apiKeyError: '--- API Key Input Error ---',
            customTitle: '--- Custom/Local Model Config ---',
            fillConfig: '   Please complete the following',
            notFilled: '(Not filled)',
            inputApiKeyLabel: 'Enter API Key',
            inputFamily: 'Enter model family (e.g. openai, groq)',
            inputModel: 'Enter model name (e.g. gpt-4o)',
            inputBaseUrl: 'Enter base URL (e.g. https://api.openai.com/v1)',
            inputAlias: 'Enter alias (optional)',
            submit: '   [ Submit ]',
            cancel: '   [ Cancel ]',
            requiredFields: 'API Key, Family, Model Name and Base URL are required.',
            saved: (alias: string) => `Custom model "${alias}" saved!\n`,
            labelFamily: 'Family',
            labelModel: 'Model',
            labelBaseUrl: 'Base URL',
            labelAlias: 'Alias',
            hintFamily: '(e.g. openai, groq)',
            hintModel: '(e.g. gpt-4o, llama3)',
            hintBaseUrl: '(e.g. https://api.openai.com/v1)',
            hintAlias: '(optional, auto-generated if empty)',
        }
    };

    const i18n = t[lang] || t['zh-CN'];

    while (true) {
        printTitle(i18n.title); // 自定义/本地模型配置

        const { setting } = await inquirer.prompt([
            {
                type: 'list',
                name: 'setting',
                message: chalk.bold.green(i18n.selectOp), // 请选择模型操作
                choices: [
                    { name: i18n.configApiKey, value: 'configAPIKey' },  // 配置 API Key
                    { name: i18n.customModel, value: 'customModel' },   // 自定义/本地模型配置
                    { name: chalk.red(i18n.backPrev), value: 'back' },  // 返回上一级
                ]
            }
        ]);

        if (setting === 'back') return;

        if (setting === 'configAPIKey') {
            await configAPIKey(i18n, settings);
        } else if (setting === 'customModel') {
            await customModel(i18n, settings);
        }
    }
}

/** ### ApiKey 配置
 * @description 配置预设厂商的apikey (Gemini, Kimi, Minimax)
 */
async function configAPIKey(i18n: any, settings: any) {
    const config = settings.setting;
    const modelApikey = config.modelApikey || {};

    let lastBrand = 'gemini';

    while (true) {
        printTitle(i18n.apiKeyTitle); // API Key 配置

        const { brand } = await inquirer.prompt([
            {
                type: 'list',
                name: 'brand',
                message: i18n.selectBrand, // 请选择要配置的厂商
                default: lastBrand,

                choices: [
                    ...Object.keys(presetModel).map((brand, index) => {
                        const apikey = modelApikey[brand.toLowerCase()] || modelApikey[brand];
                        const status = apikey
                            ? chalk.green(`(${apikey.slice(0, 5)}***)`)
                            : chalk.gray(i18n.notConfigured); // (未配置)
                        // 首字母大写显示显示名
                        const displayName = brand.charAt(0).toUpperCase() + brand.slice(1);
                        return {
                            name: `   ${index + 1}. ${displayName.padEnd(10)} ${status}`,
                            value: brand
                        };
                    }),
                    { name: chalk.red(i18n.back), value: 'back' } // 返回
                ]
            }
        ]);

        lastBrand = brand;

        if (brand === 'back') return;

        // --- 核心修复：兼容大小写并统一使用小写键名 ---
        const brandKey = brand.toLowerCase();
        const currentDefault = modelApikey[brandKey] || modelApikey[brand] || '';

        const key = (await userInput({
            message: i18n.inputApiKey(brand), // 请输入 xxx 的 API Key
            defaultValue: currentDefault,
            showDefaultValue: false, // API Key 保持不显式显示默认值
            subtitle: `--- ${brand} ---`
        })).trim();

        if (key && key.length > 1) {
            modelApikey[brandKey] = key;
            // 如果存在旧的大写键位，则清理掉以保持数据整洁
            if (brand !== brandKey) delete modelApikey[brand];

            await settings.save();
            console.log(chalk.green(i18n.apiKeySaved(brand))); // API Key 已保存
            await new Promise(r => setTimeout(r, 1000));
        } else {
            printTitle(i18n.apiKeyError, 'error'); // API Key 输入错误
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

/** ### 自定义模型配置
 * @description 构建并保存自定义模型配置对象
 */
async function customModel(i18n: any, settings: any) {
    const config = settings.setting;

    let apikey = '';
    let modelFamily = '';
    let modelName = '';
    let baseUrl = '';
    let alias = '';
    let lastChoice = 'apikey';

    while (true) {
        printTitle(i18n.customTitle); // 自定义/本地模型配置

        // 脱敏处理函数
        const mask = (str: string, label: string) => str ? `${label}(${str.slice(0, 5)}***)` : chalk.gray(`${label}${i18n.notFilled}`);

        const { chooseConfig } = await inquirer.prompt([
            {
                type: 'list',
                name: 'chooseConfig',
                message: chalk.bold.green(i18n.fillConfig), // 请完成如下配置
                default: lastChoice,
                pageSize: 15,
                choices: [
                    { name: `   1. ${`apiKey`.padEnd(15)}${mask(apikey, 'apikey')}`, value: 'apikey' },
                    { name: `   2. ${i18n.labelFamily.padEnd(15)}${modelFamily ? modelFamily : chalk.gray(i18n.hintFamily)}`, value: 'modelFamily' },
                    { name: `   3. ${i18n.labelModel.padEnd(15)}${modelName ? modelName : chalk.gray(i18n.hintModel)}`, value: 'modelName' },
                    { name: `   4. ${i18n.labelBaseUrl.padEnd(15)}${baseUrl ? baseUrl : chalk.gray(i18n.hintBaseUrl)}`, value: 'baseUrl' },
                    { name: `   5. ${i18n.labelAlias.padEnd(15)}${alias ? alias : chalk.gray(i18n.hintAlias)}`, value: 'alias' },
                    new inquirer.Separator(),
                    { name: chalk.green(i18n.submit), value: 'submit' },  // 提交
                    { name: chalk.red(i18n.cancel), value: 'back' }       // 取消
                ]
            }
        ]);

        lastChoice = chooseConfig;

        if (chooseConfig === 'back') return;

        if (chooseConfig === 'submit') {
            if (!apikey || !modelFamily || !modelName || !baseUrl) {
                printTitle(i18n.requiredFields, 'error'); // 请务必填写必填项
                await new Promise(r => setTimeout(r,2000))
                continue;
            }

            // 执行提交逻辑
            const finalAlias = alias || `custom-${modelName}`;
            const newModel = {
                apikey,
                modelFamily,
                modelName,
                baseUrl,
                alias: finalAlias
            };

            config.models = config.models || [];
            config.models.push(newModel);
            await settings.save();

            printTitle(i18n.saved(finalAlias)) // 自定义模型已保存
            await new Promise(r => setTimeout(r,1000))
            return;
        }

        const prompts: Record<string, string> = {
            apikey: i18n.inputApiKeyLabel,   // 请输入 API 密钥
            modelFamily: i18n.inputFamily,   // 请输入模型系列
            modelName: i18n.inputModel,      // 请输入模型型号
            baseUrl: i18n.inputBaseUrl,       // 请输入接口地址
            alias: i18n.inputAlias            // 请输入配置别名
        };

        const defaultValue = (chooseConfig === 'apikey' ? apikey :
            chooseConfig === 'modelFamily' ? modelFamily :
                chooseConfig === 'modelName' ? modelName :
                    chooseConfig === 'baseUrl' ? baseUrl : alias);

        const value = await userInput({
            message: prompts[chooseConfig],
            defaultValue,
            showDefaultValue: chooseConfig !== 'apikey', // 只有非 API Key 字段显示默认值内容
            subtitle: i18n.customTitle // 自定义/本地模型配置
        });

        if (chooseConfig === 'apikey') apikey = value;
        else if (chooseConfig === 'modelFamily') modelFamily = value;
        else if (chooseConfig === 'modelName') modelName = value;
        else if (chooseConfig === 'baseUrl') baseUrl = value;
        else if (chooseConfig === 'alias') alias = value;
    }
}



