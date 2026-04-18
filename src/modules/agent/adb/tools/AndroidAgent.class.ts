import adbkit, { DeviceClient } from '@devicefarmer/adbkit';
import { logger } from '../../../../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { createAdbTools } from '../adb.tools.js';
import { ActivityManager } from './ActivityManager.class.js';
import { BaseModule } from './BaseModule.class.js';
import { PackageManager } from './PackageManager.class.js';
import { XmlManager } from './XmlManager.class.js';

/** 设备基础交互 (agent): 模拟点击、按键事件、截图、分辨率获取、文本输入等 */
export type AndroidAgent_class_keys = Exclude<keyof AndroidAgent, 'constructor' | 'am' | 'pm' | 'xml' | 'device' | 'sendKeyEvent' | 'runShell' | 'getOriginalCoordinate' | "screencap" | "imageSize" | "gridConfig" | "waitingTime" | "internalGetScreenSize" | "getScreenSize" | "imageCompression" | "runQueued" | "isLocked" | "waitingTime_default" | "isFocused" | "showGridLine" | "isScreenOn" | "unlockScreen">;
export class AndroidAgent extends BaseModule {
    /** 运行管理器 (am) */
    public am: ActivityManager;
    /** 包管理器 (pm) */
    public pm: PackageManager;
    public xml: XmlManager;
    /** 上次点击坐标
     * x, y: 物理分辨率坐标 (用于绘图/执行)
     * rawX, rawY: AI 输入的 1000 比例坐标 (用于回显给 AI 调整)
     */
    public static lastClick: {
        x: number | null, y: number | null,
        rawX: number | null, rawY: number | null
    } = { x: null, y: null, rawX: null, rawY: null };
    /** 制定使用的图片尺寸
     * @description 原本使用的为图片（截图）本身大小 + zoom ,由于模型识别 1000*1000 的图片更准确所以当设置了 imageSize 的时候图片直接将尺寸设置为该尺寸，切不参与 zoom 缩放，且将所有的点击按照尺寸 1000 来进行缩放
    */
    public imageSize: number = 1000
    /** ### 统一网格配置参数
     * @description 修改 cellSize 将同步影响截图渲染和点击坐标计算。
     * 极小粒度（如10px）无法容纳3~4个字符的代号，会导致文本强行粘连重叠。
     */
    public readonly gridConfig = {
        cellSize: 25,      // 网格切分粒度（像素）- 调整为 20，避免文字物理重叠
        fontSize: 12,       // 标签字体大小
        rectW: 18,         // 标签背景块宽度
        rectH: 11,         // 标签背景块高度
        gridStroke: '#ff00005f' // 网格线颜色
    };

    /** ### 是否显示网格线 
     * @description 控制截图上是否绘制 100px 步进的红线、坐标及屏幕尺寸备注
    */
    public showGridLine: boolean = true;

    constructor(device: DeviceClient, waitingTime: number) {
        super(device, waitingTime);
        /** 管理应用启动、强制停止及 Activity 切换 */
        this.am = new ActivityManager(device, waitingTime);
        /** 管理包的获取、列表及基础属性查询 */
        this.pm = new PackageManager(device, waitingTime);
        /** 负责 XML 层次结构解析及基于指纹的内容采集 */
        this.xml = new XmlManager(device, waitingTime);
    }

