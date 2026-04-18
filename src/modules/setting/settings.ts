import path from "path"
import fs from 'fs/promises'
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 
 * 用户设置
 * 
 * @example
 * ```typescript
 * // 异步创建并初始化设置实例
 * const settings = await Settings.create();
 * 
 * // 直接通过 .setting 属性访问或修改内存中的设置
 * console.log('当前语言:', settings.setting.language);
 * 
 * // 修改设置后手动调用 save 保持同步到本地文件
 * settings.setting.activeModel.apikey = 'your-key';
 * await settings.save();
 * ```
 */
class Settings {

    /** ### 用户配置文件位置 */
    private filePath = path.join(__dirname, '../../../data', 'setting.json')

    /** 内存中的设置对象 */
    public setting: any = {}

    constructor() {
    }

    /** 初始化/检查设置 */
    async init() {
        // 确保 data 目录存在
        const dir = path.dirname(this.filePath)
        try {
            await fs.mkdir(dir, { recursive: true })
        } catch (e) {}

        // 尝试读取现有设置
        try {
            const data = await fs.readFile(this.filePath, 'utf-8')
            this.setting = JSON.parse(data)
        } catch (e) {
            // 文件不存在，初始化默认值
            this.setting = {}
        }

        // 补齐项目根目录
        if (!this.setting.root) {
            this.setting.root = process.cwd()
        }

        /**
         * 检查语言配置块 setting.language
         * 获取当前系统的语言，如果是中文则写为 zh-CN 其他均为 en-US
         */
        if (!this.setting.language) {
            const envLang = process.env.LANG || process.env.LANGUAGE || 'en-US'
            this.setting.language = (envLang.includes('zh') || envLang.includes('CN')) ? 'zh-CN' : 'en-US'
        }

        /** 代理配置 */
        if (!this.setting.proxy) {
            this.setting.proxy = {
                enable: false,
                path: ""
            }
        }

        // 检查模型配置模块
        if (!this.setting.activeModel) {
            this.setting.activeModel = {
                modelFamily: null,
                modelName: null,
                baseUrl: null,
                alias: null,
                apikey: null,
            }
        }

        // 默认 gemini,kimi,minimax
        if (!this.setting.modelApikey) {
            this.setting.modelApikey = {}
        }

        if (!this.setting.models || Object.keys(this.setting.models).length === 0) {
            this.setting.models = []
        }

        await this.save()
    }

    /** 保存设置 */
    public async save() {
        try {
            await fs.writeFile(this.filePath, JSON.stringify(this.setting, null, 4), 'utf-8')
        } catch (e) {
            console.error('保存设置失败:', e)
        }
    }

    /** 读取设置 */
    async get() {
        return this.setting
    }

    /** ### 获取当前语言配置 */
    public getLanguage(): 'zh-CN' | 'en-US' {
        return this.setting.language || 'zh-CN';
    }

    /** ### 创建用户设置类 */
    public static async create() {
        const setting = new Settings()
        await setting.init()
        return setting
    }

}

export default Settings