/**
 * WebGL 后端
 * 管理 WebGL 上下文的获取和释放
 */
export class WebGLBackend {
  private _gl: WebGLRenderingContext | WebGL2RenderingContext | null = null

  initialize(
    canvas: HTMLCanvasElement,
    context?: WebGLRenderingContext | WebGL2RenderingContext | null,
  ): boolean {
    this._gl = context ?? canvas.getContext('webgl2')
    if (!this._gl) {
      this._gl = null
      return false
    }

    if (typeof WebGL2RenderingContext === 'undefined' || !(this._gl instanceof WebGL2RenderingContext)) {
      this._gl = null
      return false
    }

    return true
  }

  getGl(): WebGLRenderingContext | WebGL2RenderingContext {
    return this._gl!
  }

  setupBlend(): void {
    const gl = this._gl!
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  getFrameBuffer(): WebGLFramebuffer | null {
    const gl = this._gl!
    return gl.getParameter(gl.FRAMEBUFFER_BINDING)
  }

  release(): void {
    this._gl = null
  }
}
