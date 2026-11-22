import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { takeSoftPaceAdvice } from "./soft-pace.js";

describe("takeSoftPaceAdvice", () => {
  const cfg = { toolStep: 50, wallStepMs: 3_600_000, surfaceStep: 25 };

  it("stays quiet before first milestone", () => {
    assert.equal(
      takeSoftPaceAdvice(
        {
          toolCalls: 49,
          wallMs: 3_599_000,
          lastSoftToolMilestone: 0,
          lastSoftWallMilestone: 0,
        },
        cfg,
      ),
      null,
    );
  });

  it("advises on tool milestone with pentest framing", () => {
    const hit = takeSoftPaceAdvice(
      {
        toolCalls: 50,
        wallMs: 0,
        lastSoftToolMilestone: 0,
        lastSoftWallMilestone: 0,
      },
      cfg,
    );
    assert.ok(hit);
    assert.match(hit.message, /节奏提示/);
    assert.match(hit.message, /渗透/);
    assert.match(hit.message, /禁止自称预算耗尽/);
    assert.doesNotMatch(hit.message, /结束循环|停止任务|budget_exhausted/);
    assert.equal(hit.next.lastSoftToolMilestone, 50);
  });

  it("does not repeat the same tool milestone", () => {
    assert.equal(
      takeSoftPaceAdvice(
        {
          toolCalls: 75,
          wallMs: 0,
          lastSoftToolMilestone: 50,
          lastSoftWallMilestone: 0,
        },
        cfg,
      ),
      null,
    );
  });

  it("advises on wall milestone", () => {
    const hit = takeSoftPaceAdvice(
      {
        toolCalls: 0,
        wallMs: 3_600_000,
        lastSoftToolMilestone: 0,
        lastSoftWallMilestone: 0,
      },
      cfg,
    );
    assert.ok(hit);
    assert.match(hit.message, /连续跑/);
    assert.equal(hit.next.lastSoftWallMilestone, 1);
  });

  it("advises surface rotation while Intent claimed", () => {
    const hit = takeSoftPaceAdvice(
      {
        toolCalls: 130,
        wallMs: 0,
        lastSoftToolMilestone: 100,
        lastSoftWallMilestone: 0,
        toolsAtIntentClaim: 100,
        lastSoftSurfaceMilestone: 0,
      },
      cfg,
    );
    assert.ok(hit);
    assert.match(hit.message, /换面|Intent/);
    assert.equal(hit.next.lastSoftSurfaceMilestone, 25);
  });
});
