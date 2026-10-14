/**
 * Describing the queries of files: Postgres prepares each one, without
 * running it, and tells the types of its parameters and of its columns,
 * with the table and the column each column is taken from; the catalog
 * types them as the generated file types the database; and the plan of
 * the query tells which columns it may make NULL.
 *
 * A column taken from a table is NULL as the table's column is, unless the
 * plan of the query — `EXPLAIN` of it, planned for any values of its
 * parameters — may make it NULL. A plan of no outer join and no grouping
 * sets, whose statement returns only the rows it writes, makes no column
 * NULL. Otherwise a column is not NULL only where the plan reads it from
 * its table, and not on a side a join may leave NULL: one a materialized
 * CTE or a subquery gives on may be NULL, as may the side of an anti join
 * — Postgres's plan of a left join that keeps the rows that find no
 * match — and a row a statement returns from before or after it wrote it,
 * `old` and `new`. With grouping sets, every column may be NULL.
 *
 * Any other column — an expression, an aggregate, a column of a union or
 * of a table the file of types does not describe — may be NULL, and so
 * may every column of a query Postgres cannot plan, such as a `SHOW`. A
 * column whose name is marked `!` is never NULL, and one marked `?` may
 * be, whatever the rest says.
 *
 * A literal the file writes, which the plan compares only with columns
 * whose lists or enums do not hold it, refuses the file: the comparison
 * never holds, or always does. One a view or a function the query reads
 * writes is left to the migration that wrote it.
 *
 * @module
 */

import { SQL } from "bun";
import type { Lookup, Values } from "./catalog.ts";
import type { Outside } from "./literals.ts";
import { literalsOutside } from "./literals.ts";
import type { QueryFile, QueryParameter } from "./query-files.ts";
import { QueryFileError } from "./query-files.ts";
import type { Statement, Wire } from "./wire.ts";

/** A parameter of a query, typed. */
export interface DescribedParameter extends QueryParameter {
  /** What its values are, as a column of its type takes them. */
  readonly values: Values;

  /** How an array is written to it, when it takes one. */
  readonly literal: string | undefined;
}

/** A column a query returns, typed. */
export interface DescribedField {
  readonly name: string;

  /** What its values are, as a column of its type, or the column it is, reads them. */
  readonly values: Values;

  /** Whether it may be NULL. */
  readonly nullable: boolean;
}

/** A query of a file, described. */
export interface DescribedQuery {
  readonly file: QueryFile;
  readonly parameters: readonly DescribedParameter[];

  /** The columns of the rows it returns, or `null` when it returns none. */
  readonly fields: readonly DescribedField[] | null;
}

/** A node of the plan `EXPLAIN (FORMAT JSON)` gives, as much as is read of it. */
interface PlanNode {
  readonly "Node Type"?: unknown;
  readonly "Join Type"?: unknown;
  readonly "Parent Relationship"?: unknown;
  readonly "Relation Name"?: unknown;
  readonly Alias?: unknown;
  readonly "Grouping Sets"?: unknown;
  readonly Output?: unknown;
  readonly Plans?: unknown;
}

/** The name the query of a file is prepared under. */
const QUERY = "tetsu_sql_query";

/** The name the query is prepared under to be planned, its domains' types their bases. */
const PLAN = "tetsu_sql_plan";

/** The words Postgres refuses a prepared statement of more than one with. */
const MULTIPLE = "cannot insert multiple commands into a prepared statement";

/**
 * Describes the query of each of `files` on `wire`, a session on the
 * database the migrations built, typing it by `lookup`, the catalog of
 * that database.
 *
 * @throws {QueryFileError} for each query Postgres refuses, whose
 * parameters it counts otherwise than the file names them, that compares
 * a column with a literal the column never holds, or that returns a
 * column without a name, two of one name, or a marker of no column: all
 * of them at once, as one error with each on a line.
 */
export async function describeQueries(
  wire: Wire,
  files: readonly QueryFile[],
  lookup: Lookup,
): Promise<DescribedQuery[]> {
  const described: DescribedQuery[] = [];
  const problems: string[] = [];

  await wire.query("set plan_cache_mode = force_generic_plan");

  for (const file of files) {
    try {
      described.push(await describe(wire, file, lookup));
    } catch (error) {
      if (error instanceof QueryFileError) {
        problems.push(error.message);
      } else if (isRefusal(error)) {
        problems.push(problemOf(file, error));
      } else {
        throw error;
      }
    }
  }

  if (problems.length > 0) {
    throw new QueryFileError(problems.join("\n"));
  }

  return described;
}

