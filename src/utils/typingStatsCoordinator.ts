// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export class TypingStatsOperationCoordinator<TInput> {
  private inputPauseTokens = new Set<string>()
  private pausedInputs: TInput[] = []
  private queue = Promise.resolve()

  run<TResult>(operation: () => TResult | Promise<TResult>) {
    const result = this.queue
      .catch(() => undefined)
      .then(operation)

    this.queue = result.then(() => undefined, () => undefined)

    return result
  }

  record(input: TInput, apply: (input: TInput) => void) {
    void this.run(() => {
      if (this.inputPauseTokens.size > 0) {
        this.pausedInputs.push(input)
        return
      }

      apply(input)
    })
  }

  pauseInputs(token: string) {
    this.inputPauseTokens.add(token)
  }

  resumeInputs(token: string, apply: (input: TInput) => void) {
    this.inputPauseTokens.delete(token)

    if (this.inputPauseTokens.size > 0) return 0

    const inputs = this.pausedInputs.splice(0)

    for (const input of inputs) apply(input)

    return inputs.length
  }
}
