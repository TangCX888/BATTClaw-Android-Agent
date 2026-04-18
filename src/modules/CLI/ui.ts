import chalk from 'chalk';
import inquirer from 'inquirer';

/** ### 打印全局标题 Logo 
 * @param subtitle 可选的副标题
 * @param type 消息类型：normal | warn | error
 * @param connectedDeviceId 当前连接的设备 ID (用于在标题下方展示)
 */
export function printTitle(subtitle?: string, type: 'normal' | 'warn' | 'error' = 'normal', clear: boolean = true) {

    if (clear) console.clear()
    const logo = `
  ___   _ _____ _____ ___ _   ___      __
 | _ ) /_\\_   _|_   _/ __| | /_\\ \\    / /
 | _ \\/ _ \\| |   | || (__| |/ _ \\ \\/\\/ / 
 |___/_/ \\_\\_|   |_| \\___|_/_/ \\_\\_/\\_/  
    `;
    let colorFunc = chalk.bold.green;
    if (type === 'error') colorFunc = chalk.red;
    if (type === 'warn') colorFunc = chalk.yellow;
    console.log(colorFunc(logo));

    if (subtitle) {
        // 计算居中空格 (总宽约 40 字符)
        const totalWidth = 40;
        const subtitleLength = subtitle.replace(/[\u4e00-\u9fa5]/g, 'aa').length; // 简单处理中文字饰长度
        const padding = Math.max(0, Math.floor((totalWidth - subtitleLength) / 2));

        console.log(colorFunc(`${' '.repeat(padding)}${subtitle} \n`));
    }
}

/** 通用输入函数参数配置 */
interface userInputParams {
    /** 提示文本 */
    message: string,
    /** 默认值 */
    defaultValue?: string,
    /** 是否显示默认文本 */
    showDefaultValue?: boolean,
    /** 标题 */
    subtitle?: string,
    /** 当前连接的设备 ID */
    connectedDeviceId?: string | null;
    /** 是否清屏 (默认 true) */
    clear?: boolean;
}

/** ### 通用输入函数 
 * @description 清空页面并获取用户输入并带上副标题
 */
export async function userInput(params: userInputParams): Promise<string> {
    const { message, defaultValue, showDefaultValue, subtitle, clear = true } = params;
    printTitle(subtitle, 'normal', clear);
    const { value } = await inquirer.prompt([
        {
            type: 'input',
            name: 'value',
            // 提示文本
            message: chalk.bold.blue('  > ') + message + '\n',
            // 根据配置决定是否在输入框中回显默认值
            default: showDefaultValue ? (defaultValue || undefined) : undefined
        }
    ]);
    return value;
}
