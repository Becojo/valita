// This is magic that turns object intersections to nicer-looking types.
type PrettyIntersection<V> = Extract<{ [K in keyof V]: V[K] }, unknown>;

type Literal = string | number | bigint | boolean;
type Key = string | number;
type BaseType =
  | "object"
  | "array"
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "bigint"
  | "boolean";

const Nothing: unique symbol = Symbol();
type Nothing = typeof Nothing;

type I<Code, Extra = unknown> = Readonly<
  PrettyIntersection<
    Extra & {
      code: Code;
      path?: Key[];
    }
  >
>;

type CustomError =
  | undefined
  | string
  | {
      message?: string;
      path?: Key[];
    };

type Issue =
  | I<"invalid_type", { expected: BaseType[] }>
  | I<"invalid_literal", { expected: Literal[] }>
  | I<"missing_key", { key: Key }>
  | I<"unrecognized_key", { key: Key }>
  | I<"invalid_union", { tree: IssueTree }>
  | I<"custom_error", { error: CustomError }>;

type IssueTree =
  | Readonly<{ code: "prepend"; key: Key; tree: IssueTree }>
  | Readonly<{ code: "join"; left: IssueTree; right: IssueTree }>
  | Issue;

function _collectIssues(tree: IssueTree, path: Key[], issues: Issue[]): void {
  if (tree.code === "join") {
    _collectIssues(tree.left, path, issues);
    _collectIssues(tree.right, path, issues);
  } else if (tree.code === "prepend") {
    path.push(tree.key);
    _collectIssues(tree.tree, path, issues);
    path.pop();
  } else {
    const finalPath = path.slice();
    if (tree.path) {
      finalPath.push(...tree.path);
    }
    if (
      tree.code === "custom_error" &&
      typeof tree.error !== "string" &&
      tree.error?.path
    ) {
      finalPath.push(...tree.error.path);
    }
    issues.push({ ...tree, path: finalPath });
  }
}

function collectIssues(tree: IssueTree): Issue[] {
  const issues: Issue[] = [];
  const path: Key[] = [];
  _collectIssues(tree, path, issues);
  return issues;
}

function orList(list: string[]): string {
  if (list.length === 0) {
    return "nothing";
  }
  const last = list[list.length - 1];
  if (list.length < 2) {
    return last;
  }
  return `${list.slice(0, -1).join(", ")} or ${last}`;
}

function formatLiteral(value: Literal): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
}

export class ValitaError extends Error {
  constructor(private readonly issueTree: IssueTree) {
    super();
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }

  get issues(): readonly Issue[] {
    const issues = collectIssues(this.issueTree);
    Object.defineProperty(this, "issues", {
      value: issues,
      writable: false,
    });
    return issues;
  }

  get message(): string {
    const issue = this.issues[0];
    const path = issue.path || [];

    let message = "validation failed";
    if (issue.code === "invalid_type") {
      message = `expected ${orList(issue.expected)}`;
    } else if (issue.code === "invalid_literal") {
      message = `expected ${orList(issue.expected.map(formatLiteral))}`;
    } else if (issue.code === "missing_key") {
      message = `missing key ${formatLiteral(issue.key)}`;
    } else if (issue.code === "unrecognized_key") {
      message = `unrecognized key ${formatLiteral(issue.key)}`;
    } else if (issue.code === "custom_error") {
      const error = issue.error;
      if (typeof error === "string") {
        message = error;
      } else if (error && error.message === "string") {
        message = error.message;
      }
    }

    return `${issue.code} at .${path.join(".")} (${message})`;
  }
}

function joinIssues(left: IssueTree, right: IssueTree | undefined): IssueTree {
  return right ? { code: "join", left, right } : left;
}

function prependPath(key: Key, tree: IssueTree): IssueTree {
  return { code: "prepend", key, tree };
}

type Ok<T> =
  | true
  | Readonly<{
      code: "ok";
      value: T;
    }>;
type Result<T> = Ok<T> | IssueTree;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toTerminals(type: Type): TerminalType[] {
  const result: TerminalType[] = [];
  type.toTerminals(result);
  return result;
}

