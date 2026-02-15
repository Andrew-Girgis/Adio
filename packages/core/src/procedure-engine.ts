import type { EngineResult, ProcedureDefinition, ProcedureStateSnapshot, ProcedureStep, VoiceCommand } from "./types";

export class ProcedureEngine {
  private readonly procedure: ProcedureDefinition;
  private currentStepIndex = 0;
  private status: ProcedureStateSnapshot["status"] = "idle";
  private awaitingConfirmation = false;
  private skipNeedsConfirmation = false;
  private completedSteps: string[] = [];

  constructor(procedure: ProcedureDefinition) {
    this.procedure = procedure;
  }

  getState(): ProcedureStateSnapshot {
    return {
      procedureId: this.procedure.id,
      title: this.procedure.title,
      status: this.status,
      currentStepIndex: this.currentStepIndex,
      totalSteps: this.procedure.steps.length,
      awaitingConfirmation: this.awaitingConfirmation,
      skipNeedsConfirmation: this.skipNeedsConfirmation,
      completedSteps: [...this.completedSteps]
    };
  }

  start(): EngineResult {
    if (this.procedure.steps.length === 0) {
      this.status = "completed";
      this.awaitingConfirmation = false;
      return {
        text: "I could not find actionable steps in this manual. Try a different issue description.",
        speechText: "I could not find steps for that. Try a different issue description.",
        state: this.getState(),
        shouldSpeak: true
      };
    }

    this.status = "awaiting_confirmation";
    this.awaitingConfirmation = true;
    return this.renderCurrentStep();
  }

  handleCommand(command: VoiceCommand): EngineResult {
    const step = this.getCurrentStep();

    if (!step && this.status === "completed") {
      return {
        text: "Procedure is already complete. Start a new session for another fix.",
        state: this.getState(),
        shouldSpeak: true
      };
    }

    switch (command) {
      case "start":
        if (this.status === "idle") {
          return this.start();
        }

        if (this.status === "paused") {
          return this.simpleResponse("You are paused. Say resume to continue.", "Paused. Say resume to continue.");
        }

        return this.simpleResponse(
          "Procedure already started. Say confirm when done, or say repeat or explain.",
          "Already started. Say confirm when done."
        );

      case "stop":
        this.status = "paused";
        this.awaitingConfirmation = false;
        return {
          text: `Paused at step ${this.currentStepIndex + 1}. Say resume when you are ready.`,
          speechText: "Paused. Say resume when you are ready.",
          state: this.getState(),
          shouldSpeak: true
        };

      case "resume":
        if (this.status !== "paused") {
          return {
            text: "Already active. Say repeat if you want the current step again.",
            speechText: "Already active. Say repeat if you want the step again.",
            state: this.getState(),
            shouldSpeak: true
          };
        }
        this.status = "awaiting_confirmation";
        this.awaitingConfirmation = true;
        return this.renderCurrentStep();

      case "repeat":
        return this.renderCurrentStep();

      case "explain":
        if (!step) {
          return this.simpleResponse("No active step to explain.", "No active step to explain.");
        }
        return this.simpleResponse(
          step.explanation ?? "This step reduces risk and keeps diagnosis accurate before moving on.",
          step.explanation ?? "This step helps reduce risk before you move on."
        );

      case "safety_check":
        if (!step) {
          return this.simpleResponse("No active step for safety check.", "No active step for safety check.");
        }
        return this.simpleResponse(
          step.safetyNotes ??
            "Wear gloves, power down equipment before opening panels, and stop if you detect burning smells or fluid leaks.",
          this.shortenForSpeech(
            step.safetyNotes ??
              "Wear gloves, power down equipment before opening panels, and stop if you detect burning smells or fluid leaks.",
            180
          )
        );

      case "skip":
        if (!step) {
          return this.simpleResponse("No remaining step to skip.", "No remaining step to skip.");
        }
        if (step.safetyCritical) {
          this.skipNeedsConfirmation = true;
          return this.simpleResponse(
            "This is a safety-critical step. Say skip confirm to proceed, or say repeat to hear it again.",
            "That step is safety-critical. Say skip confirm to proceed, or say repeat."
          );
        }
        return this.advanceStep(true);

      case "skip_confirm":
        if (!this.skipNeedsConfirmation) {
          return this.simpleResponse("No skip confirmation is pending.", "No skip confirmation is pending.");
        }
        return this.advanceStep(true);

      case "confirm":
        if (this.status === "paused") {
          return this.simpleResponse("You are paused. Say resume first.", "Paused. Say resume first.");
        }
        return this.advanceStep(false);

      default:
        return this.simpleResponse(
          "I did not catch that. Try: confirm, repeat, explain, safety check, stop, or resume.",
          "I did not catch that. Try confirm, repeat, explain, or safety check."
        );
    }
  }

