/** Indexed heap: admission, cancellation and removal each take O(log n). */
export class Heap<T> {
  private items: T[] = [];
  private indices = new Map<T, number>();
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size() {
    return this.items.length;
  }
  peek() {
    return this.items[0];
  }
  add(value: T) {
    this.indices.set(value, this.items.length);
    this.items.push(value);
    this.up(this.items.length - 1);
  }
  remove(value: T) {
    const index = this.indices.get(value);
    if (index === undefined) return;
    const last = this.items.pop();
    this.indices.delete(value);
    if (last !== undefined && last !== value) {
      this.items[index] = last;
      this.indices.set(last, index);
      this.up(index);
      this.down(this.indices.get(last) ?? index);
    }
  }
  private swap(a: number, b: number) {
    const x = this.items[a],
      y = this.items[b];
    if (x === undefined || y === undefined) return;
    this.items[a] = y;
    this.items[b] = x;
    this.indices.set(x, b);
    this.indices.set(y, a);
  }
  private up(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2),
        a = this.items[index],
        b = this.items[parent];
      if (a === undefined || b === undefined || this.compare(a, b) >= 0) break;
      this.swap(index, parent);
      index = parent;
    }
  }
  private down(index: number) {
    for (;;) {
      let child = index * 2 + 1;
      const left = this.items[child],
        right = this.items[child + 1],
        value = this.items[index];
      if (left === undefined || value === undefined) return;
      if (right !== undefined && this.compare(right, left) < 0) child++;
      const next = this.items[child];
      if (next === undefined || this.compare(next, value) >= 0) return;
      this.swap(index, child);
      index = child;
    }
  }
}