type Infer<T extends Type> = T extends Type<infer I>
  ? Exclude<I, Nothing>
  : never;

const enum FuncMode {
  PASS = 0,
  STRICT = 1,
  STRIP = 2,
}
type Func<T> = (v: unknown, mode: FuncMode) => Result<T>;

type ParseOptions = {
  mode: "passthrough" | "strict" | "strip";
};

type ChainResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error?: CustomError;
    };

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function err<E extends CustomError>(
  error?: E
): { ok: false; error?: CustomError } {
  return { ok: false, error };
}

abstract class Type<Out = unknown> {
  abstract readonly name: string;
  abstract genFunc(): Func<Out>;
  abstract toTerminals(into: TerminalType[]): void;

  get isOptional(): boolean {
    const isOptional = toTerminals(this).some((t) => t.name === "nothing");
    Object.defineProperty(this, "isOptional", {
      value: isOptional,
      writable: false,
    });
    return isOptional;
  }

  get func(): Func<Out> {
    const f = this.genFunc();
    Object.defineProperty(this, "func", {
      value: f,
      writable: false,
    });
    return f;
  }

  parse(v: unknown, options?: Partial<ParseOptions>): Exclude<Out, Nothing> {
    let mode: FuncMode = FuncMode.PASS;
    if (options && options.mode === "strict") {
      mode = FuncMode.STRICT;
    } else if (options && options.mode === "strip") {
      mode = FuncMode.STRIP;
    }

    const r = this.func(v, mode);
    if (r === true) {
      return v as Exclude<Out, Nothing>;
    } else if (r.code === "ok") {
      return r.value as Exclude<Out, Nothing>;
    } else {
      throw new ValitaError(r);
    }
  }

  optional(): OptionalType<Out> {
    return new OptionalType(this);
  }

  assert<T extends Exclude<Out, Nothing>>(
    func: (v: Exclude<Out, Nothing>) => v is T,
    error?: CustomError
  ): TransformType<T>;
  assert<T extends Exclude<Out, Nothing> = Exclude<Out, Nothing>>(
    func: (v: Exclude<Out, Nothing>) => boolean,
    error?: CustomError
  ): TransformType<T>;
  assert<T>(
    func: (v: Exclude<Out, Nothing>) => boolean,
    error?: CustomError
  ): TransformType<T> {
    const err = { code: "custom_error", error } as const;
    const wrap = (v: unknown): Result<T> =>
      func(v as Exclude<Out, Nothing>) ? true : err;
    return new TransformType(this, wrap);
  }

  apply<T>(func: (v: Exclude<Out, Nothing>) => T): TransformType<T> {
    return new TransformType(this, (v) => {
      return { code: "ok", value: func(v as Exclude<Out, Nothing>) } as const;
    });
  }

  chain<T>(
    func: (v: Exclude<Out, Nothing>) => ChainResult<T>
  ): TransformType<T> {
    return new TransformType(this, (v) => {
      const r = func(v as Exclude<Out, Nothing>);
      if (r.ok) {
        return { code: "ok", value: r.value };
      } else {
        return { code: "custom_error", error: r.error };
      }
    });
  }
}

type Optionals<T extends Record<string, Type>> = {
  [K in keyof T]: T[K] extends Type<infer I>
    ? Nothing extends I
      ? I extends Nothing
        ? never
        : K
      : never
    : never;
}[keyof T];

type ObjectShape = Record<string, Type>;

type ObjectOutput<
  T extends ObjectShape,
  R extends Type | undefined
> = PrettyIntersection<
  { [K in Optionals<T>]?: Infer<T[K]> } &
    { [K in Exclude<keyof T, Optionals<T>>]: Infer<T[K]> } &
    (R extends Type ? { [K: string]: Infer<R> } : unknown)
>;

class ObjectType<
  T extends ObjectShape = ObjectShape,
  Rest extends Type | undefined = Type | undefined
