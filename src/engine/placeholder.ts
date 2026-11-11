// Vendor G-code template engine: the placeholder language of PrusaSlicer / OrcaSlicer / Bambu Studio /
// Snapmaker Orca, so the printer makers' own start, end, filament-change and layer G-code run unchanged.
//
//   [name] [name_3] [name[expr]]          legacy variable (element 3 / expr of a vector)
//   {expr}                                expression, printed
//   {if expr}…{elsif expr}…{else}…{endif} conditional text
//   { statements }                        macro block: local / global x = …; x = …; v[i] = …;
//                                         if … then … elsif … then … else … endif; an expression
//                                         statement prints its value
// Types follow the C++ engine: int, double, bool, string and vectors. int (op) int stays int (24/20 = 1);
// doubles print like C++ std::ostream (6 significant digits, no trailing zeros). An unknown variable is an
// error: a template is never printed with a guessed value.

export type PPValue = number | string | boolean | PPValue[];

/** Variables for a template. Numbers are doubles unless their name is in `ints` (or they come from an int literal). */
export interface PPContext {
  vars: Record<string, PPValue | undefined>;
  /** Names whose numbers are integers (layer_num, next_extruder, temperatures…). */
  ints?: Set<string>;
}

export class PlaceholderError extends Error {}

type V = { t: 'int' | 'double' | 'bool' | 'string'; v: number | string | boolean } | { t: 'vector'; v: PPValue[]; int: boolean };

const ival = (n: number): V => ({ t: 'int', v: Math.trunc(n) });
const dval = (n: number): V => ({ t: 'double', v: n });
const bval = (b: boolean): V => ({ t: 'bool', v: b });
const sval = (s: string): V => ({ t: 'string', v: s });

