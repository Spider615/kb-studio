/**
 * 处理任务注册表：docId → AbortController。
 * 用于「删除处理中文档」时中止后台处理。仅单 Node 进程内有效；
 * 挂在 globalThis 上以扛过 dev 的 HMR 模块重载。进程重启会丢失（孤儿 processing 文档由用户手动删）。
 */
const g = globalThis as unknown as { __kbJobs?: Map<string, AbortController> };
const jobs: Map<string, AbortController> = g.__kbJobs ?? (g.__kbJobs = new Map());

/** 注册一个任务，返回其中止信号。 */
export function startJob(docId: string): AbortSignal {
  const ctrl = new AbortController();
  jobs.set(docId, ctrl);
  return ctrl.signal;
}

/** 中止某任务；返回是否确有在处理的任务被中止。 */
export function abortJob(docId: string): boolean {
  const ctrl = jobs.get(docId);
  if (!ctrl) return false;
  ctrl.abort();
  jobs.delete(docId);
  return true;
}

/** 任务结束时注销。 */
export function endJob(docId: string): void {
  jobs.delete(docId);
}
