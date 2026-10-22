// Audio and import UI (wired up once those pipelines land).
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export function extraAssetActions(_a: Any, _ctx: Any): Node[] {
  return [];
}
export const extraQaButtons: ((ctx: Any) => Node)[] = [];
export const importDialog: ((ctx: Any) => void) | undefined = undefined;
export const audioDialog: ((ctx: Any) => void) | undefined = undefined;
