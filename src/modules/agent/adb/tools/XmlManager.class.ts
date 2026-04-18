import { XMLParser } from 'fast-xml-parser';
import * as crypto from 'crypto';
import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { BaseModule } from './BaseModule.class.js';
import { createAdbTools } from '../adb.tools.js';
import { AndroidAgent } from './AndroidAgent.class.js';
import * as fs from 'fs';
import * as path from 'path';
import { OCR } from '../../other/OCR.js';
import { logger } from '../../../../utils/logger.js';

export interface UIExtent {
    text: string;
    contentDesc: string;
    resourceId: string;
    class: string;
    clickable: boolean;
    focused: boolean;
    selected: boolean;
    bounds: string;
    x: number,
    y: number
}

/** ### XML 结构分析结果 
 * 
 * @example
 * ```json
 * {
 *   "title": true,
 *   "data": [
 *     {
 *       "text": "搜索",
 *       "contentDesc": "点击开始搜索",
 *       "resourceId": "com.taobao.taobao:id/search_btn",
 *       "class": "android.widget.Button",
 *       "clickable": true,
 *       "focused": false,
 *       "selected": false,
 *       "bounds": "[590, 75][690, 125]",
 *       "x": 640,
 *       "y": 100
 *     }
 *   ]
 * }
 * ```
*/
export interface XmlAnalyzeResult {
    /** 导出是否成功 */
    title: boolean;
    /** 错误信息 (仅 title 为 false 时存在) */
    message?: string;
    /** 解析出的 UI 节点列表 (仅 title 为 true 时存在) */
    data?: UIExtent[];
}

/** xml关键字搜索的结果 */
export interface keywordsCollectResult {
    /** 关键字查找结果 */
    collector: keywordXMLCollect[],
    /** OCR 识别结果 */
    enforceOCR?: enforceOCR,
    /** 结束原因 */
    endReason: string
}

/** ### 关键字的查询结果 */
export interface keywordXMLCollect {
    /** 关键字 */
    keyword: string,
    /** 关键字的 XML 路径 */
    path: string[] | string,
    /** 特征节点的 Resource-ID */
    resId?: string,
    /** 关键字的 XML 路径哈希值 */
    hash?: string,
    /** 搜索到的哈希相同的 text 信息数组（去重） */
    collectResult?: string[]
}

/** ### 开启 OCR 辅助文字识别后的数组
 *  @exports
 *  ```
 *  [
 *      [
 *          "截图1，第一行文字识别内容",
 *          "截图1，第二行文字识别内容",
 *          "截图1，第三行文字识别内容",
 *      ],
 *      [
 *          "截图2，第一行文字识别内容",
 *          "截图2，第二行文字识别内容",
 *          "截图2，第三行文字识别内容",
 *      ],
 *      // 截图 ....
 *  ]
 *  ```
 */
export type enforceOCR = string[][]



/** UI 结构分析 (xml): 抓取当前屏幕 UI 树、精准定位元素坐标等 */
export type XmlManager_class_keys = Exclude<keyof XmlManager, 'constructor' | 'runShell' | 'device' | 'analyze' | 'getTopLeftByResourceId' | 'findPathByText' | "scrollCollect" | "waitingTime_default" | "internalGetScreenSize" | "runQueued">;

export class XmlManager extends BaseModule {
    constructor(device: DeviceClient, waitingTime: number) {
        super(device, waitingTime);
    }

