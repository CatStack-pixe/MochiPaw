export class csmVector<T> {
  private readonly _items: T[] = []

  getSize(): number {
    return this._items.length
  }

  at(index: number): T {
    return this._items[index]
  }

  pushBack(value: T): void {
    this._items.push(value)
  }

  toArray(): T[] {
    return [...this._items]
  }

  clear(): void {
    this._items.length = 0
  }
}
