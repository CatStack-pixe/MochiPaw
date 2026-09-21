/**
 * 通用文件加载工具
 * 替代 ToolManager.loadFileAsBytes 的静态方法
 */
export class FileLoader {
  static async loadArrayBuffer(filePath: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    signal?.throwIfAborted()
    const response = await fetch(filePath, { signal })

    if (!response.ok) {
      throw new Error(`Failed to load ${filePath}: HTTP ${response.status}`)
    }

    const buffer = await response.arrayBuffer()
    signal?.throwIfAborted()
    return buffer
  }

  static async loadJson(filePath: string): Promise<any> {
    const response = await fetch(filePath)
    return response.json()
  }

  static loadArrayBufferCallback(
    filePath: string,
    callback: (arrayBuffer: ArrayBuffer, size: number) => void,
  ): void {
    fetch(filePath)
      .then(response => response.arrayBuffer())
      .then(arrayBuffer => callback(arrayBuffer, arrayBuffer.byteLength))
  }

  /**
   * Load a checked response and propagate failures to the resource owner.
   */
  static async fetchSafe(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.loadArrayBuffer(url, signal)
  }
}