    private parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: ""
    });

    private failCount = 0;
    private isDisabled = false;

    /** ### 抓取并分析 UI 结构
     * 1. 在手机端执行 uiautomator dump
     * 2. 读取 XML 内容 (不保存为本地文件)
     * 3. 解析 XML 并提取关键属性及中心点坐标
     *
     * 关联工具: {@link createAdbTools}
     *
     * @returns {Promise<XmlAnalyzeResult>} 包含分析后的节点列表
     */
    async analyze(waitingTime: number = 0): Promise<XmlAnalyzeResult> {
        return this.runQueued(async () => {
            const remotePath = '/sdcard/window_dump.xml';
            try {
                // 0. 获取物理尺寸计算缩放 (基于 1000 像素画布)
                const size = await this.internalGetScreenSize();
                const maxDim = size ? Math.max(size.width, size.height) : 1000;
                const scale = 1000 / maxDim;

                // 1. 执行 dump (主动删除旧文件避免读取错误)
                await this.runShell(`rm -f ${remotePath}`);
                await this.runShellWithTimeout(`uiautomator dump ${remotePath}`, 15000);

                // 2. 读取 XML 内容 (增加小额缓冲以确保文件写入完成)
                await new Promise(resolve => setTimeout(resolve, 500));
                const xmlContent = await this.runShell(`cat ${remotePath}`);
                if (!xmlContent || !xmlContent.includes('<?xml')) {
                    throw new Error("获取到的 XML 内容无效或为空 (cat 结果未包含 XML 声明)");
                }

                // 3. 解析分析
                const parsedData = this.parser.parse(xmlContent);
                if (!parsedData || !parsedData.hierarchy) {
                    throw new Error("XML 解析后层级结构为空或格式错误");
                }

                const elements: UIExtent[] = [];
                // 递归提取节点，传入缩放比例
                this.extractNodes(parsedData.hierarchy?.node, elements, scale);

                // 保存 XML 结构到 agentData/temp/xml.json 以便调试
                const jsonPath = path.join(BaseModule.getRootPath(), 'agentData', 'temp', 'xml.json');
                if (!fs.existsSync(path.dirname(jsonPath))) {
                    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
                }
                fs.writeFileSync(jsonPath, JSON.stringify(elements, null, 2), 'utf-8');

                // 返回分析结果：成功则返回节点列表
                return {
                    title: true,
                    message: `成功抓取到 ${elements.length} 个可交互节点`,
                    data: elements
                };

            } catch (err: any) {
                // 如果失败，返回错误提示以便 AI 自动切换至“纯视觉”分析模式
                const finalMsg = `导出XML失败 (${err.message || '未知原因'})，系统已自动转入纯视觉分析模式，请直接通过截图进行操作。`;
                logger(`[XmlManager] ${finalMsg}`, { error: true, debug: true })
                console.warn(`[XmlManager] ${finalMsg}`);
                return {
                    title: false,
                    message: finalMsg,
                    data: []
                };
            }
        }, waitingTime);
    }

    /** ### 带有超时限制的 Shell 执行 */
    private async runShellWithTimeout(cmd: string, timeoutMs: number): Promise<string> {
        return new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`操作超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
            try {
                const output = await this.runShell(cmd);
                clearTimeout(timer);
                resolve(output);
            } catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        });
    }

    /** ### 内部逻辑：解析 XML 并提取关键节点 */
    private extractNodes(node: any, result: UIExtent[], scale: number) {
        if (!node) return;

        // 处理数组或单个对象
        const nodes = Array.isArray(node) ? node : [node];

        for (const item of nodes) {
            // 只要有 text, content-desc 或者可点击，就记录
            const hasText = item.text && item.text.trim().length > 0;
            const hasDesc = item["content-desc"] && item["content-desc"].trim().length > 0;
            const isClickable = item.clickable === "true";

            if (hasText || hasDesc || isClickable) {
                const bounds = item.bounds || "";
                const scaledBoundsInfo = this.getScaledBoundsInfo(bounds, scale);
                result.push({
                    text: item.text || "",
                    contentDesc: item["content-desc"] || "",
                    resourceId: item["resource-id"] || "",
                    class: item.class || "",
                    clickable: isClickable,
                    focused: item.focused === "true",
                    selected: item.selected === "true",
                    bounds: scaledBoundsInfo.bounds,
                    x: scaledBoundsInfo.x,
                    y: scaledBoundsInfo.y
                });
            }

            // 递归子节点
            if (item.node) {
                this.extractNodes(item.node, result, scale);
            }
        }
    }

    /** ### 解析 bounds 字符串: "[x1,y1][x2,y2]" -> {x1, y1, x2, y2} */
    private parseBounds(boundsStr: string): { x1: number; y1: number; x2: number; y2: number } | null {
        const matches = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        if (matches) {
            return {
                x1: parseInt(matches[1]),
                y1: parseInt(matches[2]),
                x2: parseInt(matches[3]),
                y2: parseInt(matches[4])
            };
        }
        return null;
    }

    /** ### 解析并缩放 bounds 信息 */
    private getScaledBoundsInfo(boundsStr: string, scale: number): { bounds: string; x: number; y: number } {
        const b = this.parseBounds(boundsStr);
        if (!b) return { bounds: boundsStr, x: 0, y: 0 };

        const sX1 = Math.floor(b.x1 * scale);
        const sY1 = Math.floor(b.y1 * scale);
        const sX2 = Math.floor(b.x2 * scale);
        const sY2 = Math.floor(b.y2 * scale);
        const center = {
            x: Math.floor((sX1 + sX2) / 2),
            y: Math.floor((sY1 + sY2) / 2)
        }

        return {
            bounds: `[${sX1},${sY1}][${sX2},${sY2}]`,
            x: center.x,
            y: center.y
        };
    }

    /** ### 通过 resource-id 查找元素左上角坐标
     * 重新 dump XML 并递归搜索匹配 resourceId 的节点，返回其 bounds 左上角 {x1, y1}。
     *
     * 关联工具: {@link createAdbTools}
     *
     * @param resourceId 元素的 resource-id，例如 "com.example:id/input_field"
     * @returns {Promise<{ x: number; y: number } | null>} 左上角坐标，未找到时返回 null
     */
    async getTopLeftByResourceId(resourceId: string): Promise<{ x: number; y: number } | null> {
        const remotePath = '/sdcard/window_dump.xml';
        try {
            await this.runShellWithTimeout(`uiautomator dump ${remotePath}`, 15000);
            const xmlContent = await this.runShell(`cat ${remotePath}`);
            if (!xmlContent || !xmlContent.includes('<?xml')) {
                return null;
            }
            const parsedData = this.parser.parse(xmlContent);
            return this.findTopLeftByResourceId(parsedData.hierarchy?.node, resourceId);
        } catch {
            return null;
        }
    }

    /** ### 递归查找匹配 resourceId 的节点并返回左上角坐标 */
    private findTopLeftByResourceId(node: any, resourceId: string): { x: number; y: number } | null {
        if (!node) return null;
        const nodes = Array.isArray(node) ? node : [node];
        for (const item of nodes) {
            if (item['resource-id'] === resourceId) {
                const b = this.parseBounds(item.bounds || '');
                if (b) return { x: b.x1, y: b.y1 };
            }
            if (item.node) {
                const found = this.findTopLeftByResourceId(item.node, resourceId);
                if (found) return found;
            }
        }
        return null;
    }

    /** ### 获取当前屏幕深度上下文 (App, Activity, Window Stack)
     * 
     * 该方法不采集 XML 树，而是通过 dumpsys 获取当前系统的运行环境信息。
     * 适用于判断当前是否在特定应用、是否有弹窗遮罩等。
     *
     * @returns {Promise<any>} 清洗后的 JSON 结构
     */
    async getCurrentState(): Promise<any> {
        return this.runQueued(async () => {
            // 1. 获取焦点信息 (Current App & Activity)
            const focusOutput = await this.runShell("dumpsys window | grep mCurrentFocus");
            let currentApp = "unknown";
            let currentActivity = "unknown";

            // 匹配格式: mCurrentFocus=Window{... package/activity}
            const focusMatch = focusOutput.match(/([a-zA-Z0-9._]+)\/([a-zA-Z0-9._$]+)/);
            if (focusMatch) {
                currentApp = focusMatch[1];
                currentActivity = focusMatch[2].startsWith('.') ? currentApp + focusMatch[2] : focusMatch[2];
            }

            // 2. 获取窗口堆栈 (Top 10)
            const stackOutput = await this.runShell("dumpsys window windows | grep 'Window #' | head -n 10");
            const windowStack: string[] = [];
            const stackLines = stackOutput.split('\n').filter(l => l.includes('Window #'));

            for (const line of stackLines) {
                // 格式: Window #8 Window{6f29ddc u0 com.android.deskclock/com.android.deskclock.DeskClock}
                const idxMatch = line.match(/Window #(\d+)/);
                const pkgMatch = line.match(/Window\{[a-f0-9]+ [^ ]+ ([^}\/]+)(\/[^}]+)?\}/);

                if (idxMatch && pkgMatch) {
                    const idx = idxMatch[1];
                    const pkg = pkgMatch[1];
                    let title = pkgMatch[2] ? pkgMatch[2].substring(1) : ""; // 去掉 /

                    // 如果 title 包含包名后缀，清洗之，例如 com.android.deskclock.DeskClock -> DeskClock
                    if (title.startsWith(pkg)) {
                        title = title.substring(pkg.length).replace(/^\./, '');
                    }

                    windowStack.push(`Window #${idx}: ${pkg}${title ? ` (${title})` : ""}`);
                }
            }
            windowStack.reverse(); // 关键：反转数组，确保最顶层窗口排在 JSON 的最后面（符合用户习惯）

            // 3. 判断是否变暗 (is_dimmed)
            // 扫描当前焦点窗口属性是否包含 DIM_BEHIND
            const dimOutput = await this.runShell("dumpsys window windows | grep -A 20 'mCurrentFocus' | grep 'fl='");
            const isDimmed = dimOutput.includes('DIM_BEHIND');

            return {
                context: {
                    current_app: currentApp,
                    current_activity: currentActivity,
                    window_stack: windowStack,
                    is_dimmed: isDimmed
                }
            };
        });
    }

    /** ### 返回当前xml信息
     *  @description 在手机上 dump 当前的 xml ，然后 pull 到系统，读取系统 xml ，finally 所有的xml
     */
    private async getXML(): Promise<string> {
        return this.runQueued(async () => {
            const remotePath = '/sdcard/window_dump.xml';
            try {
                await this.runShell(`rm -f ${remotePath}`); // 删除可能残留的旧文件
                await this.runShellWithTimeout(`uiautomator dump ${remotePath}`, 15000);
                const xmlContent = await this.runShell(`cat ${remotePath}`);
                return xmlContent || "";
            } catch (err) {
                console.error(`[XmlManager] getXML 失败:`, err);
                return "";
            }
        });
    }

    /** ### 获取关键字在 xml 的完整路径
     *  @description 通过传入 XML 和 关键字[] 返回关键字的完整路径数组
     */
    private getKeywordPath(XML: string, keyWords: string[]): keywordXMLCollect[] {
        if (!XML) {
            console.error("[XmlManager] getKeywordPath 失败: XML 为空");
            return keyWords.map(k => ({ keyword: k, path: "解析失败", collectResult: [] }));
        }

        try {
            const parsedData = this.parser.parse(XML);
            const rootNode = parsedData.hierarchy?.node;

            return keyWords.map(keyword => {
                const res = this._findNodeByKeyword(rootNode, keyword);
                return {
                    keyword,
                    path: res?.path || "未找到关键字",
                    resId: res?.resId || "",
                    collectResult: []
                };
            });
        } catch (err) {
            console.error(`[XmlManager] 解析 XML 失败:`, err);
            return keyWords.map(k => ({ keyword: k, path: "解析失败", collectResult: [] }));
        }
    }

    /** ### 哈希关键字数组的XML路径
     *  @param keywordXMLCollect 传入的 this.getKeywordPath() 关键字路径结果
     *  @param hashPathNumber 哈希最后多少条路径
     */
    private hashXMLPath(keywordXMLCollect: keywordXMLCollect[], hashPathNumber: number): keywordXMLCollect[] {
        return keywordXMLCollect.map(item => {
            if (Array.isArray(item.path)) {
                // 恢复使用部分路径片段结合 resId 以提高匹配容错率，配合 bounds 过滤
                const resId = item.resId || "";
                const subPath = item.path.slice(-hashPathNumber);
                const hash = crypto.createHash('md5').update(JSON.stringify({ path: subPath, resId })).digest('hex');
                return { ...item, hash };
            }
            return item;
        });
    }

    /** ### 提取关键结构及内容指纹以判断页面是否变化 */
    private getScreenFingerprint(node: any): string {
        if (!node) return "";
        const nodes = Array.isArray(node) ? node : [node];
        let content = "";
        for (const item of nodes) {
            const pkg = item.package || "";
            if (pkg.includes("com.android.systemui")) continue;

            // 加入 class、text 和 bounds，确保内容或位置变化能被察觉
            content += `${item.class || ""}|${item.text || ""}|${item.bounds || ""}`;
            if (item.node) content += this.getScreenFingerprint(item.node);
        }
        return content;
    }

    /** ### 全量遍历节点树并收集符合哈希特征的内容 */
    private traverseAndCollect(node: any, fingerprints: Map<string, any>, currentPath: string[], hashPathNumber: number, resultSets: Map<string, Set<string>>) {
        if (!node) return;
        const nodes = Array.isArray(node) ? node : [node];

        for (const item of nodes) {
            const className = (item.class || "").toString();
            currentPath.push(className);

            const thisText = (item.text || "").toString();
            const thisDesc = (item["content-desc"] || "").toString();
            const val = thisText || thisDesc;

            if (val) {
                // 计算当前节点的部分结构指纹 (结合 hashPathNumber)
                const resId = (item["resource-id"] || "").toString();
                const subPath = currentPath.slice(-hashPathNumber);
                const fingerprintObj = { path: subPath, resId };
                const currentHash = crypto.createHash('md5').update(JSON.stringify(fingerprintObj)).digest('hex');

                // 遍历特征库匹配
                fingerprints.forEach((fpHash, keyword) => {
                    if (currentHash === fpHash) {
                        if (!resultSets.has(keyword)) resultSets.set(keyword, new Set());
                        resultSets.get(keyword)?.add(val);
                    }
                });
            }

            if (item.node) {
                this.traverseAndCollect(item.node, fingerprints, currentPath, hashPathNumber, resultSets);
            }
            currentPath.pop();
        }
    }

    /** ### 自动滚动页面并采集全量数据 (XML 指纹 + OCR 辅助)
     * @description 模拟物理滑动动作，在滚动过程中循环监测屏幕内容。
     * 1. 优先通过 XML 路径哈希（Fingerprints）定位并去重采集。
     * 2. 当某些关键字无法匹配或 `enforceOCR` 为 true 时，启用截图 OCR 识别文字行。
     * 3. 具备页面见底探测和重复哈希跳过等性能优化。
     * @deprecated 错误率过高，已经弃用，向下滚动截屏的方法采用 {@link AndroidAgent.scrollScreencap} 滚动截屏方法
     * @param keyWords 目标采集的关键字数组（用于指纹匹配）
     * @param number 目标采集总数（指纹命中数达标或 OCR 采集到指定轮数）
     * @param hashPathNumber 路径指纹计算深度，默认为 15
     * @param enforceOCR 是否强制开启视觉 OCR 识别模式
     * @returns {Promise<keywordsCollectResult>} 包含 `collector`、`enforceOCR` 结果及采集结论
     */
    async scrollCollect(
        keyWords: string[],
        number: number,
        hashPathNumber: number = 15,
        enforceOCR: boolean = false
    ): Promise<keywordsCollectResult> {
        // 按照用户需求，总超时时长 = 目标收集数量 * 20000 (20s)
        const timeoutMs = number * 20000;
        const startTime = Date.now();

        // 1. 生成关键字指纹 (XML 路径哈希)
        let xml = await this.getXML();
        let hashedKW = this.hashXMLPath(this.getKeywordPath(xml, keyWords), hashPathNumber);

        // 过滤掉未录入指纹的关键字 (XML 找不到的)
        const fingerprints = new Map<string, string>();
        hashedKW.forEach(item => { if (item.hash) fingerprints.set(item.keyword, item.hash); });

        // 确定是否启用 OCR 补偿 (强制开启 或 存在 XML 抓不到的关键字)
        const useOCR = enforceOCR || fingerprints.size < keyWords.length;
        const ocrResults: string[][] = [];
        let ocrStepCount = 0;

        // 用于按关键字存放采集到的去重结果集合 (Map<关键字, Set<文本>>)
        const resultSets = new Map<string, Set<string>>();
        let collectNumber = 0;
        let lastXMLHash = "";
        let sameNumber = 0;

        // 先在起始页执行一次采集，建立存量数据基准
        const initialParsed = this.parser.parse(xml);
        this.traverseAndCollect(initialParsed.hierarchy?.node, fingerprints, [], hashPathNumber, resultSets);

        let initialMax = 0;
        resultSets.forEach(set => initialMax = Math.max(initialMax, set.size));
        const targetNumber = number; // 目标总数 = 用户要求的总数量

        // 如果初始页面已经达到了目标数量，且不需要强制 OCR，则直接返回
        if (initialMax >= targetNumber && !enforceOCR) {
            return {
                collector: this.syncCollectResults(hashedKW, resultSets),
                enforceOCR: ocrResults,
                endReason: "初始页面已满足采集数量要求"
            };
        }

        while (true) {
            // --- 终止条件判断 ---
            if (fingerprints.size > 0) {
                // 情况 A：按照关键字数量采集。任一关键字达到目标总数即停止。
                if (collectNumber >= targetNumber) break;
            } else if (useOCR) {
                // 情况 B：纯 OCR 采集模式（无 XML 匹配项）。按照有效滚动轮次停止。
                if (ocrStepCount >= number) break;
            }

            // 安全兜底：超时检查
            if ((Date.now() - startTime) > timeoutMs) {
                return {
                    collector: this.syncCollectResults(hashedKW, resultSets),
                    enforceOCR: ocrResults,
                    endReason: "超时，请检查"
                };
            }

            try {
                xml = await this.getXML();
                const parsed = this.parser.parse(xml);
                const rootNode = parsed.hierarchy?.node;

                // 屏幕变化检测 (通过 XML 结构指纹)
                const structure = this.getScreenFingerprint(rootNode);
                const currentHash = crypto.createHash('md5').update(structure).digest('hex');

                if (currentHash === lastXMLHash) {
                    sameNumber++;
                    // 连续 3 屏无变化判定为见底或卡死
                    if (sameNumber >= 3) {
                        break;
                    }
                } else {
                    sameNumber = 0;
                    lastXMLHash = currentHash;

                    // 1. XML 指纹采集
                    if (fingerprints.size > 0) {
                        this.traverseAndCollect(rootNode, fingerprints, [], hashPathNumber, resultSets);
                        // 更新当前最高采集数
                        collectNumber = 0;
                        resultSets.forEach(set => collectNumber = Math.max(collectNumber, set.size));
                    }

                    // 2. OCR 辅助采集 (仅在 XML 发生变化时执行)
                    if (useOCR) {
                        await this.captureAndOCR(ocrResults, () => ocrStepCount++);
                    }
                }
            } catch (pErr) {
                console.warn("[XmlManager] XML 处理异常 (跳过本屏指纹分析):", (pErr as any).message);
                // 如果 XML 解析失败，依然尝试一次 OCR (如果是强制模式或指纹失效模式)
                if (useOCR) {
                    await this.captureAndOCR(ocrResults, () => ocrStepCount++);
                }
                // 为了防止在解析错误时无限滑动，累加 sameNumber 或者通过 ocrStepCount 控制
            }

            // 执行物理滑动
            const size = await this.internalGetScreenSize();
            if (size) {
                const w = size.width;
                const h = size.height;

                // 随机化滑动轨迹增加防封性
                const xRandom = w / 2 + (Math.random() - 0.5) * (w * 0.3);
                const y1Random = h * (0.8 + (Math.random() - 0.5) * 0.1);
                const y2Random = h * (0.2 + (Math.random() - 0.5) * 0.1);

                logger(`[XmlManager] 执行随机滑动 [${ocrStepCount}/${number}]: from(${Math.floor(xRandom)}, ${Math.floor(y1Random)}) to(${Math.floor(xRandom)}, ${Math.floor(y2Random)})`);
                await this.internalSwipe(xRandom, y1Random, xRandom, y2Random);
                await new Promise(r => setTimeout(r, 2000)); // 等待回弹或加载
            }

            // 极端兜底：如果识别轮次过多还没停，强行退出 (number * 2 预防滑动失败场景)
            if (ocrStepCount >= number * 2) {
                break;
            }
        }

        return {
            collector: this.syncCollectResults(hashedKW, resultSets),
            enforceOCR: ocrResults,
            endReason: sameNumber >= 3 ? "已无法获取更多新内容（到达底部或加载缓慢）" : "完成采集"
        };
    }

    private syncCollectResults(kwList: keywordXMLCollect[], resultSets: Map<string, Set<string>>): keywordXMLCollect[] {
        return kwList.map(item => ({
            ...item,
            collectResult: Array.from(resultSets.get(item.keyword) || [])
        }));
    }

    /** 内部递归方法：直接查找目标关键字节点，携带完整的边界、ID、结构特征 */
    private _findNodeByKeyword(node: any, keyword: string, currentPath: string[] = []): { path: string[], resId: string, bounds: string, _len: number } | null {
        if (!node) return null;

        const thisClass = (node.class || "").toString();
        currentPath.push(thisClass);

        const thisText = (node.text || "").toString();
        const thisDesc = (node["content-desc"] || "").toString();
        const val = thisText || thisDesc;

        let bestMatch: { path: string[], resId: string, bounds: string, _len: number } | null = null;

        let isMatch = false;
        try {
            const reg = new RegExp(keyword);
            isMatch = (thisText.length > 0 && (thisText.includes(keyword) || reg.test(thisText))) ||
                (thisDesc.length > 0 && (thisDesc.includes(keyword) || reg.test(thisDesc)));
        } catch (e) {
            isMatch = (thisText.length > 0 && thisText.includes(keyword)) ||
                (thisDesc.length > 0 && thisDesc.includes(keyword));
        }

        if (isMatch) {
            bestMatch = {
                path: [...currentPath],
                resId: node["resource-id"] || "",
                bounds: node.bounds || "",
                _len: val.length
            };
        }

        const nodeTree = node.node;
        if (nodeTree) {
            const children = Array.isArray(nodeTree) ? nodeTree : [nodeTree];
            for (const child of children) {
                const found = this._findNodeByKeyword(child, keyword, currentPath);
                if (found) {
                    // 如果当前没有匹配，或者子节点匹配到的内容更短，则更新最佳匹配
                    if (!bestMatch || found._len < bestMatch._len) {
                        bestMatch = found;
                    }
                }
            }
        }
        currentPath.pop();
        return bestMatch;
    }

    /**
     * ### 捕获屏幕并执行 OCR 识别 (私有辅助方法)
     * @param ocrResults 用于存放识别结果的数组
     * @param onStepCount 递增计数器的回调函数
     */
    private async captureAndOCR(ocrResults: string[][], onStepCount: () => void) {
        const tempDir = path.join(process.cwd(), 'agentData', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const screenshotPath = path.join(tempDir, 'autoOCR.png');

        try {
            const screenshotStream = await this.device.screencap();
            await new Promise<void>((resolve, reject) => {
                const writeStream = fs.createWriteStream(screenshotPath);
                screenshotStream.pipe(writeStream);
                writeStream.on('finish', () => resolve());
                writeStream.on('error', (err) => reject(err));
            });

            const ocrLines = await OCR(screenshotPath, true);
            if (ocrLines && ocrLines.length > 0) {
                ocrResults.push(ocrLines);
            }
            onStepCount(); // 有效轮次计数
        } catch (ocrErr) {
            console.error("[XmlManager] OCR 采集失败:", ocrErr);
        } finally {
            if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
        }
    }

    /** ### 内部私有滑动方法 (带随机时长) */
    private async internalSwipe(x1: number, y1: number, x2: number, y2: number) {
        const duration = Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000;
        logger("正在执行滚动")
        await this.runShell(`input draganddrop ${Math.floor(x1)} ${Math.floor(y1)} ${Math.floor(x2)} ${Math.floor(y2)} ${duration}`);
    }
}