/**
 * The columns of the rows of a plan that it may make NULL, by their place,
 * as its top node outputs them: none when it holds no outer or anti join,
 * no grouping sets, and no statement that returns more than the rows it
 * writes. Otherwise, each the plan does not read from a table, as a scan
 * of it or the table a statement writes, and each a side a join may leave
 * NULL gives: the inner side of a left join or of an anti one, the outer
 * side of a right one or of a right anti one — Postgres plans a left join
 * as a right one with its sides swapped — and both sides of a full one.
 * Nothing — so every column may be NULL — when the plan holds grouping
 * sets, or its top node outputs fewer than the `count` columns of its
 * rows: those it outputs after them, to sort or to lock by, are not
 * columns.
 *
 * The outputs are matched by their text, as `EXPLAIN VERBOSE` writes
 * them: a column a scan reads, such as `c.email`, is written the same
 * above it, and one a subquery or a CTE gives on, such as `x.email`, is
 * not. A column is NULL as well when a side a join may leave NULL outputs
 * the same text, so a match can make a column NULL that is not, and never
 * the other way.
 */
export function planNullables(
  plan: unknown,
  count: number,
): ReadonlySet<number> | undefined {
  const top = (plan as readonly { readonly Plan?: PlanNode }[] | undefined)?.[0]
    ?.Plan;

  if (top === undefined) {
    return undefined;
  }

  const nullable = new Set<unknown>();
  const read = new Set<unknown>();
  let outer = false;
  let grouping = false;

  const visit = (node: PlanNode) => {
    const join = node["Join Type"];

    outer ||=
      join === "Left" ||
      join === "Right" ||
      join === "Full" ||
      join === "Anti" ||
      join === "Right Anti" ||
      returnsMore(node);
    grouping ||= node["Grouping Sets"] !== undefined;

    if (
      typeof node["Relation Name"] === "string" &&
      Array.isArray(node.Output)
    ) {
      for (const output of node.Output) {
        if (
          node["Node Type"] !== "ModifyTable" ||
          (typeof output === "string" && output.startsWith(`${node.Alias}.`))
        ) {
          read.add(output);
        }
      }
    }

    for (const child of plansOf(node)) {
      const side = child["Parent Relationship"];
      const left =
        join === "Full" ||
        ((join === "Left" || join === "Anti") && side === "Inner") ||
        ((join === "Right" || join === "Right Anti") && side === "Outer");

      if (left && Array.isArray(child.Output)) {
        for (const output of child.Output) {
          nullable.add(output);
        }
      }

      visit(child);
    }
  };

  visit(top);

  if (!outer && !grouping) {
    return new Set();
  }

  const outputs = top.Output;

  if (grouping || !Array.isArray(outputs) || outputs.length < count) {
    return undefined;
  }

  return new Set(
    outputs
      .slice(0, count)
      .flatMap((output, index) =>
        nullable.has(output) || !read.has(output) ? [index] : [],
      ),
  );
}

/**
 * Whether a node is a statement that returns more than the rows it writes:
 * a column of the row from before or after it wrote it, `old.x` or
 * `new.x`, or of another table, which it outputs without its own alias.
 */
function returnsMore(node: PlanNode): boolean {
  return (
    node["Node Type"] === "ModifyTable" &&
    Array.isArray(node.Output) &&
    node.Output.some(
      (output) =>
        typeof output !== "string" || !output.startsWith(`${node.Alias}.`),
    )
  );
}

/** The query of a file, described. */
async function describe(
  wire: Wire,
  file: QueryFile,
  lookup: Lookup,
): Promise<DescribedQuery> {
  const statement = await wire.prepare(QUERY, file.text);

  try {
    if (statement.parameters.length !== file.parameters.length) {
      throw new QueryFileError(
        `${file.path}: Postgres finds ${statement.parameters.length} parameters where the file names ${file.parameters.length}: it reads a string, a quoted name or a comment of the file otherwise`,
      );
    }

    const plan = await planOf(wire, file, statement, lookup);
    const outside = literalsOutside(plan, (schema, relation, column) =>
      lookup.allowed(schema, relation, column),
    ).flatMap((literal) => {
      const at = placeOf(file.text, literal.value);

      return at === -1 ? [] : [outsideLine(file, literal, at)];
    });

    if (outside.length > 0) {
      throw new QueryFileError(outside.join("\n"));
    }

    return {
      file,
      parameters: file.parameters.map((parameter, index) => {
        const type = lookup.type(statement.parameters[index] ?? 0);

        return { ...parameter, values: type.values, literal: type.literal };
      }),
      fields:
        statement.fields === null
          ? null
          : fieldsOf(file, statement, lookup, plan),
    };
  } finally {
    await wire.query(`deallocate ${QUERY}`);
  }
}

/**
 * The columns a query returns, typed, and NULL as its tables, its plan
 * and its markers say.
 *
 * @throws {QueryFileError} when it returns none, one without a name or
 * two of one name, or a marker names none of them.
 */