> extends Type<ObjectOutput<T, Rest>> {
  readonly name = "object";

  constructor(readonly shape: T, private readonly restType: Rest) {
    super();
  }

  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }

  genFunc(): Func<ObjectOutput<T, Rest>> {
    const shape = this.shape;
    const rest = this.restType ? this.restType.func : undefined;

    const keys: string[] = [];
    const funcs: Func<unknown>[] = [];
    const required: boolean[] = [];
    const knownKeys = Object.create(null);
    const shapeTemplate = {} as Record<string, unknown>;
    for (const key in shape) {
      keys.push(key);
      funcs.push(shape[key].func);
      required.push(!shape[key].isOptional);
      knownKeys[key] = true;
      shapeTemplate[key] = undefined;
    }

    return (obj, mode) => {
      if (!isObject(obj)) {
        return { code: "invalid_type", expected: ["object"] };
      }
      const pass = mode === FuncMode.PASS;
      const strict = mode === FuncMode.STRICT;
      const strip = mode === FuncMode.STRIP;
      const template = pass || rest ? obj : shapeTemplate;

      let issueTree: IssueTree | undefined = undefined;
      let output: Record<string, unknown> = obj;
      if (strict || strip || rest) {
        for (const key in obj) {
          if (!knownKeys[key]) {
            if (strict) {
              return { code: "unrecognized_key", key };
            } else if (strip) {
              output = { ...template };
              break;
            } else if (rest) {
              const r = rest(obj[key], mode);
              if (r !== true) {
                if (r.code === "ok") {
                  if (output === obj) {
                    output = { ...template };
                  }
                  output[key] = r.value;
                } else {
                  issueTree = joinIssues(prependPath(key, r), issueTree);
                }
              }
            }
          }
        }
      }

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];

        let value = obj[key];
        if (value === undefined && !(key in obj)) {
          if (required[i]) {
            return { code: "missing_key", key };
          }
          value = Nothing;
        }
        const r = funcs[i](value, mode);
        if (r !== true) {
          if (r.code === "ok") {
            if (output === obj) {
              output = { ...template };
            }
            output[key] = r.value;
          } else {
            issueTree = joinIssues(prependPath(key, r), issueTree);
          }
        } else if (strip && output !== obj) {
          output[key] = value;
        }
      }

      if (issueTree) {
        return issueTree;
      } else if (obj === output) {
        return true;
      } else {
        return { code: "ok", value: output as ObjectOutput<T, Rest> };
      }
    };
  }
  rest<R extends Type>(restType: R): ObjectType<T, R> {
    return new ObjectType(this.shape, restType);
  }
}

class ArrayType<T extends Type = Type> extends Type<Infer<T>[]> {
  readonly name = "array";

  constructor(readonly item: T) {
    super();
  }

  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }

  genFunc(): Func<Infer<T>[]> {
    const func = this.item.func;
    return (arr, mode) => {
      if (!Array.isArray(arr)) {
        return { code: "invalid_type", expected: ["array"] };
      }
      let issueTree: IssueTree | undefined = undefined;
      let output: Infer<T>[] = arr;
      for (let i = 0; i < arr.length; i++) {
        const r = func(arr[i], mode);
        if (r !== true) {
          if (r.code === "ok") {
            if (output === arr) {
              output = arr.slice();
            }
            output[i] = r.value as Infer<T>;
          } else {
            issueTree = joinIssues(prependPath(i, r), issueTree);
          }
        }
      }
      if (issueTree) {
        return issueTree;
      } else if (arr === output) {
        return true;
      } else {
        return { code: "ok", value: output };
      }
    };
  }
}

function toBaseType(v: unknown): BaseType {
  const type = typeof v;
  if (type !== "object") {
    return type as BaseType;
  } else if (v === null) {
    return "null";
  } else if (Array.isArray(v)) {
    return "array";
  } else {
    return type;
  }
}

function dedup<T>(arr: T[]): T[] {
  const output = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    if (!seen.has(arr[i])) {
      output.push(arr[i]);
      seen.add(arr[i]);
    }
  }
  return output;
}

function difference<T>(arr1: T[], arr2: T[]): T[] {
  const output = [];
  const remove = new Set(arr2);
  for (let i = 0; i < arr1.length; i++) {
    if (!remove.has(arr1[i])) {
      output.push(arr1[i]);
    }
  }
  return output;
}

