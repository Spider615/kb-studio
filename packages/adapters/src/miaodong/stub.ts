import type { MiaodongAdapter, MiaodongCredentials, PushPayload, PushResult } from "@kb/core";

/** 秒懂推送占位实现：只打印、不真正推送（凭据参数忽略）。 */
export class StubMiaodongAdapter implements MiaodongAdapter {
  async push(payload: PushPayload, _creds?: MiaodongCredentials): Promise<PushResult> {
    console.warn(
      `[MiaodongAdapter:stub] 假装推送 doc=${payload.docId} title=${payload.title} chunks=${payload.chunks.length}`,
    );
    return { ok: true, pushed: payload.chunks.length, target: "stub" };
  }
}
