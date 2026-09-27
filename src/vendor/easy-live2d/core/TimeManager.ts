/**
 * 时间管理器
 * 每个 Live2DSprite 实例持有独立的 TimeManager，替代 ToolManager 的静态状态
 */
export class TimeManager {
  private lastFrame: number | null = null
  private _deltaTime = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  get deltaTime(): number {
    return this._deltaTime
  }

  update(): void {
    const currentFrame = this.now()
    // Do not simulate hidden time or feed a long stalled frame into physics.
    this._deltaTime = this.lastFrame === null
      ? 0
      : Math.max(0, Math.min(0.1, (currentFrame - this.lastFrame) / 1000))
    this.lastFrame = currentFrame
  }

  reset(): void {
    this.lastFrame = null
    this._deltaTime = 0
  }
}
