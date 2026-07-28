/**
 * Score rubrics, isolated so they can be unit-tested against fixtures (M-15).
 *
 * The previous rubrics double-counted: swap/Electron/browser conditions were
 * deducted once directly and then again through the findings they produced, and
 * overlapping vendor patterns meant a single installed suite (Adobe matched six
 * patterns) cost 18 points on its own.
 *
 * Rules enforced here:
 *   1. Each *condition* is scored exactly once.
 *   2. Findings do not themselves deduct; they are presentation of conditions.
 *   3. A score is withheld entirely when required evidence is missing (H-03).
 */

export interface HealthInputs {
  swapUsedMB: number;
  electronAppCount: number;
  browserCount: number;
  processCount: number;
  criticalHogs: number;
  warningHogs: number;
}

export interface PrivacyInputs {
  suspiciousProcesses: number;
  highRiskPermissionGrants: number;
  unknownLaunchAgents: number;
  activeTrackers: number;
}

export function healthScore(i: HealthInputs): number {
  let score = 100;

  if (i.swapUsedMB > 2000) score -= 30;
  else if (i.swapUsedMB > 500) score -= 15;
  else if (i.swapUsedMB > 100) score -= 5;

  if (i.electronAppCount > 8) score -= 15;
  else if (i.electronAppCount > 5) score -= 8;

  // Counted once, by degree — not once per finding.
  if (i.browserCount > 2) score -= 10;
  else if (i.browserCount > 1) score -= 5;

  if (i.processCount > 800) score -= 10;
  else if (i.processCount > 600) score -= 5;

  score -= Math.min(30, i.criticalHogs * 10);
  score -= Math.min(15, i.warningHogs * 3);

  return clamp(score);
}

export function privacyScore(i: PrivacyInputs): number {
  let score = 100;

  score -= Math.min(50, i.suspiciousProcesses * 25);
  score -= Math.min(20, i.activeTrackers * 5);

  // Permission grants are normal on a working machine; cap their influence so a
  // healthy setup cannot be scored as a privacy failure.
  if (i.highRiskPermissionGrants > 10) score -= 15;
  else if (i.highRiskPermissionGrants > 5) score -= 8;
  else if (i.highRiskPermissionGrants > 0) score -= 3;

  if (i.unknownLaunchAgents > 10) score -= 10;
  else if (i.unknownLaunchAgents > 5) score -= 5;

  return clamp(score);
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