  private advanceStep(skipped: boolean): EngineResult {
    const current = this.getCurrentStep();
    if (!current) {
      this.status = "completed";
      this.awaitingConfirmation = false;
      return this.simpleResponse("Procedure complete.");
    }

    this.completedSteps.push(current.id);
    this.currentStepIndex += 1;
    this.skipNeedsConfirmation = false;

    if (this.currentStepIndex >= this.procedure.steps.length) {
      this.status = "completed";
      this.awaitingConfirmation = false;
      const ending = skipped
        ? "Skipped the final step. Procedure complete. Run a quick safety check before testing."
        : "Procedure complete. Run a quick safety check, then test.";
      const endingSpeech = skipped
        ? "Procedure complete. Do a quick safety check before testing."
        : "Procedure complete. Do a quick safety check, then test.";
      return this.simpleResponse(ending, endingSpeech);
    }

    this.status = "awaiting_confirmation";
    this.awaitingConfirmation = true;
    return this.renderCurrentStep(skipped ? "Step skipped." : undefined);
  }

  private renderCurrentStep(prefix?: string): EngineResult {
    const step = this.getCurrentStep();
    if (!step) {
      return this.simpleResponse("No active step.", "No active step.");
    }

    const stepNumber = this.currentStepIndex + 1;
    const total = this.procedure.steps.length;
    const safetyLine = this.buildSafetyLine(step);
    const displaySafety = safetyLine ? `Safety: ${safetyLine}` : null;

    const displayPrompt = step.requiresConfirmation
      ? 'Say "confirm" when done. You can also say repeat, explain, safety check, stop, or skip.'
      : 'Say "confirm" when you are ready to advance.';

    const display = [`Step ${stepNumber} of ${total}: ${step.instruction}`, displaySafety, displayPrompt]
      .filter(Boolean)
      .join(" ");
    const displayWithPrefix = prefix ? `${prefix} ${display}` : display;

    const speechPrompt = "When you're done, say confirm.";
    const speech = [`Step ${stepNumber}.`, step.instruction, displaySafety, speechPrompt]
      .filter(Boolean)
      .join(" ");

    return {
      text: displayWithPrefix,
      speechText: speech,
      state: this.getState(),
      shouldSpeak: true
    };
  }

  private getCurrentStep(): ProcedureStep | undefined {
    return this.procedure.steps[this.currentStepIndex];
  }

  private buildSafetyLine(step: ProcedureStep): string | null {
    const safetyNotes = step.safetyNotes?.trim();
    if (safetyNotes) {
      return this.shortenForSpeech(safetyNotes, 140);
    }

    if (step.safetyCritical) {
      return "Disconnect power and keep hands clear of moving parts.";
    }

    return null;
  }

  private shortenForSpeech(text: string, maxChars: number): string {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned.length <= maxChars) {
      return cleaned;
    }

    const sentenceEnd = cleaned.search(/[.!?](?=\s|$)/);
    if (sentenceEnd !== -1 && sentenceEnd + 1 <= maxChars) {
      return cleaned.slice(0, sentenceEnd + 1);
    }

    const clipped = cleaned.slice(0, maxChars);
    const lastSpace = clipped.lastIndexOf(" ");
    return (lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + "...";
  }

  private simpleResponse(text: string, speechText?: string): EngineResult {
    return {
      text,
      speechText: speechText ?? text,
      state: this.getState(),
      shouldSpeak: true
    };
  }
}