/** C++ std::ostream << double (precision 6, %g). */
export function fmtDouble(d: number): string {
  if (!isFinite(d)) return d > 0 ? 'inf' : d < 0 ? '-inf' : 'nan';
  if (d === 0) return Object.is(d, -0) ? '-0' : '0';
  const exp = Math.floor(Math.log10(Math.abs(Number(d.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = d.toExponential(5).split('e');
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    const en = Number(e);
    return `${mant}e${en < 0 ? '-' : '+'}${String(Math.abs(en)).padStart(2, '0')}`;
  }
  const s = d.toFixed(Math.max(0, 5 - exp));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function str(x: V): string {
  switch (x.t) {
    case 'int': return String(x.v);
    case 'double': return fmtDouble(x.v as number);
    case 'bool': return x.v ? 'true' : 'false';
    case 'string': return x.v as string;
    default: return x.v.map((e) => (typeof e === 'number' ? (x.int ? String(Math.trunc(e)) : fmtDouble(e)) : String(e))).join(',');
  }
}
const num = (x: V, what: string): number => {
  if (x.t === 'int' || x.t === 'double') return x.v as number;
  if (x.t === 'bool') return x.v ? 1 : 0;
  throw new PlaceholderError(`${what}: expected a number, got ${x.t} "${str(x)}"`);
};
const truthy = (x: V): boolean => {
  if (x.t === 'bool') return x.v as boolean;
  if (x.t === 'int' || x.t === 'double') return (x.v as number) !== 0;
  throw new PlaceholderError(`expected a boolean, got ${x.t} "${str(x)}"`);
};

// ---------------------------------------------------------------- lexer (macro / expression text)
type Tok = { k: 'num'; v: string } | { k: 'str'; v: string } | { k: 're'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string } | { k: 'end' };
const OPS = ['&&', '||', '==', '!=', '<>', '<=', '>=', '=~', '!~', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', '[', ']', ',', ';', '=', '?', ':'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== '"') throw new PlaceholderError('unterminated string');
      i++;
      out.push({ k: 'str', v: s });
      continue;
    }
    const nm = /^(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (nm) { out.push({ k: 'num', v: nm[0] }); i += nm[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ k: 'op', v: op });
      i += op.length;
      if (op === '=~' || op === '!~') {
        // a regular expression literal: /…/
        while (/\s/.test(src[i] ?? '')) i++;
        if (src[i] === '/') {
          let r = '';
          i++;
          while (i < src.length && src[i] !== '/') { if (src[i] === '\\' && i + 1 < src.length) { r += src[i] + src[i + 1]; i += 2; } else r += src[i++]; }
          if (src[i] !== '/') throw new PlaceholderError('unterminated regular expression');
          i++;
          out.push({ k: 're', v: r });
        }
      }
      continue;
    }
    throw new PlaceholderError(`unexpected character "${c}"`);
  }
  out.push({ k: 'end' });
  return out;
}

// ---------------------------------------------------------------- evaluator
class Machine {
  locals = new Map<string, V>();
  constructor(private ctx: PPContext) {}

  lookup(name: string): V {
    if (this.locals.has(name)) return this.locals.get(name)!;
    const v = this.ctx.vars[name];
    if (v === undefined) throw new PlaceholderError(`unknown variable "${name}"`);
    return this.wrap(name, v);
  }
  currentExtruder(): number { const c = this.has('current_extruder') ? this.lookup('current_extruder') : ival(0); return c.t === 'int' || c.t === 'double' ? (c.v as number) : 0; }
  has(name: string) { return this.locals.has(name) || this.ctx.vars[name] !== undefined; }
  wrap(name: string, v: PPValue): V {
    if (Array.isArray(v)) return { t: 'vector', v, int: !!this.ctx.ints?.has(name) };
    if (typeof v === 'number') return this.ctx.ints?.has(name) ? ival(v) : dval(v);
    if (typeof v === 'boolean') return bval(v);
    return sval(v);
  }
  element(name: string, vec: V, idx: number): V {
    if (vec.t !== 'vector') throw new PlaceholderError(`"${name}" is not a vector`);
    const k = Math.trunc(idx);
    // like the C++ engine, a vector shorter than the index repeats its first element (one value for all extruders)
    const e = vec.v.length === 1 ? vec.v[0] : vec.v[k];
    if (e === undefined) throw new PlaceholderError(`"${name}[${k}]" is out of range (${vec.v.length} values)`);
    if (typeof e === 'number') return vec.int ? ival(e) : dval(e);
    if (typeof e === 'boolean') return bval(e);
    return sval(String(e));
  }
  assign(name: string, v: V, local: boolean) {
    if (local || this.locals.has(name) || !(name in this.ctx.vars)) { this.locals.set(name, v); return; }
    this.ctx.vars[name] = v.t === 'vector' ? v.v : (v.v as PPValue);
    if (v.t === 'int') (this.ctx.ints ??= new Set()).add(name);
  }
  assignElement(name: string, idx: number, v: V) {
    const cur = this.lookup(name);
    if (cur.t !== 'vector') throw new PlaceholderError(`"${name}" is not a vector`);
    const arr = cur.v.slice();
    arr[Math.trunc(idx)] = v.t === 'vector' ? str(v) : (v.v as PPValue);
    this.assign(name, { t: 'vector', v: arr, int: cur.int && v.t === 'int' }, false);
  }
}

class Parser {
  p = 0;
  constructor(private toks: Tok[], private m: Machine, private exec = true) {}
  peek(o = 0) { return this.toks[this.p + o]; }
  isOp(v: string, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  isKw(v: string, o = 0) { const t = this.peek(o); return t.k === 'id' && t.v === v; }
  eat(v: string) { if (!this.isOp(v) && !this.isKw(v)) throw new PlaceholderError(`expected "${v}"`); this.p++; }

  // statements until end / elsif / else / endif; returns printed text
  statements(): string {
    let out = '';
    for (;;) {
      while (this.isOp(';')) this.p++;
      const t = this.peek();
      if (t.k === 'end' || this.isKw('elsif') || this.isKw('else') || this.isKw('endif')) return out;
      out += this.statement();
    }
  }
  statement(): string {
    if (this.isKw('local') || this.isKw('global')) {
      const local = this.isKw('local');
      this.p++;
      const id = this.peek();
      if (id.k !== 'id') throw new PlaceholderError('expected a variable name');
      this.p++;
      this.eat('=');
      const v = this.expr();
      if (this.exec) this.m.assign(id.v, v, local);
      return '';
    }
    if (this.isKw('if')) return this.ifStatement();
    const t = this.peek();
    if (t.k === 'id' && this.isOp('=', 1)) {
      this.p += 2;
      const v = this.expr();
      if (this.exec) this.m.assign(t.v, v, false);
      return '';
    }
    if (t.k === 'id' && this.isOp('[', 1)) {
      // v[i] = … (look ahead for the matching ] followed by =)
      let d = 0, q = this.p + 1;
      for (; q < this.toks.length; q++) {
        const k = this.toks[q];
        if (k.k === 'op' && k.v === '[') d++;
        else if (k.k === 'op' && k.v === ']' && --d === 0) break;
      }
      const after = this.toks[q + 1];
      if (after?.k === 'op' && after.v === '=') {
        this.p += 2;
        const idx = this.expr();
        this.eat(']');
        this.eat('=');
        const v = this.expr();
        if (this.exec) this.m.assignElement(t.v, num(idx, 'index'), v);
        return '';
      }
    }
    const v = this.expr();
    return this.exec ? str(v) : '';
  }
  ifStatement(): string {
    let out = '';
    let done = false;
    this.eat('if');
    const outer = this.exec;
    for (;;) {
      const c = this.expr();
      this.eat('then');
      const take = outer && !done && truthy(c);
      this.exec = take;
      const s = this.statements();
      if (take) { out = s; done = true; }
      if (this.isKw('elsif')) { this.p++; this.exec = outer; continue; }
      if (this.isKw('else')) {
        this.p++;
        this.exec = outer && !done;
        const e = this.statements();
        if (this.exec) out = e;
      }
      this.exec = outer;
      this.eat('endif');
      return out;
    }
  }

  // expression precedence: ?: < or < and < equality/relational < additive < multiplicative < unary
  expr(): V {
    const c = this.or();
    if (this.isOp('?')) {
      this.p++;
      const a = this.expr();
      this.eat(':');
      const b = this.expr();
      return this.exec ? (truthy(c) ? a : b) : a;
    }
    return c;
  }
  or(): V {
    let a = this.and();
    while (this.isOp('||') || this.isKw('or')) { this.p++; const b = this.and(); if (this.exec) a = bval(truthy(a) || truthy(b)); }
    return a;
  }
  and(): V {
    let a = this.cmp();
    while (this.isOp('&&') || this.isKw('and')) { this.p++; const b = this.cmp(); if (this.exec) a = bval(truthy(a) && truthy(b)); }
    return a;
  }
  cmp(): V {
    let a = this.add();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'op' || !['==', '!=', '<>', '<', '>', '<=', '>=', '=~', '!~'].includes(t.v)) return a;
      this.p++;
      if (t.v === '=~' || t.v === '!~') {
        // regex match of the whole string (boost::regex_match, as in the C++ engine)
        const re = this.peek();
        let pat: string;
        if (re.k === 're' || re.k === 'str') { this.p++; pat = re.v; } else pat = str(this.add());
        if (this.exec) { const hit = new RegExp(`^(?:${pat})$`, 's').test(str(a)); a = bval(t.v === '=~' ? hit : !hit); }
        continue;
      }
      const b = this.add();
      if (!this.exec) continue;
      const strs = a.t === 'string' || b.t === 'string';
      let r: boolean;
      if (strs) {
        const x = str(a), y = str(b);
        r = t.v === '==' ? x === y : t.v === '!=' || t.v === '<>' ? x !== y : t.v === '<' ? x < y : t.v === '>' ? x > y : t.v === '<=' ? x <= y : x >= y;
      } else {
        const x = num(a, t.v), y = num(b, t.v);
        r = t.v === '==' ? x === y : t.v === '!=' || t.v === '<>' ? x !== y : t.v === '<' ? x < y : t.v === '>' ? x > y : t.v === '<=' ? x <= y : x >= y;
      }
      a = bval(r);
    }
  }
  add(): V {
    let a = this.mul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.peek() as { v: string };
      this.p++;
      const b = this.mul();
      if (!this.exec) continue;
      if (op.v === '+' && (a.t === 'string' || b.t === 'string')) { a = sval(str(a) + str(b)); continue; }
      const x = num(a, op.v), y = num(b, op.v);
      const r = op.v === '+' ? x + y : x - y;
      a = a.t === 'int' && b.t === 'int' ? ival(r) : dval(r);
    }
    return a;
  }
  mul(): V {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.peek() as { v: string }).v;
      this.p++;
      const b = this.unary();
      if (!this.exec) continue;
      const x = num(a, op), y = num(b, op);
      const ints = a.t === 'int' && b.t === 'int';
      if ((op === '/' || op === '%') && y === 0) throw new PlaceholderError('division by zero');
      if (op === '*') a = ints ? ival(x * y) : dval(x * y);
      else if (op === '/') a = ints ? ival(Math.trunc(x / y)) : dval(x / y);
      else a = ints ? ival(x % y) : dval(x % y);
    }
    return a;
  }
  unary(): V {
    if (this.isOp('-')) { this.p++; const v = this.unary(); return this.exec ? (v.t === 'int' ? ival(-(v.v as number)) : dval(-num(v, '-'))) : v; }
    if (this.isOp('+')) { this.p++; return this.unary(); }
    if (this.isOp('!') || this.isKw('not')) { this.p++; const v = this.unary(); return this.exec ? bval(!truthy(v)) : v; }
    return this.factor();
  }
  args(): V[] {
    this.eat('(');
    const out: V[] = [];
    if (!this.isOp(')')) { out.push(this.expr()); while (this.isOp(',')) { this.p++; out.push(this.expr()); } }
    this.eat(')');
    return out;
  }
  factor(): V {
    const t = this.peek();
    if (t.k === 'num') { this.p++; return /[.eE]/.test(t.v) ? dval(Number(t.v)) : ival(Number(t.v)); }
    if (t.k === 'str') { this.p++; return sval(t.v); }
    if (this.isOp('(')) { this.p++; const v = this.expr(); this.eat(')'); return v; }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') { this.p++; return bval(t.v === 'true'); }
      if (this.isOp('(', 1)) {
        this.p++;
        if (t.v === 'is_nil' || t.v === 'empty') {
          // the argument is a variable reference that may be missing
          this.eat('(');
          const id = this.peek();
          this.p++;
          let missing = id.k !== 'id' || !this.m.has(id.v);
          if (this.isOp('[')) { this.p++; this.expr(); this.eat(']'); }
          this.eat(')');
          if (!missing && t.v === 'empty' && id.k === 'id') { const v = this.m.lookup(id.v); missing = v.t === 'vector' ? v.v.length === 0 : str(v) === ''; }
          return bval(missing);
        }
        if (t.v === 'interpolate_table') {
          // interpolate_table(x, (x0, y0), (x1, y1), …): linear between the points, clamped at the ends
          this.eat('(');
          const x = this.expr();
          const pts: [number, number][] = [];
          while (this.isOp(',')) {
            this.p++;
            this.eat('(');
            const px = this.expr(); this.eat(','); const py = this.expr();
            this.eat(')');
            if (this.exec) pts.push([num(px, 'interpolate_table'), num(py, 'interpolate_table')]);
          }
          this.eat(')');
          if (!this.exec) return dval(0);
          const xv = num(x, 'interpolate_table');
          if (!pts.length) throw new PlaceholderError('interpolate_table: no points');
          pts.sort((p, q) => p[0] - q[0]);
          if (xv <= pts[0][0]) return dval(pts[0][1]);
          for (let k = 1; k < pts.length; k++) {
            const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
            if (xv <= x1) return dval(x1 === x0 ? y1 : y0 + ((y1 - y0) * (xv - x0)) / (x1 - x0));
          }
          return dval(pts[pts.length - 1][1]);
        }
        if (t.v === 'size') {
          this.eat('(');
          const id = this.peek();
          this.p++;
          this.eat(')');
          if (!this.exec) return ival(0);
          const v = id.k === 'id' ? this.m.lookup(id.v) : ival(0);
          return ival(v.t === 'vector' ? v.v.length : 1);
        }
        const a = this.args();
        if (!this.exec) return ival(0);
        const n = (k: number) => num(a[k], t.v);
        switch (t.v) {
          case 'min': case 'max': {
            const ints = a[0].t === 'int' && a[1].t === 'int';
            const r = t.v === 'min' ? Math.min(n(0), n(1)) : Math.max(n(0), n(1));
            return ints ? ival(r) : dval(r);
          }
          case 'int': return ival(Math.trunc(n(0)));
          case 'round': return ival(Math.round(n(0)));
          case 'ceil': return ival(Math.ceil(n(0)));
          case 'floor': return ival(Math.floor(n(0)));
          case 'digits': case 'zdigits': {
            const width = Math.trunc(n(1)), prec = a[2] ? Math.trunc(n(2)) : 0;
            const s = n(0).toFixed(prec);
            return sval(t.v === 'zdigits' ? s.padStart(width, '0') : s.padStart(width, ' '));
          }
          case 'one_of': return bval(a.slice(1).some((x) => str(x) === str(a[0])));
          default: throw new PlaceholderError(`unknown function "${t.v}"`);
        }
      }
      this.p++;
      if (!this.exec && !this.m.has(t.v)) { if (this.isOp('[')) { this.p++; this.expr(); this.eat(']'); } return ival(0); }
      const v = this.m.lookup(t.v);
      if (this.isOp('[')) {
        this.p++;
        const idx = this.expr();
        this.eat(']');
        return this.exec ? this.m.element(t.v, v, num(idx, 'index')) : ival(0);
      }
      // a vector without an index stands for the current extruder's value (as in the C++ engine)
      return v.t === 'vector' ? this.m.element(t.v, v, this.m.currentExtruder()) : v;
    }
    throw new PlaceholderError(`unexpected "${t.k === 'op' ? t.v : t.k}"`);
  }
}

