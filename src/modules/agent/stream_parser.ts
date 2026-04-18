import { AndroidAgent } from './adb/tools/AndroidAgent.class.js';
import { logger } from '../../utils/logger.js';

/**
 * ### 从 AI 完整文本中解析所有 <function>toolName(args)</function> 调用
 * 支持一次性解析多个 <function> 标签，按出现顺序返回数组
 * @returns 解析成功返回 { tool, args }[] 数组，找不到任何 <function> 标签则返回空数组 []
 * @example
 * // 单个函数:
 * // 输入: '<think>需要点击搜索框</think>\n<function>click(x=540, y=120)</function>'
 * // 返回: [{ tool: 'click', args: { x: 540, y: 120 } }]
 * 
 * // 多个函数（顺序执行）:
 * // 输入: '<function>click(x=540, y=120)</function>\n<function>inputText(text="iPhone")</function>'
 * // 返回: [{ tool: 'click', args: { x: 540, y: 120 } }, { tool: 'inputText', args: { text: 'iPhone' } }]
 * 
 * // 无参数函数:
 * // 输入: '<function>back()</function>'
 * // 返回: [{ tool: 'back', args: {} }]
 * 
 * // 无 function 标签:
 * // 输入: '没有 function 标签的纯文本'
 * // 返回: []
 */
export function parseFunctionCall(text: string): { tool: string, args: Record<string, any>, argsList: any[] }[] {
    const results: { tool: string, args: Record<string, any>, argsList: any[] }[] = [];

    // 1. 标准模式匹配：寻找严格闭合的 <function>...</function> 标签
    const regex = /<function>\s*([\s\S]*?)\s*<\/function>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const content = match[1].trim();
        // 增强正则：允许 functions. 前缀，允许函数名带点
        const fnMatch = content.match(/^(?:functions\.)?([\w.]+)\(([\s\S]*)\)$/);
        if (!fnMatch) continue;

        const tool = fnMatch[1];
        const rawArgs = fnMatch[2].trim();

        if (!rawArgs) {
            results.push({ tool, args: {}, argsList: [] });
        } else {
            const { map, list } = parseFunctionArgs(rawArgs);
            results.push({ tool, args: map, argsList: list });
        }
    }

    // 2. 降级兼容匹配：针对国内模型（如Kimi）无视System Prompt或污染记忆时自创的 [调用函数] click(...) 格式
    const fallbackRegex = /\[调用函数\]\s*([a-zA-Z_]\w*\([\s\S]*?\))/g;
    let fbMatch;
    while ((fbMatch = fallbackRegex.exec(text)) !== null) {
        const content = fbMatch[1].trim();
        const fnMatch = content.match(/^(\w+)\(([\s\S]*)\)$/);
        if (!fnMatch) continue;

        const tool = fnMatch[1];
        const rawArgs = fnMatch[2].trim();

        if (!rawArgs) {
            results.push({ tool, args: {}, argsList: [] });
        } else {
            const { map, list } = parseFunctionArgs(rawArgs);
            results.push({ tool, args: map, argsList: list });
        }
    }

    // 3. 原生标签兼容模式：针对某些模型（如 Qwen/Gemini）高度结构化的原生输出
    // 兼容格式: <|tool_call_begin|>functions.tool:0<|tool_call_argument_begin|>{"key":"val"}<|tool_call_end|>
    const nativeRegex = /<\|tool_call_begin\|>functions\.([\w.]+)(?::\d+)?(?:<\|tool_call_argument_begin\|>)?([\s\S]*?)(?:<\|tool_call_end\|>)/g;
    let nMatch;
    while ((nMatch = nativeRegex.exec(text)) !== null) {
        const tool = nMatch[1];
        let rawArgs = nMatch[2].trim();

        // 如果参数是 JSON 格式，尝试解析并重构为 key=value 风格供后续统一处理，或者直接作为 map
        try {
            if (rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
                const jsonObj = JSON.parse(rawArgs);
                results.push({ tool, args: jsonObj, argsList: Object.values(jsonObj) });
                continue;
            }
        } catch (e) {
            // 解析失败则按普通字符串处理
        }

        const { map, list } = parseFunctionArgs(rawArgs);
        results.push({ tool, args: map, argsList: list });
    }

    // 4. 单次调用数量限制 (熔断机制)
    if (results.length > 5) {
        logger(`[parseFunctionCall] ⚠️ 警告：检测到单次调用函数数量过多 (${results.length} 个)，触发熔断保护。`, { error: true });
        return [{
            tool: 'report',
            args: { text: `拦截：单次生成的函数调用数量为 ${results.length} 个，超出了系统单次最多 5 个的限制。请重新检查当前状态并重新分配任务。` },
            argsList: []
        }];
    }

    return results;
}