function fieldsOf(
  file: QueryFile,
  statement: Statement,
  lookup: Lookup,
  plan: unknown,
): DescribedField[] {
  const fields = statement.fields ?? [];
  const names = new Set<string>();

  if (fields.length === 0) {
    throw new QueryFileError(
      `${file.path}: returns rows of no columns: return some, or none at all`,
    );
  }

  for (const field of fields) {
    if (field.name === "?column?") {
      throw new QueryFileError(
        `${file.path}: returns a column with no name: name it with as`,
      );
    }

    if (names.has(field.name)) {
      throw new QueryFileError(
        `${file.path}: returns two columns named ${field.name}: name them apart with as`,
      );
    }

    names.add(field.name);
  }

  for (const [name, marker] of file.markers) {
    if (!names.has(name)) {
      throw new QueryFileError(
        `${file.path}: marks "${name}${marker}", which is not a column the query returns`,
      );
    }
  }

  const nullables = planNullables(plan, fields.length);

  return fields.map((field, index) => {
    const origin =
      field.table === 0 ? undefined : lookup.column(field.table, field.column);
    const marker = file.markers.get(field.name);

    return {
      name: field.name,
      values: origin?.values ?? lookup.type(field.type).values,
      nullable:
        marker === "!"
          ? false
          : marker === "?" ||
            origin === undefined ||
            origin.nullable ||
            nullables === undefined ||
            nullables.has(index),
    };
  });
}

/**
 * The plan of a query, as `EXPLAIN (VERBOSE, FORMAT JSON)` gives it:
 * planned for any values of its parameters, with NULL for each. A
 * parameter of a domain is planned as of the type under the domain, as
 * NULL breaks a domain that is `not null`. Nothing when the query cannot
 * be planned, as a `SHOW` cannot.
 */
async function planOf(
  wire: Wire,
  file: QueryFile,
  statement: Statement,
  lookup: Lookup,
): Promise<unknown> {
  const bases = statement.parameters.map((type) => lookup.type(type).base);
  const planned = bases.some(
    (base, index) => base !== statement.parameters[index],
  )
    ? PLAN
    : QUERY;
  const values =
    bases.length === 0 ? "" : `(${bases.map(() => "null").join(", ")})`;
  let prepared = false;

  try {
    if (planned === PLAN) {
      await wire.prepare(PLAN, file.text, bases);
      prepared = true;
    }

    const [row] = await wire.query(
      `explain (verbose, format json) execute ${planned}${values}`,
    );

    return JSON.parse(row?.[0] ?? "null");
  } catch (error) {
    if (isRefusal(error)) {
      return undefined;
    }

    throw error;
  } finally {
    if (prepared) {
      await wire.query(`deallocate ${PLAN}`);
    }
  }
}

/** The plans under a node. */
function plansOf(node: PlanNode): readonly PlanNode[] {
  return Array.isArray(node.Plans) ? (node.Plans as PlanNode[]) : [];
}

/** Whether an error is Postgres refusing a statement, the session going on. */
function isRefusal(error: unknown): error is SQL.PostgresError {
  return (
    error instanceof SQL.PostgresError &&
    error.errno !== undefined &&
    error.severity !== "FATAL" &&
    error.severity !== "PANIC"
  );
}

/**
 * Postgres's refusal of a file's query, as a line: where in the file, what
 * is wrong, with each parameter by its name, and how to mend it.
 */
function problemOf(file: QueryFile, error: SQL.PostgresError): string {
  const position = Number(error.position);
  const where =
    Number.isInteger(position) && position > 0 ? file.at(position) : file.path;

  if (error.message === MULTIPLE) {
    return `${where}: holds more than one statement: a file holds one query`;
  }

  const indeterminate = /parameter (\$\d+)/.exec(error.message)?.[1];
  const hint =
    error.errno === "42P18" && indeterminate !== undefined
      ? `give it a type with a cast, as ${indeterminate}::text`
      : error.hint;

  return `${where}: ${named(file, error.message)}${hint === undefined ? "" : ` (hint: ${named(file, hint)})`}`;
}

/**
 * Where a query's text writes a literal, as the index of its first
 * character: a string as SQL quotes it, an integer as a word of its own.
 * -1 when it does not write it, as when a view the query reads does.
 */
function placeOf(text: string, value: string | number): number {
  return typeof value === "string"
    ? text.indexOf(sqlLiteral(value))
    : (new RegExp(String.raw`(?<![\w$.'])${value}(?![\w.'])`).exec(text)
        ?.index ?? -1);
}

/**
 * A literal compared with a column that never holds it, as a line: where
 * the file writes it, the column, and what the column holds.
 */
function outsideLine(file: QueryFile, outside: Outside, at: number): string {
  return `${file.at([...file.text.slice(0, at)].length + 1)}: ${outside.column} never holds ${sqlLiteral(outside.value)}, only ${outside.allowed.map(sqlLiteral).join(", ")}`;
}

/** A value as SQL writes it: a string quoted, an integer as it is. */
function sqlLiteral(value: string | number): string {
  return typeof value === "string"
    ? `'${value.replaceAll("'", "''")}'`
    : String(value);
}

/** A message of Postgres's, with its `$1`s as the parameters' names. */
function named(file: QueryFile, text: string): string {
  return text.replace(/\$(\d+)/g, (number, digits: string) => {
    const parameter = file.parameters[Number(digits) - 1];

    return parameter === undefined ? number : `:${parameter.name}`;
  });
}
