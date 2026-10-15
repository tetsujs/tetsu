/**
 * The literals a query compares a column with, held to the values the
 * column may hold: those of a list its checks allow, or of its enum.
 * Postgres runs a comparison with a value outside them without a word, and
 * it never holds, or always does: `status = 'pendng'` finds nothing, and
 * `status <> 'pendng'` keeps every row.
 *
 * The comparisons are read from the conditions of the plan, as `EXPLAIN
 * VERBOSE` writes them: a column of a table the plan scans, `=` or `<>` a
 * literal on either side, and `= ANY` or `<> ALL` an array of them, which
 * is how Postgres writes `in` and `not in`. A cast of the column to `text`,
 * `integer` or `smallint`, as of a `varchar` or of a domain to its base, is
 * looked through.
 *
 * A literal is refused only where it is certain to be outside: when every
 * place the plan holds it is such a comparison, with a column whose values
 * leave it out. The planner copies a condition into each table a `union
 * all` or a parent of tables reads, and derives one for a column a join
 * makes equal to another, so the same literal stands beside columns the
 * query never named; one of them that may hold it, or a place that is no
 * such comparison — `lower(name) = 'garden'`, or the value a part of a
 * union returns — lets it pass.
 *
 * @module
 */

/**
 * The values a column may hold, by the names of its schema, its relation
 * and itself, with the name the column is told by: nothing when no list
 * and no enum narrows it.
 */
export type Allowed = (
  schema: string,
  relation: string,
  column: string,
) =>
  | {
      readonly column: string;
      readonly values: readonly (string | number)[];
    }
  | undefined;

/** A literal a query compares a column with, which the column never holds. */
export interface Outside {
  /** The column, as `relation.column`, its schema first outside `public`. */
  readonly column: string;

  /** The literal: a string, or an integer. */
  readonly value: string | number;

  /** The values the column may hold. */
  readonly allowed: readonly (string | number)[];
}

/** A node of the plan, as much as is read of it. */
interface PlanNode {
  readonly "Relation Name"?: unknown;
  readonly Schema?: unknown;
  readonly Alias?: unknown;
  readonly Plans?: unknown;
  readonly [field: string]: unknown;
}

/** The fields of a node that hold a condition. */
const CONDITIONS = [
  "Filter",
  "Conflict Filter",
  "Join Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "One-Time Filter",
  "TID Cond",
  "Run Condition",
];

/** An identifier as Postgres writes one: bare, or quoted. */
const IDENT = `(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")`;

/** A column of a relation the plan names, as `alias.column`. */
const COLUMN = String.raw`(?<alias>${IDENT})\.(?<column>${IDENT})`;

/** The type a literal is cast to. */
const TYPE = `(?<type>"[^"]+"|[a-z_][a-z0-9_.]*)`;

/** A literal: a string cast to its type, or an integer. */
const LITERAL = String.raw`(?:'(?<text>(?:[^']|'')*)'::${TYPE}|(?<integer>\d+))`;

/** What comes before a comparison, and after it. */
const BEFORE = String.raw`(?<=^|[\s(])`;
const AFTER = String.raw`(?=$|[\s)])`;

/** A column compared with a literal after it. */
const COLUMN_FIRST = new RegExp(
  `${BEFORE}${COLUMN} (?:=|<>) ${LITERAL}${AFTER}`,
  "g",
);

/** A literal compared with a column after it. */
const LITERAL_FIRST = new RegExp(
  `${BEFORE}${LITERAL} (?:=|<>) ${COLUMN}${AFTER}`,
  "g",
);

/** A column compared with each element of an array: `in` or `not in`. */
const ANY = new RegExp(
  String.raw`${BEFORE}${COLUMN} (?:= ANY|<> ALL) \('(?<array>(?:[^']|'')*)'::${TYPE}\[\]\)`,
  "g",
);

/**
 * A column cast to `text`, `integer` or `smallint`, as a `varchar` or a
 * domain over one is to be compared.
 */
const TO_BASE = new RegExp(
  String.raw`\((${IDENT}\.${IDENT})\)::(?:text|integer|smallint)${AFTER}`,
  "g",
);

