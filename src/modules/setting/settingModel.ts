import Settings from "./settings.js";
import * as crypto from 'crypto';

/** ### 创建模型时传入的参数 */
export interface createParams {
    /** 厂商 */
    modelFamily: string,
    /** 模型名 */
    modelName: string,
    /** 模型地址 */
    baseUrl: string,
    /** apiKey */
    apiKey: string,
    /** 协议 - 默认:openai */
    driver: string,
    /** 别名 */
    alias: string
}

/** 模型参数 */
export interface modelParams extends createParams {
    /** ID , 随机分配的默认 id*/
    modelId: string,
}

/** ### 厂商预设定义 */
export const VENDOR_PRESETS: Record<string, { baseUrl: string, models: string[] }> = {
    'gemini': {
        baseUrl: 'https://generativelanguage.googleapis.com',
        models: ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview']
    },
    'moonshot': {
        baseUrl: 'https://api.moonshot.cn/v1',
        models: ['kimi-k2.5']
    },
    'minimax': {
        baseUrl: 'https://api.minimax.chat/v1',
        models: ['MiniMax-M2.7']
    }
}

/** 列表选项接口 (包含预设与自定义) */
interface ModelOption {
    /** 类型: preset (预设) / custom (自定义) */
    type: 'preset' | 'custom',
    /** 厂商系列 */
    family: string,
    /** 具体型号名 (如果是自定义模型，即为 modelName) */
    name: string,
    /** 在 CLI 列表中显示的文字标签 */
    label: string,
    /** 唯一识别码 (预设为型号名，自定义为 UUID) */
    uniqueId: string,
    /** (仅自定义模型含有) 别名 */
    alias?: string,
    /** (仅自定义模型含有) 原始 modelParams 所有属性 */
    [key: string]: any
}

/** 模型设置逻辑类 */
class SettingModel {
    private settings: Settings;

    constructor(settings: Settings) {
        this.settings = settings;
    }

    /** ### 设置预设厂商的 API Key
     * @param vendor 厂商标识 (gemini/kimi/minimax)
     * @param key API Key
     */
    async setApiKey(vendor: 'gemini' | 'kimi' | 'minimax', key: string) {
        if (!this.settings.setting.modelApikey) {
            this.settings.setting.modelApikey = {};
        }
        this.settings.setting.modelApikey[vendor] = key;
        await this.settings.save();
    }

    /** ### 创建自定义模型
     * @description 通过传入参数来创建模型,并返回模型参数
     */
    async createModel(param: createParams): Promise<null | modelParams> {
        try {
            const modelId = crypto.randomUUID();
            const newModel: modelParams = {
                ...param,
                modelId
            };

            if (!this.settings.setting.models) {
                this.settings.setting.models = [];
            }

            this.settings.setting.models.push(newModel);
            await this.settings.save();
            return newModel;
        } catch (e) {
            console.error('[SettingModel] 创建模型失败:', e);
            return null;
        }
    }

    /** ### 删除模型
     * @description 通过传入的 id 删除这个模型的配置
     */
    async deleteModel(id: string) {
        if (!this.settings.setting.models) return;
        this.settings.setting.models = this.settings.setting.models.filter((m: modelParams) => m.modelId !== id);
        await this.settings.save();
    }

    /** ### 修改模型
     * @description 通过传入 id 、 配置 、值 来修改模型
     */
    async editModel(
        id: string,
        config: 'modelFamily' | 'modelName' | 'baseUrl' | 'apiKey' | 'alias',
        value: string
    ) {
        const model = this.settings.setting.models?.find((m: modelParams) => m.modelId === id);
        if (model) {
            model[config] = value;
            await this.settings.save();
        }
    }

    /** ### 查询所有可用模型选项
     * @description 返回一个处理后的列表，包含以下逻辑：
     * 1. **注入预设模型**: 遍历内置厂商，只有在 `modelApikey` 中填写了对应 Key 的厂商才会返回其型号。
     * 2. **注入自定义模型**: 遍历用户手动添加的模型，如果设置了 `alias` 则优先在标签中展示。
     * 
     * @returns 一个 `ModelOption` 数组，可直接用于 Inquirer 等交互式界面的 choices 中。
     */
    async queryAllModels(): Promise<ModelOption[]> {
        const results: ModelOption[] = [];
        const modelApikey = this.settings.setting.modelApikey || {};

        // 1. 注入预设
        for (const [family, preset] of Object.entries(VENDOR_PRESETS)) {
            // 映射 family 名字到 modelApikey 的 key (moonshot -> kimi)
            const apiKeyName = family === 'moonshot' ? 'kimi' : family;
            const apiKey = modelApikey[apiKeyName];

            // 只有填写了 apikey 以后才返回该厂商的预设模型
            if (apiKey && apiKey.trim() !== '') {
                preset.models.forEach(name => {
                    results.push({
                        type: 'preset',
                        family,
                        name,
                        label: `[预设] ${family} - ${name}`,
                        uniqueId: name // 直接使用型号名
                    });
                });
            }
        }

        // 2. 注入自定义
        if (this.settings.setting.models) {
            this.settings.setting.models.forEach((m: modelParams) => {
                const label = m.alias ? `[自定义] ${m.alias} (${m.modelFamily})` : `[自定义] ${m.modelFamily} - ${m.modelName}`;
                results.push({
                    ...m,
                    type: 'custom',
                    family: m.modelFamily,
                    name: m.modelName,
                    label,
                    uniqueId: m.modelId
                });
            });
        }

        return results;
    }

    /** ### 选择当前模型
     * @description 通过 ID 或 预设名选定模型
     * @param modelIdOrModelName 模型ID或者预设厂商的模型名
     * - 当 `isPreset` 为默认 false 时当前参数表示用户自定义的模型 ID 
     * - 当 `isPreset` 为 true 时表示用户选择的是预设模型，那当前参数表示预设模型的型号
     * @param isPreset 是否是预设厂商
     */
    async chooseCurrentModel(
        modelIdOrModelName: string,
        isPreset: boolean = false
    ) {
        if (!isPreset) {
            // 情况 A: 用户选择了自定义模型
            const customModel = this.settings.setting.models?.find((m: modelParams) => m.modelId === modelIdOrModelName);
            if (customModel) {
                this.settings.setting.activeModel = {
                    modelFamily: customModel.modelFamily,
                    modelName: customModel.modelName,
                    baseUrl: customModel.baseUrl,
                    apikey: customModel.apiKey,
                    proxy: this.settings.setting.proxy || {}
                };
            }
        } else {
            // 情况 B: 用户选择了预设模型
            // 直接通过型号名查找所在的预设厂商配置
            let foundFamily: string | null = null;
            let foundPreset: any = null;

            for (const [family, preset] of Object.entries(VENDOR_PRESETS)) {
                if (preset.models.includes(modelIdOrModelName)) {
                    foundFamily = family;
                    foundPreset = preset;
                    break;
                }
            }

            if (foundFamily && foundPreset) {
                // 获取对应的全局 Key
                const apiKeyName = foundFamily === 'moonshot' ? 'kimi' : foundFamily;
                const globalKey = this.settings.setting.modelApikey?.[apiKeyName];

                this.settings.setting.activeModel = {
                    modelFamily: foundFamily,
                    modelName: modelIdOrModelName, // 传入的即为型号名
                    baseUrl: foundPreset.baseUrl,
                    apikey: globalKey || null,
                    proxy: this.settings.setting.proxy || {}
                };
            }
        }

        await this.settings.save();
    }
}

export default SettingModel;