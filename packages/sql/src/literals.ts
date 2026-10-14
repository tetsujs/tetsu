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
 * as of a `varchar`, is looked through. Any other comparison, and a column
 * the plan reads from a subquery, a CTE or a function, is left as it is:
 * a literal is refused only where it is certain to be outside.
 *
 * @module
 */

/**
 * The values a column may hold, by the names of its schema, its relation
 * and itself: nothing when no list and no enum narrows it.
 */
export type Allowed = (
  schema: string,
  relation: string,
  column: string,
) => readonly (string | number)[] | undefined;

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

/** A column cast to `text`, as a `varchar` is to be compared. */
const TO_TEXT = new RegExp(
  String.raw`\((${IDENT}\.${IDENT})\)::text${AFTER}`,
  "g",
);

/** The integer types a literal is cast to, as `'-3'::integer`. */
const INTEGERS: ReadonlySet<string> = new Set([
  "smallint",
  "integer",
  "bigint",
]);

/**
 * The literals the plan of a query compares a column with that the column
 * never holds, by `allowed`: each once, though the plan writes a condition
 * twice, as an index condition and its recheck.
 */
export function literalsOutside(plan: unknown, allowed: Allowed): Outside[] {
  const top = (plan as readonly { readonly Plan?: PlanNode }[] | undefined)?.[0]
    ?.Plan;
  const relations = new Map<string, { schema: string; name: string }>();
  const conditions: string[] = [];

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
        conditions.push(condition.replaceAll(TO_TEXT, "$1"));
      }
    }

    for (const child of Array.isArray(node.Plans) ? node.Plans : []) {
      visit(child as PlanNode);
    }
  };

  if (top !== undefined) {
    visit(top);
  }

  const found = new Map<string, Outside>();

  for (const condition of conditions) {
    for (const comparison of comparisons(condition)) {
      const relation = relations.get(comparison.alias);
      const values =
        relation === undefined
          ? undefined
          : allowed(relation.schema, relation.name, comparison.column);

      if (relation === undefined || values === undefined) {
        continue;
      }

      const numeric = values.every((value) => typeof value === "number");

      for (const literal of comparison.literals) {
        const value = literalValue(literal, numeric);

        if (value === undefined || values.includes(value)) {
          continue;
        }

        const column = `${relation.schema === "public" ? "" : `${relation.schema}.`}${relation.name}.${comparison.column}`;

        found.set(`${column}\u0000${typeof value}\u0000${value}`, {
          column,
          value,
          allowed: values,
        });
      }
    }
  }

  return [...found.values()];
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