/**
 * ### 解析 key=value 风格的参数字符串
 * 支持：数字、带引号的字符串、JSON 数组、布尔值
 * 示例：`x=100, y=200` → `{ x: 100, y: 200 }`
 * 示例：`text="hello"` → `{ text: "hello" }`
 * 示例：`allPlan=["步骤1", "步骤2"]` → `{ allPlan: ["步骤1", "步骤2"] }`
 */
export function parseFunctionArgs(argsStr: string): { map: Record<string, any>, list: any[] } {
    if (!argsStr.trim()) return { map: {}, list: [] };

    const argsMap: Record<string, any> = {};
    const argsList: any[] = [];
    let i = 0;
    const len = argsStr.length;

    while (i < len) {       // 挨个解析所有的字符串到结束为止
        // 连续跳过所有空白和逗号
        while (i < len && /[\s,]/.test(argsStr[i])) i++;
        if (i >= len) break;

        // 探测是否是 key=value 模式还是纯 value 模式
        // 在遇到 '=' 之前，可能是 key，也可能是字符串/数组/数字值的一部分

        /** ### 开始的索引 */
        let start = i;
        let potentialKey = '';
        let hasEquals = false;

        // 尝试寻找下一个 '='
        let j = i;
        while (j < len && argsStr[j] !== ',' && argsStr[j] !== ')') {
            if (argsStr[j] === '=') {
                hasEquals = true;
                break;
            }
            if (argsStr[j] === '"' || argsStr[j] === '[') {
                // 如果遇到引号或方括号开头的，大概率是值的一部分（即使内部有等号也在引号内）
                break;
            }
            j++;
        }

        let finalVal: any;
        let key: string | undefined;

        if (hasEquals) {
            // --- key=value 模式 ---
            while (i < len && argsStr[i] !== '=') {
                if (!/\s/.test(argsStr[i])) potentialKey += argsStr[i];
                i++;
            }
            key = potentialKey;
            i++; // 跳过 '='
            while (i < len && argsStr[i] === ' ') i++; // 跳过 '=' 后的空白
        } else {
            // --- 纯 value 模式 ---
            key = `_arg_${argsList.length}`;
        }

        if (i >= len) break;

        // 解析值
        if (argsStr[i] === '"') {
            i++; // 跳过开头引号
            let val = '';
            while (i < len && argsStr[i] !== '"') {
                if (argsStr[i] === '\\' && i + 1 < len) {
                    i++;
                    val += argsStr[i];
                } else {
                    val += argsStr[i];
                }
                i++;
            }
            if (i < len) i++; // 跳过结尾引号
            finalVal = val;
        } else if (argsStr[i] === '[') {
            let depth = 0;
            let val = '';
            while (i < len) {
                if (argsStr[i] === '[') depth++;
                else if (argsStr[i] === ']') depth--;
                val += argsStr[i];
                i++;
                if (depth === 0) break;
            }
            try { finalVal = JSON.parse(val); } catch { finalVal = val; }
        } else {
            let val = '';
            while (i < len && argsStr[i] !== ',' && argsStr[i] !== ')') {
                val += argsStr[i];
                i++;
            }
            val = val.trim();
            const num = Number(val);
            if (!isNaN(num) && val !== '') finalVal = num;
            else if (val === 'true') finalVal = true;
            else if (val === 'false') finalVal = false;
            else finalVal = val;
        }

        if (key) argsMap[key] = finalVal;
        argsList.push(finalVal);
    }

    return { map: argsMap, list: argsList };
}

/**
 * ### 根据解析出的函数调用执行对应的 AndroidAgent 方法
 * @param agent 已初始化的 AndroidAgent 实例
 * @param parsed 解析后的 { tool, args }
 * @returns 执行结果对象
 */
