import { AsyncLocalStorage } from 'node:async_hooks';
import { ProxyAgent } from 'undici';

/**
 * 代理配置选项接口
 */
export interface ProxyOptions {
    /** HTTP 代理地址，如 'http://127.0.0.1:1181' */
    http_proxy?: string;
    /** HTTPS 代理地址 (通常与 http_proxy 相同) */
    https_proxy?: string;
}

/**
 * 代理上下文中存储的内容
 */
interface ProxyStore {
    agent: ProxyAgent;
}

/**
 * 代理助手类
 * 利用 AsyncLocalStorage 实现基于代码作用域的“定向代理”
 */
class ProxyHelper {
    private storage = new AsyncLocalStorage<ProxyStore>();
    private isIntercepted = false;

    constructor() {
        this.initInterceptor();
    }

    /**
     * 初始化全局 fetch 拦截器
     */
    private initInterceptor() {
        if (this.isIntercepted) return;

        const originalFetch = global.fetch;
        
        // 覆盖全局 fetch
        global.fetch = ((url: any, init: any) => {
            // 获取当前异步上下文中的代理配置
            const store = this.storage.getStore();
            
            if (store) {
                // 如果在使用代理的作用域内，注入代理 dispatcher
                return originalFetch(url, {
                    ...init,
                    dispatcher: store.agent
                });
            }
            
            // 否则，执行原生直连请求
            return originalFetch(url, init);
        }) as any;

        this.isIntercepted = true;
    }

    /**
     * 在指定代理块内运行代码
     * @param callback 需要运行的异步代码块
     * @param options 代理配置项
     */
    async useProxy<T>(callback: () => Promise<T>, options?: ProxyOptions): Promise<T> {
        // 获取有效的代理 URL
        const proxyUrl = options?.https_proxy || options?.http_proxy;

        // 如果没有提供代理地址，则直接执行，不进入异步存储流程
        if (!proxyUrl) {
            return callback();
        }

        const agent = new ProxyAgent(proxyUrl);
        return this.storage.run({ agent }, callback);
    }
}

/** ### 请求中间件
 *  @function - useProxy 使用代理发送请求
 *  ```
 *      proxyHelper.useProxy(async ()=>{
 *              // 业务实现
 *      },{
 *          http_proxy: proxyUrl 
 *              // 代理设置
 *      })
 *  ```
 */
export default new ProxyHelper();
