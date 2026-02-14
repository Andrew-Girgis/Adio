import type { VoiceCommand } from "./types";

const COMMAND_PATTERNS: Array<{ command: VoiceCommand; patterns: RegExp[] }> = [
  {
    command: "stop",
    patterns: [/\bstop\b/i, /\bpause\b/i, /\bhold on\b/i]
  },
  {
    command: "resume",
    patterns: [/\bresume\b/i, /\bcontinue\b/i, /\bgo on\b/i]
  },
  {
    command: "repeat",
    patterns: [/\brepeat\b/i, /\bsay that again\b/i, /\bagain\b/i]
  },
  {
    command: "skip_confirm",
    patterns: [/\bskip confirm\b/i, /\bconfirm skip\b/i]
  },
  {
    command: "skip",
    patterns: [/\bskip\b/i, /\bmove on\b/i, /\bnext one\b/i]
  },
  {
    command: "explain",
    patterns: [/\bexplain\b/i, /\bwhy\b/i, /\bmore detail\b/i]
  },
  {
    command: "safety_check",
    patterns: [/\bsafety check\b/i, /\bis this safe\b/i, /\bsafety\b/i]
  },
  {
    command: "confirm",
    patterns: [/\bconfirm\b/i, /\bdone\b/i, /\bcompleted\b/i, /\bnext\b/i, /\byes\b/i]
  }
];

export function parseVoiceCommand(input: string): VoiceCommand | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  for (const { command, patterns } of COMMAND_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return command;
    }
  }

  return null;
}
