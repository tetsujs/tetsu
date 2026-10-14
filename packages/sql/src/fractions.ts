/**
 * The plugin that writes a number that is not whole as its text where a
 * query puts it in a column: a value of an insert, an upsert or a merge,
 * and a `set` of an update. Bun binds such a number as a `float8`, which
 * an integer column rounds to the even without an error, `2.5` as `2`. As
 * text, Postgres reads it as the column's type: an integer column refuses
 * it, and a `float8`, a `float4` or a `numeric` reads the number it is.
 *
 * A number anywhere else — compared with a column, in arithmetic, the
 * argument of a function — is bound as Bun binds it, a `float8`, which
 * means there what it says, as in `where("rank", ">", 2.5)`. So is one in
 * raw SQL, which says nothing of where a value goes.
 *
 * @module
 */

import type {
  ColumnUpdateNode,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryId,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";
import {
  InsertQueryNode,
  MergeQueryNode,
  OperationNodeTransformer,
  PrimitiveValueListNode,
  UpdateQueryNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
} from "kysely";

/**
 * The plugin. A query that writes no row, or no number that is not whole,
 * is left as it is: the transformer rebuilds every node of a query it
 * reads, and most queries write none.
 */
export class FractionsPlugin implements KyselyPlugin {
  private readonly transformer = new Transformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return writes(args.node) && holdsFraction(args.node)
      ? this.transformer.transformNode(args.node, args.queryId)
      : args.node;
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/** Writes each number of a query's rows and `set`s that is not whole as its text. */
class Transformer extends OperationNodeTransformer {
  protected override transformInsertQuery(
    node: InsertQueryNode,
    queryId?: QueryId,
  ): InsertQueryNode {
    const transformed = super.transformInsertQuery(node, queryId);
    const { values } = transformed;

    if (values === undefined || !ValuesNode.is(values)) {
      return transformed;
    }

    return {
      ...transformed,
      values: ValuesNode.create(
        values.values.map((row) =>
          PrimitiveValueListNode.is(row)
            ? PrimitiveValueListNode.create(row.values.map(written))
            : ValueListNode.create(row.values.map(writtenNode)),
        ),
      ),
    };
  }

  protected override transformColumnUpdate(
    node: ColumnUpdateNode,
    queryId?: QueryId,
  ): ColumnUpdateNode {
    const transformed = super.transformColumnUpdate(node, queryId);
    const value = writtenNode(transformed.value);

    return value === transformed.value
      ? transformed
      : { ...transformed, value };
  }
}

/**
 * Whether a query may write a row: an insert, an update or a merge, or a
 * query with a CTE, which can be one of them.
 */
function writes(node: RootOperationNode): boolean {
  return (
    InsertQueryNode.is(node) ||
    UpdateQueryNode.is(node) ||
    MergeQueryNode.is(node) ||
    ("with" in node && node.with !== undefined)
  );
}

/** Whether a number is one Bun would bind as a `float8`: not whole. */
function isFraction(value: unknown): value is number {
  return typeof value === "number" && !Number.isInteger(value);
}

/** Whether a query holds a number that is not whole, as a value or in a list. */
function holdsFraction(node: OperationNode): boolean {
  if (ValueNode.is(node)) {
    return isFraction(node.value);
  }

  if (PrimitiveValueListNode.is(node)) {
    return node.values.some(isFraction);
  }

  for (const key in node) {
    const child = (node as unknown as Readonly<Record<string, unknown>>)[key];

    if (
      Array.isArray(child)
        ? child.some(holdsFractionIn)
        : holdsFractionIn(child)
    ) {
      return true;
    }
  }

  return false;
}

/** Whether `value` is a node, and one that holds a number that is not whole. */
function holdsFractionIn(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly kind?: unknown }).kind === "string" &&
    holdsFraction(value as OperationNode)
  );
}

/** A value a row puts in a column: a number that is not whole as its text. */
function written(value: unknown): unknown {
  return isFraction(value) ? String(value) : value;
}

/**
 * A value node a row or a `set` puts in a column: one of a number that is
 * not whole as its text, unless it is written into the SQL itself, as
 * `sql.lit()` writes one.
 */
function writtenNode(node: OperationNode): OperationNode {
  if (
    !ValueNode.is(node) ||
    node.immediate === true ||
    !isFraction(node.value)
  ) {
    return node;
  }

  const replaced: ValueNode = { ...node, value: String(node.value) };

  return replaced;
}