    /** ### 点击屏幕指定坐标 (x, y)
     * 通过 ADB `input tap` 命令模拟点击。该操作是异步的，会等待命令流结束。
     * 
     * 关联工具: {@link createAdbTools}
     * @param x 点击位置的横坐标 (像素)
     * @param y 点击位置的纵坐标 (像素)
     * @returns {Promise<void>} 当点击命令执行完成时返回
     */
    async click(x: number, y: number, count: number = 1, waitingTime: number = 1500): Promise<string | void> {
        if (isNaN(x) || isNaN(y)) {
            console.error(`[AndroidAgent] 错误: 点击坐标包含 NaN (x:${x}, y:${y})，已拦截`);
            throw new Error(`点击坐标无效 (x:${x}, y:${y})`);
        }

        return this.runQueued(async () => {
            const original = await this.getOriginalCoordinate(x, y, this.imageSize);

            logger(`[AndroidAgent] 执行点击: (${x}, ${y}) -> 物理: (${original.x}, ${original.y})`);

            // 1. 记录手机物理坐标 (确保红点位置绝对物理正确)
            AndroidAgent.lastClick.x = original.x;
            AndroidAgent.lastClick.y = original.y;
            // 2. 录入 AI 传入的原始坐标 (确保文字回显给 AI 的坐标与其输入完全一致，方便其微调)
            AndroidAgent.lastClick.rawX = x;
            AndroidAgent.lastClick.rawY = y;

            for (let i = 0; i < count; i++) {
                await this.device.shell(`input tap ${original.x} ${original.y}`);
                if (i < count - 1) {
                    const delay = Math.floor(Math.random() * (188 - 66 + 1)) + 66;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            return original.warning;
        }, waitingTime);
    }


    /** ### 捕获当前屏幕截图
     * 获取设备的 PNG 格式截图数据流，并将其保存到服务器的当前工作目录下。
     * 
     * 关联工具: {@link createAdbTools}
     *
     * @param quality 图片质量 (0-100)，默认 80
     * @param filename 保存的文件名，默认为 `screen.png`
     * @param grid 是否启用红线辅助网格（在截图上叠加网格线与分区标签）
     * @returns {Promise<string>} 返回保存后的截图文件绝对路径
     * @throws {Error} 如果截图流获取失败、图片处理（缩放/叠加网格）失败或文件写入过程中发生错误，将抛出异常
     *
     * @example
     * ```typescript
     * const filePath = await agent.screencap(80); // 质量 80
     * console.log('截图已保存到:', filePath);
     * ```
     */
    /** ### 核心图像压缩与网格绘制逻辑 (不包含 ADB 操作) */
    private async imageCompression(image: Buffer, _ignoredZoom: number, quality: number, drawGrid: boolean, labelText?: string, originalWidth: number = 0, originalHeight: number = 0): Promise<Buffer> {
        let s = sharp(image).rotate();
        const metadata = await s.metadata();
        let currentWidth = metadata.width || 0;
        let currentHeight = metadata.height || 0;

        // 1. 处理缩放 (统一到 imageSize, 默认 1000)
        if (this.imageSize && this.imageSize > 0 && currentWidth > 0 && currentHeight > 0) {
            currentWidth = this.imageSize;
            currentHeight = this.imageSize;
            s = s.resize(currentWidth, currentHeight);
        } else if (currentWidth > 0) {
            // 兜底逻辑
            currentWidth = 1000;
            currentHeight = 1000;
            s = s.resize(currentWidth);
        }

        const compositeOperations: sharp.OverlayOptions[] = [];

        // 2. 文字标签备注 (已根据需求：开启 showGridLine 时不再显示“当前屏幕”文字，且 labelText 目前在 executor 传入为“当前屏幕”)
        // 用户要求移除现在的当前屏幕文字，且所有新增内容受 showGridLine 控制
        if (!this.showGridLine && labelText && currentWidth > 0 && currentHeight > 0) {
            const fontSize = 15;
            const margin = 10;
            const svgLabel = `
                <svg width="${currentWidth}" height="${currentHeight}">
                    <text 
                        x="${margin}" 
                        y="${currentHeight - margin}" 
                        fill="red" 
                        font-size="${fontSize}" 
                        font-family="Arial, Helvetica, sans-serif"
                    >${labelText}</text>
                </svg>
            `;
            compositeOperations.push({ input: Buffer.from(svgLabel), left: 0, top: 0 });
        }

        // 3. 绘制 100px 红线网格与坐标 (受 showGridLine 控制)
        if (this.showGridLine && currentWidth > 0 && currentHeight > 0) {
            const gridStroke = '#ff0000'; // 纯红线
            const step = 100;

            // 计算原始图像在缩放后画布中的投影宽高
            const maxDim = Math.max(originalWidth, originalHeight);
            const scale = currentWidth / maxDim; // 假设 1000/maxDim
            const projectedWidth = originalWidth * scale;
            const projectedHeight = originalHeight * scale;

            let svgParts: string[] = [];
            svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${currentWidth}" height="${currentHeight}">`);

            // A. 网格线 (仅在截图区域绘制)
            svgParts.push(`<g opacity="0.6" stroke="${gridStroke}" stroke-width="1">`);
            // 垂直线 (x 轴)
            for (let x = step; x < projectedWidth; x += step) {
                svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${projectedHeight}" />`);
            }
            // 水平线 (y 轴)
            for (let y = step; y < projectedHeight; y += step) {
                svgParts.push(`<line x1="0" y1="${y}" x2="${projectedWidth}" y2="${y}" />`);
            }
            svgParts.push(`</g>`);

            // B. 坐标标签绘制
            svgParts.push(`<g font-family="Arial, Helvetica, sans-serif" font-size="12">`);

            // X 轴标注 (放到底部边缘，并位于对应垂直红线的中间位置)
            const xLabelY = currentHeight - 20; // 稍微多调一点边距，避免触底被折叠

            // 补充：起始 0 轴标注 (左下角偏移，保证不被裁)
            svgParts.push(`
                <rect x="0" y="${xLabelY - 8}" width="20" height="16" fill="white" />
                <text x="2" y="${xLabelY + 4}" fill="${gridStroke}" text-anchor="start">0</text>
            `);

            for (let x = step; x < projectedWidth; x += step) {
                const text = `x:${x}`;
                const textWidth = 35;
                const textHeight = 16;
                // 确保 rect 不会超出右边界
                const rectX = Math.min(x - textWidth / 2, currentWidth - textWidth);
                svgParts.push(`
                    <rect x="${rectX}" y="${xLabelY - textHeight / 2}" width="${textWidth}" height="${textHeight}" fill="white" />
                    <text x="${x}" y="${xLabelY + 4}" fill="${gridStroke}" text-anchor="middle">${text}</text>
                `);
            }

            // 补充：末尾宽度标注
            const maxX = Math.floor(projectedWidth);
            svgParts.push(`
                <rect x="${Math.min(maxX - 20, currentWidth - 40)}" y="${xLabelY - 8}" width="40" height="16" fill="white" />
                <text x="${Math.min(maxX, currentWidth - 2)}" y="${xLabelY + 4}" fill="${gridStroke}" text-anchor="end">${maxX}</text>
            `);

            // Y 轴标注 (显示在右侧超出屏幕外的黑色部分)
            const rightBlackAreaX = projectedWidth + 15;
            if (currentWidth > projectedWidth) {
                // 补充：起始 0 轴标注 (右上角偏移，高度调整为 12 避免被顶栏裁掉)
                svgParts.push(`
                    <rect x="${rightBlackAreaX}" y="0" width="30" height="16" fill="white" />
                    <text x="${rightBlackAreaX + 2}" y="12" fill="${gridStroke}">0</text>
                `);

                for (let y = step; y < projectedHeight; y += step) {
                    const text = `y:${y}`;
                    const textHeight = 16;
                    // 指引 rect 垂直居中，并加入边界保护
                    const rectY = Math.min(y - textHeight / 2, currentHeight - textHeight);
                    svgParts.push(`
                        <rect x="${rightBlackAreaX}" y="${rectY}" width="40" height="16" fill="white" />
                        <text x="${rightBlackAreaX + 2}" y="${y + 4}" fill="${gridStroke}">${text}</text>
                    `);
                }

                // 补充：末尾高度标注 (右下角偏移，高度限制，避免被底边裁掉)
                const maxY = Math.floor(projectedHeight);
                const rectY_max = Math.min(maxY - 8, currentHeight - 16);
                svgParts.push(`
                    <rect x="${rightBlackAreaX}" y="${rectY_max}" width="40" height="16" fill="white" />
                    <text x="${rightBlackAreaX + 2}" y="${rectY_max + 12}" fill="${gridStroke}">${maxY}</text>
                `);

                // C. 详细分辨率备注 (移动到画布绝对右下角，右对齐，避免遮挡任何坐标)
                const line1 = `图片分辨率：${currentWidth}*${currentHeight}`;
                const line2 = `手机分辨率：${Math.floor(projectedWidth)}*${Math.floor(projectedHeight)}`;
                const line3 = `请根据手机分辨率点击`;

                const textX = currentWidth - 10;
                const baseY = currentHeight - 65;
                svgParts.push(`
                    <text x="${textX}" y="${baseY}" fill="${gridStroke}" font-size="16" font-weight="bold" text-anchor="end">${line1}</text>
                    <text x="${textX}" y="${baseY + 25}" fill="${gridStroke}" font-size="16" font-weight="bold" text-anchor="end">${line2}</text>
                    <text x="${textX}" y="${baseY + 50}" fill="${gridStroke}" font-size="16" font-weight="bold" text-anchor="end">${line3}</text>
                `);

                // D. 上次点击位置显示 (由 BaseModule 统一基于 1000px 网格换算)
                if (AndroidAgent.lastClick.rawX !== null && AndroidAgent.lastClick.rawY !== null) {
                    // 因为我们的画布固定是 1000x1000，且 AI 提供的也是 0-1000 的坐标
                    // 所以红点位置即为 AI 提供的 rawX, rawY
                    const lx = AndroidAgent.lastClick.rawX;
                    const ly = AndroidAgent.lastClick.rawY;

                    // 在右下角红字上面显示上次点击的位置 (直接回显 AI 视角的原始坐标)
                    svgParts.push(`
                        <text x="${textX}" y="${baseY - 25}" fill="${gridStroke}" font-size="16" font-weight="bold" text-anchor="end">上次点击：(${lx}, ${ly})</text>
                    `);

                    // 绘制红点 (半径 8px)
                    svgParts.push(`
                        <circle cx="${lx}" cy="${ly}" r="8" fill="red" stroke="white" stroke-width="2" />
                    `);
                }
            }

            svgParts.push(`</g></svg>`);
            compositeOperations.push({ input: Buffer.from(svgParts.join('')), left: 0, top: 0 });
        }

        if (compositeOperations.length > 0) {
            s = s.composite(compositeOperations);
        }

        return await s.webp({ quality }).toBuffer();
    }

    /** ### 捕获当前屏幕截图 (内部实现) */
    private async internalScreencap(quality: number = 80, filename: string = 'screen.png', grid: boolean = false, inputBuffer?: Buffer, labelText?: string): Promise<{ filePath: string, buffer: Buffer }> {
        let image_prototypeBuffer: Buffer;

        if (inputBuffer) {
            // 如果传入了现有 Buffer，直接使用，省去了 ADB screencap 的时间
            image_prototypeBuffer = inputBuffer;
        } else {
            // 否则从设备捕获
            const screenshotStream = await this.device.screencap();
            const chunks = []
            for await (const s of screenshotStream) {
                chunks.push(s)
            }
            image_prototypeBuffer = Buffer.concat(chunks);
        }

        // --- 核心修改：将截图拓展为 1:1 正方形 ---
        const metadata = await sharp(image_prototypeBuffer).metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;
        if (width > 0 && height > 0 && width !== height) {
            const isRight = height > width;
            image_prototypeBuffer = await sharp(image_prototypeBuffer)
                .extend({
                    right: isRight ? (height - width) : 0,
                    bottom: isRight ? 0 : (width - height),
                    background: { r: 0, g: 0, b: 0, alpha: 1 } // 使用纯黑填充多余部分
                })
                .png()
                .toBuffer();
        }

        const image_buffer = await this.imageCompression(image_prototypeBuffer, 100, quality, grid, labelText, width, height);
        const filePath = path.join(BaseModule.getRootPath(), 'agentData', 'temp', filename);

        if (!fs.existsSync(path.dirname(filePath))) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        fs.writeFileSync(filePath, image_buffer);

        return { filePath, buffer: image_prototypeBuffer };
    }

    /** ### 捕获并保存截图
     * @returns 返回包含 { filePath, buffer } 的结果，buffer 为原始全量截图数据
     */
    async screencap(quality: number = 80, waitingTime: number = 0, filename: string = 'screen.png', grid: boolean = false, inputBuffer?: Buffer, labelText?: string): Promise<{ filePath: string, buffer: Buffer }> {
        return this.runQueued(async () => {
            return this.internalScreencap(quality, filename, grid, inputBuffer, labelText);
        }, waitingTime);
    }

    /** ### 获取带分区的屏幕结构 (优化版)
     *  @param [inputBuffer] 可选的原始数据 Buffer。如果传入，则基于该 Buffer 叠加网格，不发起 ADB 指令。
     */
    async gridScreencap(waitingTime: number = 0, inputBuffer?: Buffer): Promise<{ filePath: string, buffer: Buffer }> {
        return this.screencap(80, waitingTime, 'grid_screen.png', true, inputBuffer);
    }

    /** ### 根据网格代号获取缩放后的中心坐标 (内部使用) */
    private async getCoordinateByGrid(gridCode: string): Promise<{ x: number, y: number }> {
        const code = (gridCode || '').trim().toUpperCase();
        const match = code.match(/^([A-Z]+)(\d+)$/);
        if (!match) {
            throw new Error(`[AndroidAgent] gridCode 格式错误: "${gridCode}"，期望形如 A1、D5、AA12`);
        }

        const letters = match[1];
        const rowNumber = Number(match[2]); // 1-based
        if (!Number.isFinite(rowNumber) || rowNumber <= 0) {
            throw new Error(`[AndroidAgent] gridCode 行号错误: "${gridCode}"`);
        }

        // A->0, Z->25, AA->26, AB->27 ...
        let colIndex = 0;
        for (const ch of letters) {
            colIndex = colIndex * 26 + (ch.charCodeAt(0) - 65 + 1);
        }
        colIndex = colIndex - 1;

        const rowIndex = rowNumber - 1; // 0-based
        const cellSize = this.gridConfig.cellSize;

        // 因为我们的截图和点击坐标系现在统一为 1000x1000
        const gridCanvasSize = 1000;

        const x0 = colIndex * cellSize;
        const y0 = rowIndex * cellSize;
        const x1 = (colIndex + 1) * cellSize;
        const y1 = (rowNumber) * cellSize;

        // 取格子中心点
        let targetX = Math.floor((x0 + x1) / 2);
        let targetY = Math.floor((y0 + y1) / 2);

        // 边界保护
        targetX = Math.max(0, Math.min(targetX, gridCanvasSize - 1));
        targetY = Math.max(0, Math.min(targetY, gridCanvasSize - 1));

        return { x: targetX, y: targetY };
    }

    /** ### 点击网格区域
     *  @description AI通过上面 gridScreencap 获取了网格截图后传入区域代号，然后计算坐标调用 click 点击坐标
     */
    async clickByGrid(gridCode: string, waitingTime?: number): Promise<string | void> {
        const { x, y } = await this.getCoordinateByGrid(gridCode);
        return await this.click(x, y, 1, waitingTime);
    }

    /** ### 根据网格区域进行滑动
     * @param startCode 起点网格代号 (如 "A1")
     * @param endCode 终点网格代号 (如 "C5")
     */
    async swipeByGrid(startCode: string, endCode: string, duration?: number, waitingTime?: number): Promise<string | void> {
        const start = await this.getCoordinateByGrid(startCode);
        const end = await this.getCoordinateByGrid(endCode);
        return await this.swipe(start.x, start.y, end.x, end.y, duration, waitingTime);
    }

    /** ### 清空网格区域对应的输入框内容
     * @param gridCode 输入框所在的网格代号 (如 "A1")
     */
    async clearAllTextByGrid(gridCode: string, waitingTime?: number): Promise<void> {
        const { x, y } = await this.getCoordinateByGrid(gridCode);
        await this.click(x, y, 1, 200);
        await this.clearAllText(waitingTime);
        await this.click(x, y, 1, 200);
    }

    /** ### 获取滚动截屏
     *  @description 向下滚动截屏，滚动45-55%之间，输入滚动数量则表示获取的屏幕的数量
     *  @param number 获取的滚动屏幕数量
     *  @returns 返回截屏图片地址数组
     */
    async scrollScreencap(number: number): Promise<string[]> {
        const results: string[] = [];
        // 调用公共方法，它们会自动进入队列执行，不会造成嵌套死锁
        const size = await this.getScreenSize();
        if (!size) {
            console.error("[AndroidAgent] 获取屏幕大小失败，无法执行滚动截屏");
            return [];
        }

        for (let i = 0; i < number; i++) {
            // 1. 获取截图
            const randomName = `scroll_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`;
            const capResult = await this.screencap(80, 0, randomName, false);
            const filePath = capResult.filePath;
            results.push(filePath);

            // 2. 如果不是最后一屏，则调用 swipe 滑动
            if (i < number - 1) {
                // x 轴位置在 40%-60% 之间随机
                const xRatio = (Math.random() * (60 - 40) + 40) / 100;
                const x = Math.floor(size.width * xRatio);

                // 高度差在 45%-55% 之间随机
                const distRatio = (Math.random() * (55 - 45) + 45) / 100;
                const distance = Math.floor(size.height * distRatio);

                // y 轴的范围要求在 25%-75% 之间随机（指整个滑动发生的区域范围）
                // 这个时候滑动方向是往上滑 (startY > endY)，我们需要保证 startY 和 endY 尽量在这个范围
                // 所以实际的安全起点 startY 允许范围是 [25% + 此刻产生的 distance, 75%] 左右或者更广
                const minStartYRatio = 0.25 + distRatio; // 大约 0.70 到 0.80
                const maxStartYRatio = 0.75;

                // 为了兼容极端情况 (如 0.25+0.55 = 0.80 超过了 0.75)
                const safeMin = Math.min(minStartYRatio, maxStartYRatio);
                const safeMax = Math.max(minStartYRatio, maxStartYRatio);

                const startYRatio = (Math.random() * (safeMax - safeMin) + safeMin);
                const startY = Math.floor(size.height * startYRatio);
                const endY = startY - distance;

                // 随机结束时间（滑动完毕后的停顿）已经在 swipe 内部逻辑 (200-500ms) 中实现了，
                // 或者我们可以在调用的时候传 waitingTime。
                // 等待时间这里传 0 即可，因为我们在上一步修改的 swipe() 里面有一段硬编码：
                // Math.floor(Math.random() * (500 - 200 + 1)) + 200 的延时。

                // 我们调用已有的公有 swipe 方法：
                // 我们调用已有的公有 swipe 方法
                await this.swipe(x, startY, x, endY, undefined, 0);
            }
        }

        return results;
    }

    /** ### 检查屏幕状态 (亮屏/熄屏)
     * 兼容性重构：由于各家厂商 (如 Vivo, Oppo) 的 dumpsys 输出格式不一，
     * 此处聚合了多种常见的亮屏判定标识。
     * @returns {Promise<boolean>} true 表示亮屏，false 表示熄屏
     */
    async isScreenOn(): Promise<boolean> {
        try {
            const cmd = 'dumpsys power | grep -E "mWakefulness=|mPowerState=|Display Power: state=|mHoldingDisplaySuspendBlocker="';
            const output = await this.runShell(cmd);
            const lowerOutput = output.toLowerCase();

            // 只要命中任何一个“唤醒/亮屏”标识，则判定为亮屏
            const isOn = lowerOutput.includes('mwakefulness=awake') ||
                lowerOutput.includes('mpowerstate=awake') ||
                lowerOutput.includes('state=on') ||
                lowerOutput.includes('mholdingdisplaysuspendblocker=true');

            return isOn;
        } catch (e) {
            // 兜底策略：获取失败时默认返回 true，防止误触发电源键导致关屏
            return true;
        }
    }

    /** ### 检查当前是否有输入框被聚焦 (软键盘是否弹起)
     * 通过 `dumpsys input_method` 查看 `mInputShown` 状态判断。
     * @returns {Promise<boolean>} true 表示有输入框聚焦（键盘已弹出），false 表示未聚焦
     */
    async isFocused(): Promise<boolean> {
        try {
            const output = await this.runShell('dumpsys input_method | grep mInputShown');
            return output.includes('mInputShown=true');
        } catch (e) {
            // 获取失败时默认返回 false，触发未聚焦提示以防止误操作
            return false;
        }
    }

    /** ### 模拟按下“返回”键
     * 发送标准的 Android KEYCODE_BACK (4) 事件。
     * 
     * 关联工具: {@link createAdbTools}
     *
     * @returns {Promise<void>} 执行完成后返回
     */
    async back(waitingTime?: number): Promise<void> {
        return this.sendKeyEvent(4, waitingTime);
    }

    /** ### 模拟按下“主页” (Home) 键
     * 发送标准的 Android KEYCODE_HOME (3) 事件。
     * 
     * 关联工具: {@link createAdbTools}
     *
     * @returns {Promise<void>} 执行完成后返回
     */
    async home(waitingTime?: number): Promise<void> {
        return this.sendKeyEvent(3, waitingTime);
    }

    /** ### 电源开关 (锁定/解锁屏幕)
     * 发送标准的 Android KEYCODE_POWER (26) 事件。
     * 如果屏幕是亮的，该操作通常会熄灭屏幕；如果是灭的，则会点亮。
     * 
     * 关联工具: {@link createAdbTools}
     *
     * @returns {Promise<void>} 执行完成后返回
     */
    async switchScreen(waitingTime?: number): Promise<void> {
        return this.sendKeyEvent(26, waitingTime);
    }

    /** ### 调节音量
     * 模拟按下音量上键或下键。
     * 
     * 关联工具: {@link createAdbTools}
     *
     * @param direction 'up' (KEYCODE_VOLUME_UP: 24) 或 'down' (KEYCODE_VOLUME_DOWN: 25)
     * @returns {Promise<void>} 执行完成后返回
     *
     * @example
     * ```typescript
     * await agent.volume('up'); // 调大音量
     * ```
     */
    async volume(direction: 'up' | 'down', waitingTime?: number): Promise<void> {
        const keyCode = direction === 'up' ? 24 : 25;
        return this.sendKeyEvent(keyCode, waitingTime);
    }

    /** 发送按键事件 (内部辅助方法) 
     * @param keyCode 按键码
     * @param metaState 元键状态 (可选)，如 4096 表示 Ctrl
     */
    public async sendKeyEvent(keyCode: number, waitingTime?: number, metaState?: number): Promise<void> {
        return this.runQueued(async () => {
            const cmd = metaState
                ? `input keyevent --meta ${metaState} ${keyCode}`
                : `input keyevent ${keyCode}`;

            const stream = await this.device.shell(cmd);
            await new Promise<void>((resolve, reject) => {
                stream.on('data', () => { });
                stream.on('end', () => resolve());
                stream.on('error', (err: Error) => reject(new Error(`按键事件 ${keyCode} 失败: ${err.message}`)));
            });

            // --- 自动开屏联动逻辑: 仅在 224 (WAKEUP) 或 26 (POWER) 时触发 ---
            // 注意：此处不再执行滑动，仅做状态同步。滑动解锁由业务层显式调用 unlockScreen() 处理。
            if (keyCode === 224 || keyCode === 26) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }, waitingTime);
    }

    /** ### 唤醒并解锁屏幕
     * 智能执行：点亮屏幕 -> 等待响应 -> 判定状态 -> 上滑解锁。
     * 该方法封装了完整的唤醒链路，建议在任务开始或模型请求前调用。
     */
    public async unlockScreen(waitingTime?: number): Promise<void> {
        logger(`[AndroidAgent] 🚀 正在执行唤醒并自动解锁逻辑...`, { debug: true });
        
        // 1. 发送唤醒指令 (不带队列，直接发送以保证响应)
        await this.runShell(`input keyevent 224`);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 2. 检查屏幕状态
        const isOn = await this.isScreenOn();
        if (!isOn) {
            logger(`[AndroidAgent] ⚠️ 唤醒指令发送后屏幕仍未响应。`, { error: true });
            return;
        }

        // 3. 执行上滑解锁 (使用底层指令)
        const size = await this.internalGetScreenSize();
        if (size) {
            const x = Math.floor(size.width / 2);
            const y1 = Math.floor(size.height * 0.9);
            const y2 = Math.floor(size.height * 0.2);
            logger(`[AndroidAgent] ✨ 正在执行解锁滑动: (${x},${y1}) -> (${x},${y2})`);
            await this.runShell(`input swipe ${x} ${y1} ${x} ${y2} 400`);
            await new Promise(resolve => setTimeout(resolve, 800));
        }
    }



    /** ### 输入文本 (并自动清空原内容)
     * 智能输入：
     * 1. 自动发送指令序列清空当前聚焦的文本框。
     * 2. 纯 ASCII 文本使用 `input text`。
     * 3. 含中文/非ASCII字符时自动切换 ADB Keyboard 广播输入。
     * 
     * 关联工具: {@link createAdbTools}
     */
    async inputText(text: string, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            // 0. 先清空当前聚焦的输入框全部文本 (使用组合按键序列)
            // await this.device.shell(`input keyevent 20`);
            // await this.device.shell(`input keyevent 67`);
            // await this.device.shell(`input keyevent 19`);
            // await this.device.shell(`input keyevent 67`);

            // 检测是否包含非 ASCII 字符 (中文、日文、emoji 等)
            // const hasNonAscii = /[^\x00-\x7F]/.test(text);

            // if (!hasNonAscii) {
            //     // 纯 ASCII：使用原生 input text
            //     const cmd = `input text "${text}"`;

            //     const stream = await this.device.shell(cmd);
            //     return new Promise<void>((resolve, reject) => {
            //         stream.on('data', () => { });
            //         stream.on('end', () => resolve());
            //         stream.on('error', (err: Error) => reject(new Error(`文本输入失败: ${err.message}`)));
            //     });
            // }

            // 非 ASCII (中文等)：使用 ADB Keyboard 广播方式

            // ======================= 切换输入法逻辑 =======================
            // 1. 获取已启用的输入法列表并校验 AdbKeyboard
            const enabledImes = (await this.runShell('ime list -s')).trim();
            const adbKeyboardIme = 'com.android.adbkeyboard/.AdbIME';

            if (!enabledImes.includes(adbKeyboardIme)) {
                console.error(`[AndroidAgent] 错误: ADB Keyboard 未在系统中启用！请先在手机设置中开启该输入法。`);
                throw new Error(`请先到手机“设置 -> 语言与输入法 -> 管理输入法”中开启 ADB Keyboard`);
            }

            // 2. 获取当前正在使用的输入法
            const currentIme = (await this.runShell('settings get secure default_input_method')).trim();


            if (currentIme !== adbKeyboardIme) {
                // 切换到 ADB Keyboard
                await this.runShell(`ime set ${adbKeyboardIme}`);

                // 等待输入法切换及焦点稳定 (Vivo 建议更久)
                await new Promise(resolve => setTimeout(resolve, 800));

                // 【新增逻辑】再次点击上次点击的位置，尝试重新聚焦输入框
                if (AndroidAgent.lastClick.rawX !== null && AndroidAgent.lastClick.rawY !== null) {
                    const original = await this.getOriginalCoordinate(AndroidAgent.lastClick.rawX, AndroidAgent.lastClick.rawY, this.imageSize);
                    await this.runShell(`input tap ${original.x} ${original.y}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            const base64Text = Buffer.from(text).toString('base64');
            const broadcastCmd = `am broadcast -a ADB_INPUT_B64 --es msg "${base64Text}"`;
            await this.runShell(broadcastCmd);

            if (currentIme && currentIme !== adbKeyboardIme && currentIme !== 'null') {
                await this.runShell(`ime set ${currentIme}`);
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        }, waitingTime);
    }

    /** ### 删除指定数量的字符
     * 模拟按下退格键 (KEYCODE_DEL: 67)。
     * 每次删除操作之间有 100-488ms 的随机延迟。
     * 
     * 关联工具: {@link createAdbTools}
     */
    async clearText(count: number, waitingTime?: number): Promise<void> {
        return this.runQueued(async () => {
            await new Promise(res => setTimeout(res, 400))
            for (const i in Array.from({ length: count })) {
                await this.runShell(`input keyevent 67`)
            }
        }, waitingTime);
    }

    /** ### 清空输入框内容
     * 逻辑：
     * 1. 通过 resourceId 从 XML 获取元素左上角坐标；若获取失败则回退使用传入的 (x, y)。
     * 2. 在目标坐标处点击 1 次以聚焦输入框。
     * 3. 随机延迟 133-499ms。
     * 4. 按顺序发送清空指令序列：DOWN(20) -> DEL(67) -> UP(19) -> DEL(67)。
     *
     * 关联工具: {@link createAdbTools}
     * @returns {Promise<void>}
     */
    async clearAllText(waitingTime?: number): Promise<void> {
        // 或者让子动作各自排队。考虑到 clearAllText 应该是一个完整的事务，这里整体包裹。
        return this.runQueued(async () => {
            // adb  -s 10ACCX2912000YY shell input keyevent 21; adb -s 10ACCX2912000YY shell input keyevent 20
            await this.runShell('input text 1')
            await this.runShell(`input keyevent 21`);
            await this.runShell(`input keyevent 20`);
            // await this.runShell(`input keyevent 20`);
            for (const i in Array.from({ length: 50 })) {
                await this.runShell(`input keyevent 67`)
            }

        }, waitingTime);
    }

    /** ### 滑动、长按或拖拽交互 (swipe)
     * 系统会自动将 1000px 网格坐标还原为设备的物理像素坐标。
     * @param x1 起点 X (0-1000)
     * @param y1 起点 Y (0-1000)
     * @param x2 终点 X (0-1000)
     * @param y2 终点 Y (0-1000)
     * @param duration 持续时间 (ms)，不传则根据交互类型自动生成随机时长
     */
    async swipe(x1: number, y1: number, x2: number, y2: number, duration?: number, waitingTime?: number): Promise<string | void> {
        // 1. 安全校验：拦截所有包含非法 NaN 坐标的调用，防止 adb 崩溃
        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
            console.error(`[AndroidAgent] 错误: 交互坐标包含 NaN (start:[${x1},${y1}], end:[${x2},${y2}])，已拦截`);
            return;
        }

        return this.runQueued(async () => {
            // 2. 坐标转换：将 1000px 网格系统的参数还原为当前设备的真实物理像素
            const start = await this.getOriginalCoordinate(x1, y1, this.imageSize);
            const end = await this.getOriginalCoordinate(x2, y2, this.imageSize);

            // 3. 行为特征判定
            const isLongPress = (x1 === x2 && y1 === y2);           // 起终点重合视为长按
            const isDrag = !isLongPress && duration !== undefined;  // 起终点不同且指定了时长视为拖拽

            // 4. 执行拖拽逻辑 (Android 10+ 优先使用高效的 draganddrop)
            if (isDrag) {
                const actualDuration = duration || 1500;
                const dragCmd = `input draganddrop ${start.x} ${start.y} ${end.x} ${end.y} ${actualDuration}`;
                const output = await this.runShell(dragCmd);

                if (!output.includes("Error: Unknown command") && !output.includes("Error: Unknown action")) {
                    await new Promise(resolve => setTimeout(resolve, actualDuration));
                    const postWaitTime = Math.max(this.waitingTime_default, 1000);
                    await new Promise(resolve => setTimeout(resolve, postWaitTime));
                    return start.warning || end.warning;
                }
            }

            const actualDuration = duration || (isLongPress ? 1500 : Math.floor(Math.random() * (1500 - 1000 + 1)) + 1000);
            await this.runShell(`input swipe ${start.x} ${start.y} ${end.x} ${end.y} ${actualDuration}`);

            await new Promise(resolve => setTimeout(resolve, actualDuration));

            const postWaitTime = Math.max(this.waitingTime_default, 1000);
            await new Promise(resolve => setTimeout(resolve, postWaitTime));

            return start.warning || end.warning;
        }, waitingTime);
    }
}
