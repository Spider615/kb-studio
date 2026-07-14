import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDockerRunArgs } from "./sandbox-docker";

const base = {
  image: "kb-sandbox:latest",
  authToken: "k",
  baseUrl: "https://api.302.ai",
  model: "claude-haiku-4-5-20251001",
  proxy: "http://host.docker.internal:7897",
  memory: "3g",
  cpus: "2",
  pidsLimit: 256,
  tmpfsSize: "512m",
  hostPath: "/tmp/kb-sbx-xxx/input.csv",
  mountName: "input.csv",
  filename: "2022年-精骐&捷美-产品价格表.csv",
};

test("buildDockerRunArgs：注入 KB_ORIGINAL_FILENAME=原始名，前一项为 -e", () => {
  const args = buildDockerRunArgs(base);
  const i = args.indexOf("KB_ORIGINAL_FILENAME=2022年-精骐&捷美-产品价格表.csv");
  assert.ok(i > 0, "应包含 KB_ORIGINAL_FILENAME=原始名");
  assert.equal(args[i - 1], "-e");
});

test("buildDockerRunArgs：-v 挂载仍用安全 mountName，不受原始名影响", () => {
  const args = buildDockerRunArgs(base);
  assert.ok(args.includes("/tmp/kb-sbx-xxx/input.csv:/work/input.csv:ro"));
  assert.equal(args[args.length - 1], "/work/input.csv"); // 末位是容器内文件路径
});
