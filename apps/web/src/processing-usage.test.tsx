// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ProcessingUsage } from "@neoread/core";
import { UsageDetails, combineUsageReports } from "./ProcessingUsage";
const total = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cachedInputTokens: 7,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 2,
};
const report: ProcessingUsage = {
  historyComplete: true,
  total,
  calls: [
    {
      id: "one",
      stage: "settling",
      target: "p1-b1",
      provider: "codex",
      startedAt: "2026-10-06T00:00:00Z",
      finishedAt: "2026-10-06T00:00:10Z",
      status: "failed",
      models: [{ model: "actual", tokens: total }],
    },
  ],
  groups: [
    {
      stage: "settling",
      provider: "codex",
      model: "actual",
      calls: 1,
      unknownCalls: 0,
      tokens: total,
    },
  ],
  stages: [
    { stage: "learning", durationMs: 1000 },
    { stage: "settling", durationMs: 10000 },
    { stage: "translating", durationMs: 0 },
  ],
  unknownCalls: 0,
  failedCalls: 1,
  partialCalls: 1,
  elapsedMs: 11000,
};
it("shows actual model usage without adding cache subsets again", () => {
  const text = renderToStaticMarkup(<UsageDetails report={report} />);
  expect(text).toContain("15 tokens");
  expect(text).toContain("actual");
});
it("never represents missing or historical usage as zero tokens", () => {
  const unknown: ProcessingUsage = {
    ...report,
    historyComplete: false,
    total: { ...total, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    calls: [{ ...report.calls[0], models: [{ model: "", tokens: null }] }],
    groups: [{ ...report.groups[0], model: "", unknownCalls: 1 }],
    unknownCalls: 1,
    partialCalls: 0,
  };
  const text = renderToStaticMarkup(<UsageDetails report={unknown} />);
  expect(text).toContain("历史用量未记录");
  expect(text).toContain("用量未知");
  expect(text).toContain("模型未返回");
  expect(text).not.toContain("0 tokens");
});

it("keeps every reading slot and quiets only the absent ones", () => {
  const markup = renderToStaticMarkup(<UsageDetails report={report} />);
  for (const label of [
    "调用次数",
    "成功",
    "未成功",
    "进行中",
    "输入 token",
    "输出 token",
    "总 token",
    "关联调用累计耗时",
    "缓存读取 token",
    "缓存写入 token",
    "推理 token",
    "用量未知",
  ])
    expect(markup).toContain(`<dt>${label}</dt>`);
  expect(markup).toContain('<div data-empty=""><dt>成功</dt><dd>0</dd></div>');
  expect(markup).not.toContain('<div data-empty=""><dt>未成功');
  // Zero and unreturned readings still occupy the four-column grid.
  expect(markup.match(/data-empty=""/g)).toHaveLength(4);
});

it("combines processing and chat totals without counting cache subsets twice", () => {
  const chatReport = {
    ...report,
    total,
    calls: [
      { ...report.calls[0], stage: "chat", target: "question" },
      { ...report.calls[0], id: "retry", stage: "chat", target: "question" },
    ],
    groups: report.groups.map((group) => ({ ...group, stage: "chat" })),
    stages: [{ stage: "chat", durationMs: 10000 }],
    elapsedMs: 10000,
  };
  const combined = combineUsageReports(report, chatReport);
  expect(combined.total.totalTokens).toBe(30);
  expect(combined.total.cachedInputTokens).toBe(14);
  expect(combined.elapsedMs).toBe(21000);
});
