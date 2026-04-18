import { logger } from '@/utils/logger.js';
import { createWorker } from 'tesseract.js';
import * as path from 'path';


/** ### OCR 文字识别
 *  @param imagePath 图片地址
 *  @param [onlyText=true] 是否返回纯文本内容，默认返回纯文本
 *  - `true` 返回按行读取的纯文本数组
 *  - `false` 返回 [{ text: '字', bounds: [ 653, 518, 694, 590 ] },{}.{}......]
 */
export async function OCR(
    /** 图片地址 */
    imagePath: string,
    /** 是否获取纯文字 */
    onlyText:boolean = true
) {
    
    // 1. 创建 Worker 时禁用网络下载
    const worker = await createWorker('chi_sim', 1, {
        
        langPath: path.join(process.cwd(), 'lib'), 
        gzip: false,
        cacheMethod: 'none', // 强制不走网络缓存
    });

    try {
        // 在识别前主动开启各类结构化数据的输出
        await worker.setParameters({
            tessjs_create_tsv: '1',
            tessjs_create_box: '1'
        });

        // 在 V5 中，若需返回 words, lines 等细节节点，需传入 { blocks: true } 并遍历 blocks 提取
        const recognizeResult = await worker.recognize(imagePath, {}, { blocks: true });
        
        // 根据 V5 的 blocks 结构提取数据
        let result: any[] = [];
        const linesTxt: string[] = [];

        if (recognizeResult.data?.blocks) {
            for (const block of recognizeResult.data.blocks) {
                if (block.paragraphs) {
                    for (const para of block.paragraphs) {
                        if (para.lines) {
                            for (const line of para.lines) {
                                if (onlyText) {
                                    // 识别纯文本模式：直接提取行文本，并移除所有空格
                                    const text = line.text?.replace(/\s+/g, '').trim();
                                    if (text) linesTxt.push(text);
                                } else {
                                    // 详细模式：提取每个词及其坐标
                                    if (line.words) {
                                        for (const w of line.words) {
                                            result.push({
                                                text: w.text,
                                                bounds: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // 清理后台资源
        await worker.terminate();
        return onlyText ? linesTxt : result;
    } catch (err) {
        console.error("全平台 OCR 执行异常:", err);
        if (worker) await worker.terminate();
        return [];
    }
}

// const imagepath = path.join(process.cwd(), 'assets', 'test.png');
// OCR(imagepath).then(r => {
//     console.log('OCR Result:', r);
// })
