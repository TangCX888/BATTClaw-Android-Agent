import { tool, type Tool } from 'ai'
import { number, object, z } from 'zod'
import { agent_Index } from '../../agent_index.class.js'
import { logger } from '../../../../utils/logger.js'

/** ### 最终产出的计划 */
type allPlan = string[]


/** ### 计划者相关工具包
 *  {@link new_agent_Index.plan}
 */
export function createPlanTools(agent: any): Record<string, Tool> {
    return {

        /** ### 输出计划
         * 
         */
        makePlan: tool({
            description: '输出拆解后的任务计划列表,输出规范：{allPlan:string[]}',
            parameters: z.object({
                allPlan: z.array(
                    z.string().describe("拆解后的具体的单个子任务")
                )
            }),
            //@ts-ignore
            execute: async (args: any) => {
                logger(`\n[Tools] Planner 调用 makePlan 输出计划数据.`);
                return { 
                    status: 'success', 
                    message: '计划已生成',
                    data: args.plan_list || args.task_list || args.plans || args.tasks || args.steps || args 
                };
            }
        }),

    }
}