export async function executeAction(
    agent: AndroidAgent,
    /** ### 解析后的动作执行对象 
     * @param tool 工具名称 (如 click)
     * @param args 参数 Map (如 { x: 100, y: 200 })
     * @param argsList 参数值列表 (如 [100, 200])
     */
    parsed: { tool: string, args: Record<string, any>, argsList: any[] }
): Promise<any> {
    const { tool, args, argsList } = parsed;

    const isDebug = process.env.DEBUG === 'true' || process.env.DEBUG_FUNCTIONCALLING === '1';

    const argsStr = Object.entries(args)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');

    // 1. 技术调试日志 (仅在 DEBUG 模式显示)
    logger(`\x1b[32m[AndroidAgent] 调用 ${tool}(${argsStr})\x1b[0m`, { debug: true });

    // 2. 自然语言动作映射 (演示模式可见)
    const actionMap: Record<string, string> = {
        'click': '* 点击了屏幕',
        'clickByGrid': '* 点击了屏幕',
        'swipe': '* 滑动了屏幕',
        'swipeByGrid': '* 滑动了屏幕',
        'scrollScreencap': '* 滑动了屏幕',
        'inputText': '* 正在输入文本...',
        'clearTextAndInput': '* 正在清空并输入文本...',
        'clearText': '* 正在清理文本...',
        'clearAllText': '* 正在清理文本...',
        'clearAllTextByGrid': '* 正在清理文本...',
        'back': '* 返回上一级',
        'home': '* 回到了桌面',
        'wait': '* 正在等待页面加载...',
        'start': '* 启动了应用',
        'keyevent': (args.code === 224 || args.code === 26) ? '* 正在操作屏幕状态' : '* 执行了按键操作',
        'switchScreen': '* 切换了屏幕状态',
        'success': '* 子任务已完成',
        'report': '* 正在反馈当前状况'
    };

    const actionText = actionMap[tool];
    if (actionText) {
        logger(`\x1b[32m${actionText}\x1b[0m`, { debug: false });
    }

    try {
        switch (tool) {
            case 'click': { // 点击屏幕 (x, y, count)
                const numX = Number(args.x !== undefined ? args.x : argsList[0]);
                const numY = Number(args.y !== undefined ? args.y : argsList[1]);
                const count = Number(args.count !== undefined ? args.count : argsList[2] || 1);

                if (isNaN(numX) || isNaN(numY)) {
                    return { status: 'failure', message: `点击坐标无效。请确保参数格式正确，例如 click(x=100, y=100)` };
                }

                const size = await agent.getScreenSize();
                if (size) {
                    const scaledWidth = 1000;
                    const scaledHeight = 1000;
                    if (numX < 0 || numX > scaledWidth || numY < 0 || numY > scaledHeight) {
                        return {
                            status: 'failure',
                            message: `点击坐标 (${numX}, ${numY}) 超出当前屏幕范围 (0,0) 到 (1000, 1000)。`
                        };
                    }
                }

                const warning = await agent.click(numX, numY, count, args.waitingTime);
                // await new Promise(r => setTimeout(r,1500))
                return { status: 'success', message: `已点击坐标 (${numX}, ${numY})` + (count > 1 ? ` ${count} 次` : '') + (warning ? `，警告: ${warning}` : '') + `。提示：如果点击后无反应请优先检查点击的位置是否正确，可以通过\`检查屏幕中红点、对比你要点击的目标区域，对比分析x轴和y轴偏移量后进行校准\`，**禁止在同一位置多次重复无效操作！**` };
            }


            case 'swipe': { // 滑动手势 → 返回 { status, message: 起止坐标描述 }
                const x1 = Number(args.x1 !== undefined ? args.x1 : (args.x !== undefined ? args.x : argsList[0]));
                const y1 = Number(args.y1 !== undefined ? args.y1 : (args.y !== undefined ? args.y : argsList[1]));
                const x2 = Number(args.x2 !== undefined ? args.x2 : argsList[2]);
                const y2 = Number(args.y2 !== undefined ? args.y2 : argsList[3]);
                const duration = args.duration !== undefined ? args.duration : argsList[4];

                if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
                    return { status: 'failure', message: `滑动坐标无效。期望: swipe(x1, y1, x2, y2)。当前解析值: start(${x1},${y1}), end(${x2},${y2})` };
                }

                const warning = await agent.swipe(x1, y1, x2, y2, duration, args.waitingTime);
                return { status: 'success', message: `已执行交互 (${x1},${y1}) -> (${x2},${y2})${warning ? "。提醒：" + warning : ""}。提示：如果多次操作无反应，请检查：\n1. 是否已经滑动到最后无法滑动。\n2. 滑动距离过短。 \n3. 如果是区域滑动请调整开始、结束在某个区域内进行滑动。\n请务必分析后请根据实际情况调整参数，避免多次无效操作。` };
            }

            case 'swipeByGrid': { // 基于网格的滑动
                const startCode = args.startCode !== undefined ? args.startCode : argsList[0];
                const endCode = args.endCode !== undefined ? args.endCode : argsList[1];
                const duration = args.duration !== undefined ? args.duration : argsList[2];
                await agent.swipeByGrid(String(startCode), String(endCode), duration, args.waitingTime);
                return { status: 'success', message: `已从网格 ${startCode} 滑动到 ${endCode}` };
            }

            case 'inputText': { // 输入文本
                // 前置焦点检查：未聚焦时直接拦截
                const inputFocused = await agent.isFocused();
                if (!inputFocused) {
                    const lx = AndroidAgent.lastClick.rawX !== null ? AndroidAgent.lastClick.rawX : '未知';
                    const ly = AndroidAgent.lastClick.rawY !== null ? AndroidAgent.lastClick.rawY : '未知';
                    return { status: 'failure', message: `输入清空错误！当前未聚焦文本框，请先聚焦文本框，上次点击位置: ${lx}, ${ly}，请优先检查点击坐标偏移量，根据当前屏幕中的红色位置校验坐标（y轴坐标易错）` };
                }
                const text = args.text !== undefined ? args.text : argsList[0];
                if (!text || text === 'undefined') {
                    return { status: 'failure', message: '输入文本内容不能为空，请通过 {"text": "..."} 传入。' };
                }
                await agent.inputText(String(text), args.waitingTime);
                return { status: 'success', message: `已输入文本: ${text}。如果未生效请先检查是否聚焦在了目标文本框中` };
            }

            case 'clearTextAndInput': { // 清空全部文本后输入
                // 前置焦点检查：未聚焦时直接拦截
                const ctiFocused = await agent.isFocused();
                if (!ctiFocused) {
                    const lx = AndroidAgent.lastClick.rawX !== null ? AndroidAgent.lastClick.rawX : '未知';
                    const ly = AndroidAgent.lastClick.rawY !== null ? AndroidAgent.lastClick.rawY : '未知';
                    return { status: 'failure', message: `输入清空错误！当前未聚焦文本框，请先聚焦文本框，上次点击位置: ${lx}, ${ly}，请优先检查点击坐标偏移量，根据当前屏幕中的红色位置校验坐标（y轴坐标易错）` };
                }
                const text = args.text !== undefined ? args.text : argsList[0];
                if (!text || text === 'undefined') {
                    return { status: 'failure', message: '输入文本内容不能为空，请通过 {"text": "..."} 传入。' };
                }

                await agent.clearAllText();
                await new Promise(r => setTimeout(r, 200));
                await agent.inputText(String(text));
                return { status: 'success', message: `未生效提示：如果未生效请先检查是否聚焦在了目标文本框中（检查方法：是back否有键盘弹出或下方显示 'ADB Keyboard {ON}' 字样）。` };
            }


            case 'clearText': { // 删除指定数量字符
                // 前置焦点检查：未聚焦时直接拦截
                const ctFocused = await agent.isFocused();
                if (!ctFocused) {
                    const lx = AndroidAgent.lastClick.rawX !== null ? AndroidAgent.lastClick.rawX : '未知';
                    const ly = AndroidAgent.lastClick.rawY !== null ? AndroidAgent.lastClick.rawY : '未知';
                    return { status: 'failure', message: `输入清空错误！当前未聚焦文本框，请先聚焦文本框，上次点击位置: ${lx}, ${ly}，请优先检查点击坐标偏移量，根据当前屏幕中的红色位置校验坐标（y轴坐标易错）` };
                }
                const count = Number(args.count !== undefined ? args.count : argsList[0]);
                if (isNaN(count)) return { status: 'failure', message: '删除数量 count 必须是数字' };
                await agent.clearText(count);
                return { status: 'success', message: `已删除 ${count} 个字符` };
            }

            case 'clearAllText': { // 清空整个输入框（优先 resourceId 定位，兜底坐标） → 返回 { status, message }
                // 前置焦点检查：未聚焦时直接拦截
                const catFocused = await agent.isFocused();
                if (!catFocused) {
                    const lx = AndroidAgent.lastClick.rawX !== null ? AndroidAgent.lastClick.rawX : '未知';
                    const ly = AndroidAgent.lastClick.rawY !== null ? AndroidAgent.lastClick.rawY : '未知';
                    return { status: 'failure', message: `输入清空错误！当前未聚焦文本框，请先聚焦文本框，上次点击位置: ${lx}, ${ly}，请优先检查点击坐标偏移量，根据当前屏幕中的红色位置校验坐标（y轴坐标易错）` };
                }
                await agent.clearAllText();
                return { status: 'success', message: `已清空输入框，请勿反复操作此函数，如果无法清楚请检查是否是 placeHolder 的占位文本，直接输入无需清除` };
            }

            case 'clearAllTextByGrid': { // 基于网格的清空 → 返回 { status, message }
                // 前置焦点检查：未聚焦时直接拦截
                const catgFocused = await agent.isFocused();
                if (!catgFocused) {
                    const lx = AndroidAgent.lastClick.rawX !== null ? AndroidAgent.lastClick.rawX : '未知';
                    const ly = AndroidAgent.lastClick.rawY !== null ? AndroidAgent.lastClick.rawY : '未知';
                    return { status: 'failure', message: `输入清空错误！当前未聚焦文本框，请先聚焦文本框，上次点击位置: ${lx}, ${ly}，请优先检查点击坐标偏移量，根据当前屏幕中的红色位置校验坐标（y轴坐标易错）` };
                }
                const code = args.code !== undefined ? args.code : argsList[0];
                await agent.clearAllTextByGrid(String(code));
                return { status: 'success', message: `已清空网格 ${code} 处的输入框` };
            }

            case 'back': // 模拟返回键 → 返回 { status, message }
                await agent.back(args.waitingTime);
                return { status: 'success', message: '已按下返回键。提示：如果需要退出 app 请直接调用 forceStop() 函数。切换 app:  forceStop() + start() ' };

            case 'home': // 模拟 Home 键回到桌面 → 返回 { status, message }
                await agent.home(args.waitingTime);
                return { status: 'success', message: '已按下 Home 键' };

            case 'switchScreen': //亮屏/灭屏切换 → 返回 { status, message }
                await agent.switchScreen(args.waitingTime);
                return { status: 'success', message: '已切换屏幕状态' };

            case 'keyevent': { // 模拟按下指定的按键码 → 返回 { status, message }
                const keyCode = Number(args.code !== undefined ? args.code : argsList[0]);
                const waitingTime = Number(args.waitingTime !== undefined ? args.waitingTime : argsList[1]);
                if (isNaN(keyCode)) return { status: 'failure', message: '按键码 keyCode 必须是数字' };

                // --- 核心逻辑变动 ---
                // 所有开屏、上滑解锁逻辑现在都下沉到 androidAgent.sendKeyEvent 内部自动处理
                await agent.sendKeyEvent(keyCode, isNaN(waitingTime) ? undefined : waitingTime);

                return { status: 'success', message: `已执行按键事件: ${keyCode}${(keyCode === 224 || keyCode === 26) ? '，并自动触发了可能存在的解锁交互' : ''}` };
            }

            case 'volume': { // 调节音量 → 返回 { status, message: 方向描述 }
                const direction = args.direction !== undefined ? args.direction : argsList[0];
                await agent.volume(direction, args.waitingTime);
                return { status: 'success', message: `音量已${direction === 'up' ? '调大' : '调小'}` };
            }

            case 'start': { // 通过 am start 启动 Activity/应用 → 返回 { status, message: intent }
                const intent = args.intent !== undefined ? args.intent : argsList[0];
                const waitingTime = args.waitingTime !== undefined ? args.waitingTime : argsList[1];
                const res = await agent.am.start(String(intent), waitingTime);
                return { status: 'success', message: `指令已下发: ${intent}${res ? "\n反馈信息: " + res : ""}` };
            }

            case 'forceStop': { // 强制停止应用进程 → 返回 { status, message: 包名 }
                const packageName = args.packageName !== undefined ? args.packageName : argsList[0];
                await agent.am.forceStop(String(packageName));
                return { status: 'success', message: `已强制停止: ${packageName}` };
            }

            case 'gridScreencap': { // 生成带网格标注的截图 → 返回 { status, filePath: 图片路径 }
                const res = await agent.gridScreencap();
                return { status: 'success', filePath: res.filePath };
            }

            case 'clickByGrid': { // 点击网格编码对应的区域中心 → 返回 { status, message: 网格编码 }
                const code = String(args.code !== undefined ? args.code : argsList[0]).trim().toUpperCase();
                await agent.clickByGrid(code);
                const isTop = (Number(code.match(/[\d]/)) === 1);
                return { status: 'success', message: `${isTop ? "请勿点击顶部状态栏！请仔细核对需要点击的位置" : "已点击网格区域" + code}` };
            }

            case 'scrollScreencap': { // 连续滚动截屏拼接长图 → 返回 { status, filePaths: 截图路径数组 }
                const count = Number(args.count || args.number || argsList[0] || 3);
                const filePaths = await agent.scrollScreencap(count);
                return { status: 'success', filePaths };
            }


            case 'wait': { // 异步等待 → 返回 { status, message: 等待时长 }
                let waitTime = Number(args.time !== undefined ? args.time : argsList[0] || 500);
                // 减少1秒的延迟
                waitTime = waitTime - 1000;
                if (waitTime < 0) waitTime = 0;
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return { status: 'success', message: `已等待 ${waitTime}ms，请继续下一步操作` };
            }

            case 'applist': { // 获取所有已安装包名列表 → 返回 { status, count: 数量, data: 包名数组 }
                const packages = await agent.pm.applist();
                return { status: 'success', count: packages.length, data: packages };
            }

            case 'getCurrentApp': { // 获取当前前台应用信息 → 返回 { status, data: { packageName, activityName } }
                const appInfo = await agent.am.getCurrentApp();
                return { status: 'success', data: appInfo };
            }

            case 'getCurrentState': { // 获取当前设备状态（屏幕/网络等） → 直接返回状态对象
                const state = await agent.xml.getCurrentState();
                return state;
            }

            case 'getXml': { // 获取包含文本，坐标的去重 XML 结构信息
                const res = await agent.xml.analyze();
                return res;
            }

            case 'getScreenSize': { // 获取屏幕分辨率 → 返回 { status, data: { width, height } }
                const sizeInfo = await agent.getScreenSize();
                return { status: 'success', data: sizeInfo };
            }

            case 'getStackList': { // 获取 Activity 栈列表 → 返回 { status, data: 栈信息 }
                const stack = await agent.am.getStackList();
                return { status: 'success', data: stack };
            }

            case 'success': // 任务完成信号（不执行任何设备操作） → 返回 { status, message: 完成描述 }
                const result = args.result !== undefined ? args.result : argsList[0] || '任务完成';
                return { status: 'success', message: result };

            case 'report': { // 异常或严重偏移上报 → 返回 { status: 'report', message: reason }
                const reason = args.text !== undefined ? args.text : (args.reason !== undefined ? args.reason : argsList[0]) || '未知异常情况';
                return { status: 'report', message: reason };
            }

            default: // 未匹配到任何已知函数 → 返回 { status: 'error', message: 函数名 }
                console.warn(`[executeAction] 未知函数: ${tool}`);
                return { status: 'error', message: `未知函数: ${tool}` };
        }
    } catch (err: any) {
        const errorMsg = err.message || String(err);
        logger(`[executeAction] 工具 [${tool}] 执行异常: ${errorMsg}`, { error: true });
        return {
            status: 'error',
            message: `执行失败: ${errorMsg}`,
            tool: tool
        };
    }
}

