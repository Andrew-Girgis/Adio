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
        state: this.getState(),
        shouldSpeak: true
      };
    }

    this.status = "awaiting_confirmation";
    this.awaitingConfirmation = true;
    return this.renderCurrentStep("Starting procedure.");
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
      case "stop":
        this.status = "paused";
        this.awaitingConfirmation = false;
        return {
          text: `Paused at step ${this.currentStepIndex + 1}. Say resume when you are ready.`,
          state: this.getState(),
          shouldSpeak: true
        };

      case "resume":
        if (this.status !== "paused") {
          return {
            text: "I am already active. Say repeat if you want the current step again.",
            state: this.getState(),
            shouldSpeak: true
          };
        }
        this.status = "awaiting_confirmation";
        this.awaitingConfirmation = true;
        return this.renderCurrentStep("Resuming.");

      case "repeat":
        return this.renderCurrentStep("Repeating current step.");

      case "explain":
        if (!step) {
          return this.simpleResponse("No active step to explain.");
        }
        return this.simpleResponse(step.explanation ?? "This step reduces risk and keeps diagnosis accurate before moving on.");

      case "safety_check":
        if (!step) {
          return this.simpleResponse("No active step for safety check.");
        }
        return this.simpleResponse(
          step.safetyNotes ??
            "Wear gloves, power down equipment before opening panels, and stop if you detect burning smells or fluid leaks."
        );

      case "skip":
        if (!step) {
          return this.simpleResponse("No remaining step to skip.");
        }
        if (step.safetyCritical) {
          this.skipNeedsConfirmation = true;
          return this.simpleResponse(
            "This is a safety-critical step. Say skip confirm to proceed, or say repeat to hear it again."
          );
        }
        return this.advanceStep(true);

      case "skip_confirm":
        if (!this.skipNeedsConfirmation) {
          return this.simpleResponse("No skip confirmation is pending.");
        }
        return this.advanceStep(true);

      case "confirm":
        if (this.status === "paused") {
          return this.simpleResponse("You are paused. Say resume first.");
        }
        return this.advanceStep(false);

      default:
        return this.simpleResponse("I did not catch that command. Try stop, resume, repeat, skip, explain, or safety check.");
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
        ? "Skipped the final step. Procedure complete. Run a safety check before testing the appliance."
        : "Great work. Procedure complete. Run a quick safety check, then test the appliance.";
      return this.simpleResponse(ending);
    }

    this.status = "awaiting_confirmation";
    this.awaitingConfirmation = true;
    const prefix = skipped ? "Step skipped." : "Confirmed.";
    return this.renderCurrentStep(prefix);
  }

  private renderCurrentStep(prefix?: string): EngineResult {
    const step = this.getCurrentStep();
    if (!step) {
      return this.simpleResponse("No active step.");
    }

    const stepNumber = this.currentStepIndex + 1;
    const total = this.procedure.steps.length;
    const safetyPreface = step.safetyCritical ? "Safety-critical. " : "";
    const confirmationPrompt =
      step.requiresConfirmation
        ? 'Say "confirm" when done, or say stop, repeat, explain, skip, or safety check.'
        : 'Say "confirm" to advance.';

    const composed = [
      prefix,
      `${safetyPreface}Step ${stepNumber} of ${total}: ${step.instruction}`,
      confirmationPrompt
    ]
      .filter(Boolean)
      .join(" ");

    return {
      text: composed,
      state: this.getState(),
      shouldSpeak: true
    };
  }

  private getCurrentStep(): ProcedureStep | undefined {
    return this.procedure.steps[this.currentStepIndex];
  }

  private simpleResponse(text: string): EngineResult {
    return {
      text,
      state: this.getState(),
      shouldSpeak: true
    };
  }
}