function findCommonKeys(rs: ObjectShape[]): string[] {
  const map = new Map<string, number>();
  rs.forEach((r) => {
    for (const key in r) {
      map.set(key, (map.get(key) || 0) + 1);
    }
  });
  const result = [] as string[];
  map.forEach((count, key) => {
    if (count === rs.length) {
      result.push(key);
    }
  });
  return result;
}

function createObjectMatchers(
  t: { root: Type; terminal: TerminalType }[]
): {
  key: string;
  nothing?: Type;
  matcher: (
    rootValue: unknown,
    value: unknown,
    mode: FuncMode
  ) => Result<unknown>;
}[] {
  const objects: {
    root: Type;
    terminal: TerminalType & { name: "object" };
  }[] = [];
  t.forEach(({ root, terminal }) => {
    if (terminal.name === "object") {
      objects.push({ root, terminal });
    }
  });
  const shapes = objects.map(({ terminal }) => terminal.shape);
  const common = findCommonKeys(shapes);
  const discriminants = common.filter((key) => {
    const types = new Map<BaseType, number[]>();
    const literals = new Map<unknown, number[]>();
    let nothings = [] as number[];
    let unknowns = [] as number[];
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i];
      const terminals = toTerminals(shape[key]);
      for (let j = 0; j < terminals.length; j++) {
        const terminal = terminals[j];
        if (terminal.name === "unknown") {
          unknowns.push(i);
        } else if (terminal.name === "nothing") {
          nothings.push(i);
        } else if (terminal.name === "literal") {
          const options = literals.get(terminal.value) || [];
          options.push(i);
          literals.set(terminal.value, options);
        } else {
          const options = types.get(terminal.name) || [];
          options.push(i);
          types.set(terminal.name, options);
        }
      }
    }
    unknowns = dedup(unknowns);
    nothings = dedup(nothings);
    literals.forEach((found, value) => {
      const options = types.get(toBaseType(value));
      if (options) {
        options.push(...found);
        literals.delete(value);
      }
    });
    types.forEach((roots, type) =>
      types.set(type, difference(dedup(roots), unknowns))
    );
    literals.forEach((roots, value) =>
      literals.set(value, difference(dedup(roots), unknowns))
    );
    if (nothings.length > 1) {
      return false;
    }
    if (unknowns.length > 1) {
      return false;
    }
    if (unknowns.length === 1) {
      return literals.size === 0 && types.size === 0;
    }

    let success = true;
    literals.forEach((found) => {
      if (found.length > 1) {
        success = false;
      }
    });
    types.forEach((found) => {
      if (found.length > 1) {
        success = false;
      }
    });
    return success;
  });
  return discriminants.map((key) => {
    const flattened = flatten(
      objects.map(({ root, terminal }) => ({
        root,
        type: terminal.shape[key],
      }))
    );
    let nothing: Type | undefined = undefined;
    for (let i = 0; i < flattened.length; i++) {
      const { root, terminal } = flattened[i];
      if (terminal.name === "nothing") {
        nothing = root;
        break;
      }
    }
    return {
      key,
      nothing,
      matcher: createUnionMatcher(flattened, [key]),
    };
  });
}