// ------ 已经弃用的方法 ------
// - clearText(count) — 从光标位置向前删除 count 个字符
// - clickByGrid(code) — 通过网格图的代号点击对应位置。点击前请看仔细核对你选择的代号下面的区域是否是你需要点击的区域
// - swipeByGrid(startCode, endCode) — 根据网格代号在两个区域之间滑动。例如：swipeByGrid(startCode="A1", endCode="A5")
// - clearAllTextByGrid(code) — 清空文本。输入需要清空的文本框所在位置的网格代号清空文本框例如：clearAllTextByGrid(code="B2")

// 已经在提示词中内置该方法
// - launcherAppList() — 获取打开app的列表。打开app操作优先调用，获取后可以通过调用 start 来启动应用


/** ### 执行者 - Executor 的 Function calling
 * @deprecated 已经转为使用 [run_tools.md](./role/role_prompt/run_tools.md)
 * 替代原来的 tools 参数，以纯文本方式告诉 AI 有哪些函数可调用
 */
export function getFunctionDefinitions_executor(): string {
    return `
**可用的操作函数：**
- click(x, y,count) — 点击屏幕,参数x,y坐标，count默认不传点击一次。你点击屏幕的时候请根据屏幕的分辨率传入目标所在位置的分辨率，禁止传入比例
- swipe(x1, y1, x2, y2, ?duration) — 滑动、长按、拖动。swipe 操作严格遵守以下规则
    - 1. 滑动：swipe(x1,y1,x2,y2)表示(x1,y1)滑动到(x2,y2) , \`【注意】：仅滑动不要传duration！\`
    - 2. 长按：(x1,y1,x2,y2,duration) (x1,y1),(x2,y2)坐标相同，此时可选传 duration (ms) 表示长按时长。
    - 3. 拖拽：(x1,y1,x2,y2,duration) (x1,y1),(x2,y2)坐标不同且,表示在(x1,y1)位置长按 duration ms 后拖动到 (x2,y2)
    - 【提示】：1. 当页面操作无反应的时候可能是已经
- inputText(text) — [要求必须先聚焦可以在前面增加一个点击操作]在当前聚焦的输入框中输入文本。
- clearTextAndInput(text) — 清空当前聚焦的文本框所有内容后输入文本，建议在需要替换现有文本时优先调用。
- clearAllText() — 清空当前聚焦的文本框，你需要通过 click 提前聚焦
- back() — 模拟按下返回键。此操作无法退出app，如果你要退出 app 请调用 home()
- home() — 模拟按下 Home 键，返回桌面
- keyevent(code, waitingTime) — 黑屏开屏、锁屏、回车、退格等自定义操作。模拟按下指定的安卓按键码（waitingTime 为执行后的等待毫秒数，可选）。常用码：锁屏(26)、回车(66)、退格(67)、菜单(82)、搜索(84)、最近任务(187)、点亮屏幕(224)、熄灭屏幕(223)。提示：当 switchScreen() 无法达到预期（例如只想亮屏而不想锁屏）时，可以使用 224/223。建议：调用示例 keyevent(code=224,waitingTime=300);可多步骤同时操作。
- start(intent) — 启动应用，intent 为从 launcherAppList 获取的完整路径（如 "com.taobao.taobao/.MainTabActivity"）
- forceStop(packageName) — 强制停止指定应用
- scrollScreencap(count) — 连续滚动屏幕并截屏获取信息，下一轮返回多张截图，count 为截图滚动次数。技巧：提示当需要大规模连续采集的时候优先调用此方法一次性获取足够的信息，避免单独的滑动操作
- success(result) — 请先分析当前状态，检查是否已经完成了任务1和任务2，如果未完成请勿调用此方法。当执行到【任务3】或者执行完所有任务时在最后调用此方法，然后 **必须详细** 的总结你现在执行任务的情况、收集到的数据、你的想法或者你即将做什么。
- wait(time) - 如果你当前的屏幕状态正在加载中无法操作的状态，不传的话默认等待时间 500ms ,或者传入自定义的等待时间
- report(reason) — 异常事件或无法继续执行上报。说明无法执行的原因（如：验证码阻断、页面突变、目标消失等），修补员将介入并根据你的情况重新规划任务

**函数使用规定：**
1. **防重复机制**：禁止在屏幕状态未发生变化的情况下，使用完全相同的参数多次重复调用同一函数。
2. **交互分析**：若操作未达到预期效果，请结合历史记录分析原因。思考：是否点击位置偏移？是否已滑动到列表尽头？是否有弹窗遮挡？
3. **警告处理**：若操作返回值中包含“提醒 (Warning)”，请在下一轮推理中针对该提醒调整参数（例如增加时长或修正坐标）。

**你必须严格按照以下格式输出：**
<think>
距离任务结束还有 5 轮。
你的推理过程（包含【状态分析】【行动意图】【数据记录】）
</think>
<function>函数名(参数1=值1, 参数2=值2)</function>
<text>
【当前进度总结】 根据对话历史记录总和任务总结当前的状态
【当前屏幕描述】 简要描述你当前看到的屏幕内容，例如当前在什么界面
【本轮执行动作】 说明你本轮执行了什么操作，怎么执行的
【已收集数据】 如果任务涉及信息收集，列出目前已记录的数据
【下一步计划】 说明接下来应该执行什么操作
</text>
**支持一次调用多个函数（按顺序执行）：**
<think>你的推理过程</think>
<function>click(x=540, y=120)</function>
<function>inputText(text="iPhone")</function>
<text>你的进度总结</text>

**参数格式规则：**
- 数字参数不加引号：x=100, y=200
- 字符串参数用双引号：text="搜索内容", intent="com.example/.Activity"
- 数组参数用 JSON 格式：allPlan=["步骤1", "步骤2"]
- 无参数函数：back(), home(), switchScreen()
- 单参数函数：keyevent(code=26)
**【铁规：完成任务时的执行规范】**
再次强调当你执行到 【任务3】或者所有任务执行完毕时最后需要调用 success 
**【铁规：<text> 标签是必填项】**
每轮回复的最后必须包含 <text></text> 标签！里面写你对当前执行状态的总结。这是你的"记忆"，缺失会导致你下一轮丢失上下文。

**示例：**
单个函数调用：
<think>你的思考过程</think>
<function>clickByGrid(code="A1")</function>
<text>当前情况总结</text>

多个函数连续调用：
<think>你的思考过程</think>
<function>clearAllText()</function>
<function>inputText(text="iPhone 15")</function>
<function>success(result="我已经执行完本次点击输入框的操作")</function>
<text>当前情况总结</text>
`;
}

