// Small helpers shared by the engine.

/** dst.push(...src) without the argument limit: spreading a few hundred thousand items overflows the call stack. */
export function pushAll<T>(dst: T[], src: ArrayLike<T>): T[] {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
  return dst;
}

/** Number of lines in a chunk of G-code text (1 + number of newlines), without allocating a split array. */
export function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Joins lines in blocks so no intermediate array or string grows past what the engine can hold, and turns the
 * engine's "Invalid string length" (a G-code file beyond ~512 MB) into a message that says what to change.
 */
export function joinLines(lines: string[], numbered = false): string {
  try {
    const blocks: string[] = [];
    let nLine = 0;
    const BLOCK = 100_000;
    for (let s = 0; s < lines.length; s += BLOCK) {
      let part = lines.slice(s, Math.min(lines.length, s + BLOCK));
      if (numbered) part = part.map((chunk) => chunk.split('\n').map((l) => (/^\s*($|;)/.test(l) ? l : `N${++nLine} ${l}`) /* blank / comment-only lines (indented ones too) get no number */).join('\n'));
      blocks.push(part.join('\n'));
    }
    let out = '';
    for (const b of blocks) out = out ? `${out}\n${b}` : b;
    return `${out}\n`;
  } catch (e) {
    if (e instanceof RangeError) throw new Error('The G-code is larger than the 512 MB a single file can hold here. Raise the Resolution (Quality › Precision), use a bigger layer height or split the plate into smaller prints.');
    throw e;
  }
}

type TypedCtor<A> = { new (n: number): A & { set(a: ArrayLike<number>, o?: number): void; subarray(a: number, b: number): A } };
/** Growing typed array: values go into fixed blocks, so millions of moves do not build a multi-hundred-MB JS array of doubles. */
export class TypedBuilder<A extends Float32Array | Uint8Array | Uint32Array> {
  private blocks: A[] = [];
  private cur: A;
  private at = 0;
  length = 0;
  constructor(private ctor: TypedCtor<A>, private block = 1 << 18) { this.cur = new ctor(block); }
  push(...v: number[]) {
    for (let i = 0; i < v.length; i++) {
      if (this.at === this.block) { this.blocks.push(this.cur); this.cur = new this.ctor(this.block); this.at = 0; }
      this.cur[this.at++] = v[i];
    }
    this.length += v.length;
  }
  toTyped(): A {
    const out = new this.ctor(this.length);
    let o = 0;
    for (const b of this.blocks) { out.set(b, o); o += b.length; }
    out.set(this.cur.subarray(0, this.at), o);
    return out;
  }
}
