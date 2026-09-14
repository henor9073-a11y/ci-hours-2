import { AsyncLocalStorage } from 'node:async_hooks';

// 木纹网页是只读的：它发来的 MCP 调用带 x-muwen-readonly 头。
// 这类调用只能用读的工具，而且"读"本身也不能改记忆——不升温、不记访问次数、不写召回日志。
const store = new AsyncLocalStorage();

export const runReadonly = fn => store.run(true, fn);
export const isReadonly = () => store.getStore() === true;

// 网页能调的只有这些：get_* / search_* / list_* 加上两个纯查询
export const READONLY_TOOL = name => /^(get_|search_|list_)/.test(name) || ['rings_by_date', 'auto_recall'].includes(name);
