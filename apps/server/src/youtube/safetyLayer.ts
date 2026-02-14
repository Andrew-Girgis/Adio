import type { CompiledProcedureStep } from "./types";

const HIGH_RISK_PATTERNS: Array<{ flag: string; regex: RegExp }> = [
  { flag: "electricity", regex: /\b(power|breaker|electrical|voltage|live wire|plugged in|shock)\b/i },
  { flag: "gas", regex: /\b(gas line|propane|natural gas|pilot light|combustion)\b/i },
  { flag: "water", regex: /\b(water line|supply valve|flood|leak|hose)\b/i },
  { flag: "lifting_vehicles", regex: /\b(jack|jack stand|lift the car|under the vehicle)\b/i },
  { flag: "pressure_system", regex: /\b(pressure|pressurized|bleed valve|release pressure)\b/i }
];

const LOW_RISK_PATTERN = /\b(sharp|hot|pinch|moving parts|cut)\b/i;
const UNSAFE_BEHAVIOR_PATTERN = /\b(without (turning off|disconnecting|shutting)|while still plugged in|skip safety|ignore warning)\b/i;

export interface SafetyLayerResult {
  steps: CompiledProcedureStep[];
  safetyFlags: string[];
  warnings: string[];
}

export function applySafetyLayer(steps: CompiledProcedureStep[]): SafetyLayerResult {
  const safetyFlags = new Set<string>();
  const warnings: string[] = [];
  const out: CompiledProcedureStep[] = [];

  for (const originalStep of steps) {
    const step = { ...originalStep };
    const riskText = `${step.title} ${step.instruction} ${step.notes}`;

    const matchedHighFlags = HIGH_RISK_PATTERNS.filter((entry) => entry.regex.test(riskText)).map((entry) => entry.flag);

    if (matchedHighFlags.length > 0) {
      matchedHighFlags.forEach((flag) => safetyFlags.add(flag));
      step.safety_level = "high";
      step.requires_confirmation = true;
      step.notes = appendNote(step.notes, `High-risk operation: ${matchedHighFlags.join(", ")}. Confirm before continuing.`);
    } else if (LOW_RISK_PATTERN.test(riskText)) {
      step.safety_level = step.safety_level === "high" ? "high" : "low";
      step.requires_confirmation = true;
      step.notes = appendNote(step.notes, "Low-risk caution detected. Keep PPE and stable footing.");
    }

    if (UNSAFE_BEHAVIOR_PATTERN.test(riskText)) {
      warnings.push(`Transcript indicates potentially unsafe guidance near ${step.timestamp_range}.`);

      out.push({
        id: 0,
        title: "Safety Warning",
        instruction:
          "Safety warning: transcript may suggest an unsafe action. Stop and verify power, gas, water, or lift safety before continuing.",
        timestamp_range: step.timestamp_range,
        requires_confirmation: true,
        safety_level: "high",
        notes: "Inserted automatically due to unsafe transcript phrasing.",
        transcript_excerpt: step.transcript_excerpt
      });
    }

    out.push(step);
  }

  const reindexed = out.map((step, index) => ({
    ...step,
    id: index + 1
  }));

  return {
    steps: reindexed,
    safetyFlags: [...safetyFlags],
    warnings
  };
}

function appendNote(base: string, extra: string): string {
  const normalizedBase = base.trim();
  if (!normalizedBase) {
    return extra;
  }
  return `${normalizedBase} ${extra}`;
}