/** The integer types a literal is cast to, as `'-3'::integer`. */
const INTEGERS: ReadonlySet<string> = new Set([
  "smallint",
  "integer",
  "bigint",
]);

/** Any literal a condition writes: a string with its cast, of an array or not, or an integer. */
const TOKEN = new RegExp(
  String.raw`'(?<text>(?:[^']|'')*)'(?:::${TYPE}(?<array>\[\])?)?|(?<![\w$.])(?<integer>\d+)(?![\w.])`,
  "g",
);

/**
 * The literals the plan of a query compares a column with that the column
 * never holds, by `allowed`, where nothing else of the plan may hold them:
 * each beside each such column once, though the plan writes a condition
 * twice, as an index condition and its recheck.
 */
export function literalsOutside(plan: unknown, allowed: Allowed): Outside[] {
  const top = (plan as readonly { readonly Plan?: PlanNode }[] | undefined)?.[0]
    ?.Plan;
  const relations = new Map<string, { schema: string; name: string }>();
  const conditions: string[] = [];
  const texts: string[] = [];

  const visit = (node: PlanNode) => {
    const name = node["Relation Name"];
    const schema = node.Schema;
    const alias = node.Alias;

    if (
      typeof name === "string" &&
      typeof schema === "string" &&
      typeof alias === "string"
    ) {
      relations.set(alias, { schema, name });
    }

    for (const field of CONDITIONS) {
      const condition = node[field];

      if (typeof condition === "string") {
        conditions.push(condition.replaceAll(TO_BASE, "$1"));
      }
    }

    for (const [field, value] of Object.entries(node)) {
      if (field !== "Plans") {
        texts.push(
          ...(Array.isArray(value) ? value : [value]).filter(
            (text): text is string => typeof text === "string",
          ),
        );
      }
    }

    for (const child of Array.isArray(node.Plans) ? node.Plans : []) {
      visit(child as PlanNode);
    }
  };

  if (top !== undefined) {
    visit(top);
  }

  const verdicts = new Map<string, Verdict>();

  for (const condition of conditions) {
    for (const comparison of comparisons(condition)) {
      const relation = relations.get(comparison.alias);
      const narrowed =
        relation === undefined
          ? undefined
          : allowed(relation.schema, relation.name, comparison.column);
      const values = narrowed?.values;
      const numeric =
        values?.every((value) => typeof value === "number") ?? false;

      for (const literal of comparison.literals) {
        const key = keyOf(literal);
        const verdict = verdicts.get(key) ?? {
          compared: 0,
          held: false,
          outside: new Map<string, Outside>(),
        };
        const value =
          values === undefined ? undefined : literalValue(literal, numeric);

        verdicts.set(key, verdict);
        verdict.compared += 1;

        if (
          narrowed === undefined ||
          values === undefined ||
          value === undefined ||
          values.includes(value)
        ) {
          verdict.held = true;
          continue;
        }

        verdict.outside.set(narrowed.column, {
          column: narrowed.column,
          value,
          allowed: values,
        });
      }
    }
  }

  const written = new Map<string, number>();

  for (const text of texts) {
    for (const key of literalsIn(text)) {
      written.set(key, (written.get(key) ?? 0) + 1);
    }
  }

  return [...verdicts].flatMap(([key, verdict]) =>
    verdict.held || verdict.compared !== written.get(key)
      ? []
      : [...verdict.outside.values()],
  );
}

/** What the plan says of one literal, across the comparisons it stands in. */
interface Verdict {
  /** How many comparisons with a column it stands in. */
  compared: number;

  /** Whether a column it is compared with may hold it, or cannot be told. */
  held: boolean;

  /** The columns that never hold it, by their names. */
  readonly outside: Map<string, Outside>;
}

/**
 * A literal's key, the same wherever the plan writes it: an integer, bare
 * or cast to an integer type, or a string.
 */
function keyOf(literal: Literal): string {
  return isInteger(literal)
    ? `integer\u0000${Number(literal.text)}`
    : `string\u0000${literal.text}`;
}

