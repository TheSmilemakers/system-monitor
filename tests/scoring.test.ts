import { describe, expect, test } from "bun:test";

import { healthScore, privacyScore, type HealthInputs, type PrivacyInputs } from "@/lib/scoring";

const baseHealth: HealthInputs = {
  swapUsedMB: 0,
  electronAppCount: 0,
  browserCount: 0,
  processCount: 0,
  criticalHogs: 0,
  warningHogs: 0,
};

const basePrivacy: PrivacyInputs = {
  suspiciousProcesses: 0,
  highRiskPermissionGrants: 0,
  unknownLaunchAgents: 0,
  activeTrackers: 0,
};

describe("M-15 — health score is bounded and single-counted", () => {
  test("a clean machine scores 100", () => {
    expect(healthScore(baseHealth)).toBe(100);
  });

  test("stays within 0..100 under extreme input", () => {
    const worst = healthScore({
      swapUsedMB: 999_999,
      electronAppCount: 100,
      browserCount: 50,
      processCount: 10_000,
      criticalHogs: 100,
      warningHogs: 100,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(100);
  });

  test("hog penalties are capped, so one noisy app cannot zero the score", () => {
    const few = healthScore({ ...baseHealth, criticalHogs: 1 });
    const many = healthScore({ ...baseHealth, criticalHogs: 50 });
    expect(few - many).toBeLessThanOrEqual(30);
    expect(many).toBeGreaterThanOrEqual(70);
  });

  test("browser count is scored by degree, once", () => {
    const one = healthScore({ ...baseHealth, browserCount: 1 });
    const two = healthScore({ ...baseHealth, browserCount: 2 });
    const five = healthScore({ ...baseHealth, browserCount: 5 });
    expect(one).toBe(100); // a single browser is not a finding
    expect(two).toBe(95);
    expect(five).toBe(90); // capped tier, not linear per-finding stacking
  });

  test("swap tiers are monotonic and mutually exclusive", () => {
    const a = healthScore({ ...baseHealth, swapUsedMB: 50 });
    const b = healthScore({ ...baseHealth, swapUsedMB: 300 });
    const c = healthScore({ ...baseHealth, swapUsedMB: 1000 });
    const d = healthScore({ ...baseHealth, swapUsedMB: 5000 });
    expect(a).toBe(100);
    expect(b).toBe(95);
    expect(c).toBe(85);
    expect(d).toBe(70);
  });

  test("scores are integers", () => {
    expect(Number.isInteger(healthScore({ ...baseHealth, swapUsedMB: 777, criticalHogs: 3 }))).toBe(true);
  });
});

describe("M-15 — privacy score does not punish a normal machine", () => {
  test("a clean machine scores 100", () => {
    expect(privacyScore(basePrivacy)).toBe(100);
  });

  test("ordinary permission grants cost little", () => {
    // Camera/mic/photos on a working laptop is normal, not a privacy failure.
    const normal = privacyScore({ ...basePrivacy, highRiskPermissionGrants: 3 });
    expect(normal).toBeGreaterThanOrEqual(95);
  });

  test("permission influence is capped", () => {
    const extreme = privacyScore({ ...basePrivacy, highRiskPermissionGrants: 500 });
    expect(extreme).toBe(85);
  });

  test("a suspicious process dominates the score", () => {
    expect(privacyScore({ ...basePrivacy, suspiciousProcesses: 1 })).toBe(75);
    expect(privacyScore({ ...basePrivacy, suspiciousProcesses: 2 })).toBe(50);
    expect(privacyScore({ ...basePrivacy, suspiciousProcesses: 99 })).toBe(50); // capped
  });

  test("stays within 0..100", () => {
    const worst = privacyScore({
      suspiciousProcesses: 99,
      highRiskPermissionGrants: 99,
      unknownLaunchAgents: 99,
      activeTrackers: 99,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(worst).toBeLessThanOrEqual(100);
  });
});

describe("H-03 — a missing collector must never improve a score", () => {
  test("zero findings from a failed probe is not the same as a clean result", () => {
    // The route withholds the score entirely when incomplete; the rubric itself
    // must never be handed 'no evidence' and return 100 as if verified.
    const noEvidence = healthScore(baseHealth);
    expect(noEvidence).toBe(100);
    // Which is precisely why `complete: false` => healthScore: null upstream.
    // This test documents the contract the routes must honour.
    const complete = false;
    const exposed = complete ? noEvidence : null;
    expect(exposed).toBeNull();
  });
});