function createUnionMatcher(
  t: { root: Type; terminal: TerminalType }[],
  path?: Key[]
): (rootValue: unknown, value: unknown, mode: FuncMode) => Result<unknown> {
  const literals = new Map<unknown, Type[]>();
  const types = new Map<BaseType, Type[]>();
  const allTypes = new Set<BaseType>();
  let unknowns = [] as Type[];
  let nothings = [] as Type[];

  t.forEach(({ root, terminal }) => {
    if (terminal.name === "nothing") {
      nothings.push(root);
    } else if (terminal.name === "unknown") {
      unknowns.push(root);
    } else if (terminal.name === "literal") {
      const roots = literals.get(terminal.value) || [];
      roots.push(root);
      literals.set(terminal.value, roots);
      allTypes.add(toBaseType(terminal.value));
    } else {
      const roots = types.get(terminal.name) || [];
      roots.push(root);
      types.set(terminal.name, roots);
      allTypes.add(terminal.name);
    }
  });
  unknowns = dedup(unknowns);
  nothings = dedup(nothings);
  literals.forEach((vxs, value) => {
    const options = types.get(toBaseType(value));
    if (options) {
      options.push(...vxs);
      literals.delete(value);
    }
  });
  types.forEach((roots, type) =>
    types.set(type, difference(dedup(roots), unknowns))
  );
  literals.forEach((roots, value) =>
    literals.set(value, difference(dedup(roots), unknowns))
  );

  const expectedTypes: BaseType[] = [];
  allTypes.forEach((type) => expectedTypes.push(type));

  const expectedLiterals: Literal[] = [];
  literals.forEach((_, value) => {
    expectedLiterals.push(value as Literal);
  });

  const invalidType: Issue = {
    code: "invalid_type",
    path,
    expected: expectedTypes,
  };
  const invalidLiteral: Issue = {
    code: "invalid_literal",
    path,
    expected: expectedLiterals,
  };

  return (rootValue, value, mode) => {
    let issueTree: IssueTree | undefined;
    let count = 0;

    if (value !== Nothing) {
      const type = toBaseType(value);
      if (unknowns.length === 0 && !allTypes.has(type)) {
        return invalidType;
      }

      const options = literals.get(value) || types.get(type);
      if (options) {
        for (let i = 0; i < options.length; i++) {
          const r = options[i].func(rootValue, mode);
          if (r === true || r.code === "ok") {
            return r;
          }
          issueTree = joinIssues(r, issueTree);
          count++;
        }
      }
      for (let i = 0; i < unknowns.length; i++) {
        const r = unknowns[i].func(rootValue, mode);
        if (r === true || r.code === "ok") {
          return r;
        }
        issueTree = joinIssues(r, issueTree);
        count++;
      }
    } else {
      for (let i = 0; i < nothings.length; i++) {
        const r = nothings[i].func(rootValue, mode);
        if (r === true || r.code === "ok") {
          return r;
        }
        issueTree = joinIssues(r, issueTree);
        count++;
      }
    }
    if (issueTree) {
      if (count > 1) {
        return { code: "invalid_union", tree: issueTree };
      }
      return issueTree;
    }

    return invalidLiteral;
  };
}

function flatten(
  t: { root: Type; type: Type }[]
): { root: Type; terminal: TerminalType }[] {
  const result: { root: Type; terminal: TerminalType }[] = [];
  t.forEach(({ root, type }) =>
    toTerminals(type).forEach((terminal) => {
      result.push({ root, terminal });
    })
  );
  return result;
}

class UnionType<T extends Type[] = Type[]> extends Type<Infer<T[number]>> {
  readonly name = "union";

  constructor(readonly options: T) {
    super();
  }

  toTerminals(into: TerminalType[]): void {
    this.options.forEach((o) => o.toTerminals(into));
  }

  genFunc(): Func<Infer<T[number]>> {
    const flattened = flatten(
      this.options.map((root) => ({ root, type: root }))
    );
    const objects = createObjectMatchers(flattened);
    const base = createUnionMatcher(flattened);
    return (v, mode) => {
      if (objects.length > 0 && isObject(v)) {
        const item = objects[0];
        const value = v[item.key];
        if (value === undefined && !(item.key in v)) {
          if (item.nothing) {
            return item.nothing.func(Nothing, mode) as Result<Infer<T[number]>>;
          }
          return { code: "missing_key", key: item.key };
        }
        return item.matcher(v, value, mode) as Result<Infer<T[number]>>;
      }
      return base(v, v, mode) as Result<Infer<T[number]>>;
    };
  }
}

