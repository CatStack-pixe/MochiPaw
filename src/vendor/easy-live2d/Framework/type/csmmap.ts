export interface csmPair<K, V> {
  first: K
  second: V
}

export class csmMapIterator<K, V> {
  constructor(
    private readonly _entries: csmPair<K, V>[],
    private _index: number,
  ) {}

  notEqual(other: csmMapIterator<K, V>): boolean {
    return this._index !== other._index
  }

  preIncrement(): csmMapIterator<K, V> {
    this._index += 1
    return this
  }

  ptr(): csmPair<K, V> {
    return this._entries[this._index]
  }
}

export class csmMap<K, V> {
  private readonly _values = new Map<K, V>()

  getSize(): number {
    return this._values.size
  }

  getValue(key: K): V | null {
    return this._values.has(key) ? this._values.get(key)! : null
  }

  setValue(key: K, value: V): void {
    this._values.set(key, value)
  }

  clear(): void {
    this._values.clear()
  }

  begin(): csmMapIterator<K, V> {
    return new csmMapIterator(this.entries(), 0)
  }

  end(): csmMapIterator<K, V> {
    const entries = this.entries()
    return new csmMapIterator(entries, entries.length)
  }

  private entries(): csmPair<K, V>[] {
    return [...this._values.entries()].map(([first, second]) => ({ first, second }))
  }
}