/** Whether a literal is an integer: bare, or a whole number cast to an integer type. */
function isInteger(literal: Literal): boolean {
  return (
    literal.type === undefined ||
    (INTEGERS.has(literal.type) && /^-?\d+$/.test(literal.text))
  );
}

/** The keys of every literal a condition writes, each element of an array one. */
function* literalsIn(condition: string): Generator<string> {
  for (const match of condition.matchAll(TOKEN)) {
    const { text, type, array, integer } = match.groups ?? {};

    if (integer !== undefined) {
      yield keyOf({ text: integer, type: undefined });
    } else if (text !== undefined && array !== undefined) {
      for (const element of elementsOf(text.replaceAll("''", "'")) ?? []) {
        yield keyOf({ text: element, type: type ?? "text" });
      }
    } else if (text !== undefined) {
      yield keyOf({ text: text.replaceAll("''", "'"), type: type ?? "text" });
    }
  }
}

/** A literal as a condition writes it: its text, and the type it is cast to. */
interface Literal {
  readonly text: string;

  /** The type it is cast to; `undefined` for an integer, which is not cast. */
  readonly type: string | undefined;
}

/** A column a condition compares with literals, by the names it writes. */
interface Comparison {
  /** Where the comparison starts in the condition. */
  readonly at: number;

  readonly alias: string;
  readonly column: string;
  readonly literals: readonly Literal[];
}

/** The comparisons of a column with literals in a condition, in its order. */
function comparisons(condition: string): Comparison[] {
  const found: Comparison[] = [];

  for (const pattern of [COLUMN_FIRST, LITERAL_FIRST]) {
    for (const match of condition.matchAll(pattern)) {
      const { alias, column, text, type, integer } = match.groups ?? {};

      if (alias !== undefined && column !== undefined) {
        found.push({
          at: match.index,
          alias: unquoted(alias),
          column: unquoted(column),
          literals: [
            text === undefined
              ? { text: integer ?? "", type: undefined }
              : { text: text.replaceAll("''", "'"), type },
          ],
        });
      }
    }
  }

  for (const match of condition.matchAll(ANY)) {
    const { alias, column, array, type } = match.groups ?? {};
    const elements =
      array === undefined ? undefined : elementsOf(array.replaceAll("''", "'"));

    if (alias !== undefined && column !== undefined && elements !== undefined) {
      found.push({
        at: match.index,
        alias: unquoted(alias),
        column: unquoted(column),
        literals: elements.map((text) => ({ text, type })),
      });
    }
  }

  return found.toSorted((a, b) => a.at - b.at);
}

/**
 * What a literal is, as a value of a column: an integer for a column of
 * integers, a string for any other. Nothing when it cannot be one, so that
 * it is not compared: a string with a column of integers, or the reverse.
 */
function literalValue(
  literal: Literal,
  numeric: boolean,
): string | number | undefined {
  const integer =
    literal.type === undefined ||
    (INTEGERS.has(literal.type) && /^-?\d+$/.test(literal.text));

  if (numeric) {
    return integer ? Number(literal.text) : undefined;
  }

  return literal.type === undefined ? undefined : literal.text;
}

/**
 * The elements of the text of a one-dimensional Postgres array, such as
 * `{pending,"on hold"}`, NULL ones left out; nothing for an array of more
 * dimensions.
 */
function elementsOf(text: string): string[] | undefined {
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return undefined;
  }

  const body = text.slice(1, -1);
  const elements: string[] = [];
  let index = 0;

  while (index < body.length) {
    if (body[index] === "{") {
      return undefined;
    }

    if (body[index] === '"') {
      let element = "";

      index += 1;

      while (index < body.length && body[index] !== '"') {
        if (body[index] === "\\") {
          index += 1;
        }

        element += body[index] ?? "";
        index += 1;
      }

      elements.push(element);
      index += 2;
    } else {
      const end = body.indexOf(",", index);
      const element = body.slice(index, end === -1 ? body.length : end);

      if (element !== "NULL") {
        elements.push(element);
      }

      index = end === -1 ? body.length : end + 1;
    }
  }

  return elements;
}

/** An identifier as it is named, its quotes taken off. */
function unquoted(identifier: string): string {
  return identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;
}