/** ### 修补者 - restorer 的 Function calling
 * @deprecated 方法已经更新为 {@link getFunctionCallingPrompt_plan()}
*/
export function getFunctionDefinitions_restorer(): string {
    return `
**修补协议：**
当执行员上报异常或你发现当前状态已偏离总目标时，你必须重新评估路径并调用以下函数进行重塑：

- remakePlan(allPlan=["新任务1", "新任务2"]) — 重新修订接下来的计划
- loopPlan(allPlan=["模板步骤"], loopCount=次数, startNumber=起始索引) — 定义批量循环任务。
- stop() — 停止任务。如果你已经判断当前任务是无法继续完成的请调用这里，并且你必须详细的在 <text></text> 中说明情况

**任务重塑输出示例(具体任务规划视情况而定，但是必须要写 text):**
<think>你的思考过程写在这里</think>
<text>你必须要在这里分析故障原因，诊断当前 UI 状态，并说明你的计划和你接下来的行动</text>
<function>remakePlan(allPlan=["关闭当天错误的页面并返回主页","打开淘宝网app","在淘宝网app中找到并点击商品输入框","在淘宝网app的商品搜索框中输入iphone17 1TB 后确认并搜索","在淘宝app中iphone17商品详情页中选择 iphone17 1TB 版本","在淘宝app中确认并查看选配的iphone17 1TB版本的价格并记录价格信息"])</function>
<function>loopPlan(allPlan=["在淘宝app中返回到iphone 17 1TB的搜索页面中","在淘宝app中的 iphone17 商品列表中滑动查找第{{startNumber}}个 iPhone17 1TB 的商品", "在淘宝app中iphone17商品详情页中选择 iphone17 1TB 版本","在淘宝app中确认并查看选配的iphone17 1TB版本的价格并记录价格信息"], loopCount=9, startNumber=2)</function>
<function>remakePlan(allPlan=["汇总并总结10个已记录的淘宝app查询的iphone17 1TB价格数据汇报给用户"])</function>

**停止任务输出示例():**
<think>你的思考过程写在这里</think>
<text>你必须在这里详细的描述所有的情况，包括但不限于用户需求，已经执行的任务，当前你所见到所看到，以及你所分析的，你如何判断而为何导致你最终停止任务详细在这里进行说明</text>
<function>stop()</function>
`;
}