class NothingType extends Type<Nothing> {
  readonly name = "nothing";
  genFunc(): Func<Nothing> {
    const issue: Issue = { code: "invalid_type", expected: [] };
    return (v, _mode) => (v === Nothing ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class UnknownType extends Type<unknown> {
  readonly name = "unknown";
  genFunc(): Func<unknown> {
    return (_v, _mode) => true;
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class NumberType extends Type<number> {
  readonly name = "number";
  genFunc(): Func<number> {
    const issue: Issue = { code: "invalid_type", expected: ["number"] };
    return (v, _mode) => (typeof v === "number" ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class StringType extends Type<string> {
  readonly name = "string";
  genFunc(): Func<string> {
    const issue: Issue = { code: "invalid_type", expected: ["string"] };
    return (v, _mode) => (typeof v === "string" ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class BigIntType extends Type<bigint> {
  readonly name = "bigint";
  genFunc(): Func<bigint> {
    const issue: Issue = { code: "invalid_type", expected: ["bigint"] };
    return (v, _mode) => (typeof v === "bigint" ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class BooleanType extends Type<boolean> {
  readonly name = "boolean";
  genFunc(): Func<boolean> {
    const issue: Issue = { code: "invalid_type", expected: ["boolean"] };
    return (v, _mode) => (typeof v === "boolean" ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class UndefinedType extends Type<undefined> {
  readonly name = "undefined";
  genFunc(): Func<undefined> {
    const issue: Issue = { code: "invalid_type", expected: ["undefined"] };
    return (v, _mode) => (v === undefined ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class NullType extends Type<null> {
  readonly name = "null";
  genFunc(): Func<null> {
    const issue: Issue = { code: "invalid_type", expected: ["null"] };
    return (v, _mode) => (v === null ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class LiteralType<Out extends Literal = Literal> extends Type<Out> {
  readonly name = "literal";
  constructor(readonly value: Out) {
    super();
  }
  genFunc(): Func<Out> {
    const value = this.value;
    const issue: Issue = { code: "invalid_literal", expected: [value] };
    return (v, _) => (v === value ? true : issue);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(this);
  }
}
class OptionalType<Out> extends Type<Out | undefined | Nothing> {
  readonly name = "optional";
  constructor(private readonly type: Type<Out>) {
    super();
  }
  genFunc(): Func<Out | Nothing> {
    const func = this.type.func;
    return (v, mode) =>
      v === Nothing || v === undefined ? true : func(v, mode);
  }
  toTerminals(into: TerminalType[]): void {
    into.push(nothing());
    into.push(undefined_());
    this.type.toTerminals(into);
  }
}

class TransformType<Out> extends Type<Out> {
  readonly name = "transform";
  constructor(
    readonly transformed: Type,
    private readonly transformFunc: (v: unknown) => Result<Out>
  ) {
    super();
  }
  genFunc(): Func<Out> {
    const f = this.transformed.func;
    const t = this.transformFunc;
    return (v, mode) => {
      const r = f(v, mode);
      if (r !== true && r.code !== "ok") {
        return r;
      }
      return t(r === true ? v : r.value);
    };
  }
  toTerminals(into: TerminalType[]): void {
    this.transformed.toTerminals(into);
  }
}

function nothing(): NothingType {
  return new NothingType();
}
function unknown(): UnknownType {
  return new UnknownType();
}
function number(): NumberType {
  return new NumberType();
}
function bigint(): BigIntType {
  return new BigIntType();
}
function string(): StringType {
  return new StringType();
}
function boolean(): BooleanType {
  return new BooleanType();
}
function undefined_(): UndefinedType {
  return new UndefinedType();
}
function null_(): NullType {
  return new NullType();
}
function object<T extends Record<string, Type>>(
  obj: T
): ObjectType<T, undefined> {
  return new ObjectType(obj, undefined);
}
function array<T extends Type>(item: T): ArrayType<T> {
  return new ArrayType(item);
}
function literal<T extends Literal>(value: T): LiteralType<T> {
  return new LiteralType(value);
}
function union<T extends Type[]>(...options: T): UnionType<T> {
  return new UnionType(options);
}

type TerminalType =
  | NothingType
  | UnknownType
  | StringType
  | NumberType
  | BigIntType
  | BooleanType
  | UndefinedType
  | NullType
  | ObjectType
  | ArrayType
  | LiteralType;

export {
  nothing,
  unknown,
  number,
  bigint,
  string,
  boolean,
  object,
  array,
  literal,
  union,
  null_ as null,
  undefined_ as undefined,
  ok,
  err,
};

export type { Infer, Type };
