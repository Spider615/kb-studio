import type { MiaodongAdapter, PushPayload, PushResult } from "@kb/core";

/** 秒懂推送占位实现：真实接口提供前只打印、不真正推送。 */
export class StubMiaodongAdapter implements MiaodongAdapter {
  async push(payload: PushPayload): Promise<PushResult> {
    console.warn(
      `[MiaodongAdapter:stub] 假装推送 doc=${payload.docId} title=${payload.title} chunks=${payload.chunks.length}`,
    );
    return { ok: true, pushed: payload.chunks.length, target: "stub" };
  }
}
