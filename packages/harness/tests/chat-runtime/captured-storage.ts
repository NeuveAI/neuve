import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { context } from "./fixture.ts";

export class CapturedStorage extends MemoryStorage {
  readonly commits: (readonly StorageWrite[])[] = [];
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    const seq = await super.commit(...args);
    this.commits.push(structuredClone(args[0]));
    return seq;
  }
  async snapshot() {
    const copy = new MemoryStorage();
    for (const writes of [...this.commits]) await copy.commit(writes, context);
    return copy;
  }
}
