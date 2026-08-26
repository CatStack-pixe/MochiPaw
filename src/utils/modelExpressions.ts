// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface ModelExpressionReference {
  Name?: string
  File?: string
}

export interface ModelExpressionDocument {
  FileReferences?: {
    Expressions?: ModelExpressionReference[]
  }
}

export interface ModelExpressionEntry {
  name: string
}

export function readExpressionsFromModelJSON(modelJSON: ModelExpressionDocument): ModelExpressionEntry[] {
  return (modelJSON.FileReferences?.Expressions ?? []).map((expression, index) => {
    return {
      name: expression.Name?.trim() || removeExpressionFileExtension(expression.File) || `Expression ${index + 1}`,
    }
  })
}

function removeExpressionFileExtension(file: string | undefined) {
  if (!file) return

  return file
    .replace(/\.exp3\.json$/i, '')
    .replace(/\.[^.]+$/, '')
}
