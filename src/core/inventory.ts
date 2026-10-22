// Inventory. Uses the shared item schema; receives loot roller drops via
// itemPickedUp and announces every change with inventoryChanged.
import type { InventorySnapshot, Item, ItemInstance } from "./contracts";

export class Inventory {
  items: ItemInstance[] = [];
  equipped: { weapon?: ItemInstance; armor?: ItemInstance } = {};

  constructor(
    readonly capacity: number,
    private readonly lookup: (itemId: string) => Item,
    private readonly onChange: (snapshot: InventorySnapshot) => void,
  ) {}

  get full(): boolean {
    return this.items.length >= this.capacity;
  }

  add(item: ItemInstance): boolean {
    if (this.full) return false;
    this.items.push(item);
    this.changed();
    return true;
  }

  remove(uid: string): ItemInstance | undefined {
    const i = this.items.findIndex((it) => it.uid === uid);
    if (i < 0) return undefined;
    const [removed] = this.items.splice(i, 1);
    this.changed();
    return removed;
  }

  /** Equips a weapon or armor from the bag; the old one goes back into the bag. */
  equip(uid: string): boolean {
    const inst = this.items.find((it) => it.uid === uid);
    if (!inst) return false;
    const kind = this.lookup(inst.itemId).kind;
    if (kind !== "weapon" && kind !== "armor") return false;
    this.items = this.items.filter((it) => it.uid !== uid);
    const old = this.equipped[kind];
    if (old) this.items.push(old);
    this.equipped[kind] = inst;
    this.changed();
    return true;
  }

  snapshot(): InventorySnapshot {
    return { items: [...this.items], equipped: { ...this.equipped }, capacity: this.capacity };
  }

  private changed() {
    this.onChange(this.snapshot());
  }
}
