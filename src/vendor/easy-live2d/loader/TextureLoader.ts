import type { WebGLBackend } from '../rendering/WebGLBackend'
import { Config } from '../utils/config'

/**
 * 纹理信息
 */
export class TextureInfo {
  img: HTMLImageElement | null = null
  id: WebGLTexture = null!
  width = 0
  height = 0
  usePremultiply = false
  fileName = ''
}

/**
 * 纹理加载器
 * 负责 PNG 纹理的加载、WebGL 纹理创建和缓存管理
 */
export class TextureLoader {
  private _textures: TextureInfo[] = []
  private _pending = new Set<() => void>()
  private _released = false
  private _webgl: WebGLBackend

  constructor(webgl: WebGLBackend) {
    this._webgl = webgl
  }

  createTextureFromPngFile(
    fileName: string,
    usePremultiply: boolean,
    callback: (textureInfo: TextureInfo) => void,
    onError?: (error: Error) => void,
  ): void {
    if (this._released) {
      onError?.(new DOMException('Texture loader released', 'AbortError'))
      return
    }
    // 搜索已加载的纹理缓存
    const cached = this._textures.find(
      t => t.fileName === fileName && t.usePremultiply === usePremultiply,
    )
    if (cached) {
      callback(cached)
      return
    }

    const img = new Image()
    let settled = false
    const cleanup = () => {
      settled = true
      img.onload = null
      img.onerror = null
      img.removeAttribute('src')
      this._pending.delete(cancel)
    }
    const cancel = () => {
      if (settled) return
      cleanup()
      onError?.(new DOMException('Texture load cancelled', 'AbortError'))
    }
    this._pending.add(cancel)
    // 设置 crossOrigin 必须在 src 之前，以避免 WebGL 纹理上传时触发 SecurityError
    if (Config.crossOrigin !== undefined)
      img.crossOrigin = Config.crossOrigin
    img.onload = () => {
      if (settled || this._released) return
      try {
        const textureInfo = this.createGlTexture(img, fileName, usePremultiply)
        cleanup()
        callback(textureInfo)
      } catch (error) {
        cleanup()
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
    img.onerror = () => {
      if (settled) return
      cleanup()
      onError?.(new Error(`Failed to load texture ${fileName}`))
    }
    img.src = fileName
  }

  private createGlTexture(
    img: HTMLImageElement,
    fileName: string,
    usePremultiply: boolean,
  ): TextureInfo {
    const gl = this._webgl.getGl()
    const tex = gl.createTexture()
    if (!tex) throw new Error(`Failed to allocate texture ${fileName}`)

    try {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, usePremultiply ? 1 : 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.generateMipmap(gl.TEXTURE_2D)
    } catch (error) {
      gl.deleteTexture(tex)
      throw error
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null)
    }

    const textureInfo = new TextureInfo()
    textureInfo.fileName = fileName
    textureInfo.width = img.width
    textureInfo.height = img.height
    textureInfo.id = tex
    // Upload is synchronous; retaining the decoded source duplicates texture data.
    // Keep img null for compatibility with TextureInfo consumers.
    textureInfo.usePremultiply = usePremultiply
    this._textures.push(textureInfo)

    return textureInfo
  }

  releaseTextures(): void {
    for (const cancel of this._pending) cancel()
    const gl = this._webgl.getGl()
    for (const tex of this._textures) {
      gl.deleteTexture(tex.id)
    }
    this._textures = []
  }

  releaseTextureByTexture(texture: WebGLTexture): void {
    const gl = this._webgl.getGl()
    const idx = this._textures.findIndex(t => t.id === texture)
    if (idx !== -1) {
      gl.deleteTexture(this._textures[idx].id)
      this._textures.splice(idx, 1)
    }
  }

  releaseTextureByFilePath(fileName: string): void {
    const gl = this._webgl.getGl()
    const idx = this._textures.findIndex(t => t.fileName === fileName)
    if (idx !== -1) {
      gl.deleteTexture(this._textures[idx].id)
      this._textures.splice(idx, 1)
    }
  }

  release(): void {
    this._released = true
    this.releaseTextures()
  }
}