// ---------------------------------------------------------------- template text: text, [legacy], {blocks}
type Piece = { k: 'text'; v: string } | { k: 'legacy'; name: string; raw: string } | { k: 'block'; v: string };

function split(tpl: string): Piece[] {
  const out: Piece[] = [];
  let i = 0, text = '';
  const flush = () => { if (text) { out.push({ k: 'text', v: text }); text = ''; } };
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === '[') {
      const m = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(tpl.slice(i));
      if (m) { flush(); out.push({ k: 'legacy', name: m[1], raw: m[0] }); i += m[0].length; continue; }
      // [name[index]]: element of a vector (legacy form with an expression index)
      const mi = /^\[([A-Za-z_][A-Za-z0-9_]*)\[([^\[\]{}]+)\]\]/.exec(tpl.slice(i));
      if (mi) { flush(); out.push({ k: 'block', v: `${mi[1]}[${mi[2]}]` }); i += mi[0].length; continue; }
    }
    if (c === '{') {
      // the matching brace, skipping string literals and nested braces
      let d = 0, j = i, inStr = false;
      for (; j < tpl.length; j++) {
        const ch = tpl[j];
        if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') d++;
        else if (ch === '}' && --d === 0) break;
      }
      if (j >= tpl.length) throw new PlaceholderError('a "{" is not closed');
      flush();
      out.push({ k: 'block', v: tpl.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const headKw = (b: string) => /^\s*(if|elsif|else|endif)\b/.exec(b)?.[1];
/** A `{if …}` text conditional (the macro statement form uses `then`). */
const isTextIf = (b: string) => headKw(b) !== undefined && !/\bthen\b/.test(b.replace(/"(?:\\.|[^"\\])*"/g, ''));

/** Expands a vendor template. Throws PlaceholderError (with the line) on a syntax error or unknown variable. */
export function renderTemplate(tpl: string, ctx: PPContext): string {
  const pieces = split(tpl);
  const m = new Machine(ctx);
  let p = 0;
  const run = (stopAt: Set<string>, emit: boolean): { out: string; stop?: string; cond?: string } => {
    let out = '';
    while (p < pieces.length) {
      const pc = pieces[p];
      if (pc.k === 'text') { if (emit) out += pc.v; p++; continue; }
      if (pc.k === 'legacy') {
        p++;
        if (!emit) continue;
        const lm = /^(.*)_(\d+)$/.exec(pc.name);
        if (m.has(pc.name)) out += str(m.lookup(pc.name).t === 'vector' ? m.element(pc.name, m.lookup(pc.name), m.currentExtruder()) : m.lookup(pc.name));
        else if (lm && m.has(lm[1]) && m.lookup(lm[1]).t === 'vector') out += str(m.element(lm[1], m.lookup(lm[1]), Number(lm[2])));
        else out += pc.raw; // not a variable: text such as "[mm]"
        continue;
      }
      const kw = isTextIf(pc.v) ? headKw(pc.v)! : undefined;
      if (kw && kw !== 'if') {
        if (stopAt.has(kw)) { p++; return { out, stop: kw, cond: pc.v.replace(/^\s*elsif\b/, '') }; }
        throw new PlaceholderError(`"{${kw}}" without "{if}"`);
      }
      p++;
      if (kw === 'if') {
        let cond = pc.v.replace(/^\s*if\b/, '');
        let done = false;
        const stops = new Set(['elsif', 'else', 'endif']);
        for (;;) {
          const take = emit && !done && truthy(evalExpr(cond, m, emit));
          const r = run(stops, take);
          if (take) { out += r.out; done = true; }
          if (!r.stop) throw new PlaceholderError('"{if}" without "{endif}"');
          if (r.stop === 'endif') break;
          if (r.stop === 'else') {
            const e = run(new Set(['endif']), emit && !done);
            if (emit && !done) out += e.out;
            if (e.stop !== 'endif') throw new PlaceholderError('"{else}" without "{endif}"');
            break;
          }
          cond = r.cond!;
        }
        continue;
      }
      if (emit) {
        const ps = new Parser(lex(pc.v), m);
        const o = ps.statements();
        if (ps.peek().k !== 'end') throw new PlaceholderError(`unexpected "${(ps.peek() as { v?: string }).v ?? ''}" in {${pc.v.trim().slice(0, 40)}}`);
        out += o;
      }
    }
    return { out };
  };
  try {
    const r = run(new Set(), true);
    if (r.stop) throw new PlaceholderError(`"{${r.stop}}" without "{if}"`);
    return r.out;
  } catch (e) {
    if (e instanceof PlaceholderError) throw new PlaceholderError(`${e.message}`);
    throw e;
  }
}

function evalExpr(src: string, m: Machine, exec: boolean): V {
  const ps = new Parser(lex(src), m, exec);
  const v = ps.expr();
  if (ps.peek().k !== 'end') throw new PlaceholderError(`unexpected text after the condition "${src.trim()}"`);
  return v;
}

/** C-style unescaping the slicers apply to G-code strings when they load a profile (\n, \", \\, \t, \r). */
export function unescapeCStyle(s: string): string {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}
