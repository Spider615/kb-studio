import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, mapLimit } from "./real";

const noSleep = async () => {};

test("withRetry：瞬时失败重试后成功", async () => {
  let n = 0;
  const r = await withRetry(async () => {
    if (++n < 3) throw new Error("网络抖动");
    return "ok";
  }, 3, noSleep);
  assert.equal(r, "ok");
  assert.equal(n, 3);
});

test("withRetry：永久错误(HTTP 4xx 非429)立即抛，不重试", async () => {
  let n = 0;
  await assert.rejects(
    withRetry(async () => {
      n++;
      throw new Error("HTTP 400: 内容非法");
    }, 3, noSleep),
    /HTTP 400/,
  );
  assert.equal(n, 1); // 只试一次
});

test("withRetry：HTTP 429/5xx 会重试；超次数后抛", async () => {
  let n = 0;
  await assert.rejects(
    withRetry(async () => {
      n++;
      throw new Error("HTTP 503: 网关抖动");
    }, 2, noSleep),
    /HTTP 503/,
  );
  assert.equal(n, 3); // 1 + 2 次重试
});

test("mapLimit：全部处理、结果按原序、单项内部失败不影响其他", async () => {
  const items = [1, 2, 3, 4, 5];
  const out = await mapLimit(items, 2, async (x) => (x === 3 ? "fail" : x * 10));
  assert.deepEqual(out, [10, 20, "fail", 40, 50]);
});

test("mapLimit：并发不超过上限", async () => {
  let cur = 0;
  let peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
    cur++;
    peak = Math.max(peak, cur);
    await new Promise((r) => setTimeout(r, 5));
    cur--;
    return 0;
  });
  assert.ok(peak <= 2, `峰值并发 ${peak} 应 ≤ 2`);
});