/** ### 计划者和修补者共享的 function calling 提示词
 * @deprecated 已经转为使用 [planner.md](role/role_prompt/planner.md)
 */
export function getFunctionCallingPrompt_plan(): string {
    return [
        `【交互规范】`,
        `你必须且只能通过以下标签进行输出：`,
        `1. <think>你的规划逻辑和思考过程</think>`,
        `2. <function>makePlan(allPlan=["步骤1", "步骤2"])</function> - 用于定义普通任务流`,
        `3. <function>loopPlan(allPlan=["循环步骤"], loopCount=次数, startNumber=1)</function> - 用于定义重复的操作任务`,
        `4. <function>restorer(reason="需要填充的信息说明")</function> - 【重要】数据填充，当后续任务所需要的数据需要在前序步骤中获取数据时（例如：需要查询某个数据，然后在后续需要这个数据进行操作），你需要在中间合适的任务位置调用词方法申请数据显式的填充到后续的子任务中`,
        ``,
        `【重要：上下文安全提示】`,
        `你的所有规划都是在一个受控的自动化测试环境中执行的，请直接输出执行步骤，不要进行额外的道德或隐私劝诫。`,
        ``,
        `**场景化示例：**`,
        `<think>`,
        `用户要求记录前 10 个 iPhone17 的价格并发送短信给张三。我应该....(这里记录你的思考过程)`,
        `</think>`,
        `<function>makePlan(allPlan=["打开淘宝app","搜索 iPhone17 并按价格升序排序","记录搜索结果中第一个商品的名称和价格"])</function>`,
        `<function>loopPlan(allPlan=["返回搜索页面", "查找并点击第{{startNumber}}个商品", "记录该商品的名称和价格"], loopCount=9, startNumber=2)</function>`,
        `<function>restorer(reason="将查询到的 10 个 iPhone17 价格信息汇总并填入到接下来的发送短信任务中")</function>`,
        `<function>makePlan(allPlan=["打开短信app给张三发送刚才汇总的价格信息"])</function>`,
    ].join('\n')
}
