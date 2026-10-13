/**
 * The plugin that writes a JavaScript array to a column of arrays as the
 * literal of a Postgres array: Bun cannot bind an array
 * (oven-sh/bun#29551), and a literal bound as text is read by the column's
 * own type.
 *
 * The generated file names the columns of arrays, and an array becomes a
 * literal where a query says it goes to one: a value of an insert, an
 * upsert or a merge, a `set` of an update, a value compared with such a
 * column of the same query, and the argument of `any()` or `all()`, which
 * only an array can be. Anywhere else it is bound as it is: a column of
 * jsonb, which Bun writes an array to as JSON, raw SQL, the argument of
 * another function.
 *
 * Comparing a column of arrays with an array also mends a habit of
 * Kysely's: `where("tags", "@>", ["gift"])`, whose types take the array,
 * is built as a list, `"tags" @> ($1)`, which Postgres refuses.
 *
 * @module
 */

import type {
  BinaryOperationNode,
  ColumnUpdateNode,
  FunctionNode,
  InsertQueryNode,
  KyselyPlugin,
  MergeQueryNode,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryId,
  QueryResult,
  RootOperationNode,
  UnknownRow,
  UpdateQueryNode,
} from "kysely";
import {
  AliasNode,
  ColumnNode,
  IdentifierNode,
  JoinNode,
  OperationNodeTransformer,
  OperatorNode,
  PrimitiveValueListNode,
  QueryNode,
  ReferenceNode,
  TableNode,
  UsingNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
} from "kysely";
import type { Schema } from "./schema.ts";
import { arrayLiteral } from "./values.ts";

/** The columns of arrays of each relation, with how their literals are written. */
type Arrays = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The functions whose one argument can only be an array. */
const QUANTIFIERS: ReadonlySet<string> = new Set(["any", "all", "some"]);

/** How the literal of an array whose element type is not known is written. */
const COMMA = ",";

/**
 * The plugin, for the columns of arrays the generated file names. It keeps
 * one transformer, and resets it after each query, whether it was
 * transformed or not: a query is transformed whole before the next one is.
 */
export class ArraysPlugin implements KyselyPlugin {
  private readonly transformer: Transformer;

  constructor(arrays: Schema<unknown>["arrays"]) {
    this.transformer = new Transformer(
      new Map(
        Object.entries(arrays).map(([relation, columns]) => [
          relation,
          new Map(Object.entries(columns)),
        ]),
      ),
    );
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    try {
      return this.transformer.transformNode(args.node, args.queryId);
    } finally {
      this.transformer.reset();
    }
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/**
 * A relation a query reads or writes, as its columns are qualified: by its
 * alias, or by its own name. A schema that qualifies a column too cannot
 * name another relation: a query naming two of one name is refused.
 */
interface Source {
  /** The name that qualifies its columns: its alias, or its own name. */
  readonly name: string;

  /** Its key in `DB`; nothing when it is not a relation of `DB`. */
  readonly key: string | undefined;
}

/**
 * Turns arrays into literals across one query, keeping track of the
 * relations of each query, subqueries included, as it goes down.
 */
class Transformer extends OperationNodeTransformer {
  private readonly arrays: Arrays;

  /** The relations of each query being transformed, innermost last. */
  private readonly scopes: (readonly Source[])[] = [];

  /** The names of the CTEs each query being transformed defines. */
  private readonly ctes: (readonly string[])[] = [];

  /** The relation each merge being transformed writes to. */
  private readonly merges: (string | undefined)[] = [];

  constructor(arrays: Arrays) {
    super();
    this.arrays = arrays;
  }

  /**
   * Forgets what a transform left behind: Kysely's own stack of the nodes
   * it is in, which a transform that throws, on an invalid `Date`, leaves
   * as it was.
   */
  reset(): void {
    this.nodeStack.length = 0;
  }

  protected override transformNodeImpl<T extends OperationNode>(
    node: T,
    queryId?: QueryId,
  ): T {
    if (!QueryNode.is(node)) {
      return super.transformNodeImpl(node, queryId);
    }

    this.ctes.push(
      node.with?.expressions.map(
        (expression) => expression.name.table.table.identifier.name,
      ) ?? [],
    );
    this.scopes.push(this.sourcesOf(node));

    try {
      return super.transformNodeImpl(node, queryId);
    } finally {
      this.scopes.pop();
      this.ctes.pop();
    }
  }

  protected override transformInsertQuery(
    node: InsertQueryNode,
    queryId?: QueryId,
  ): InsertQueryNode {
    const transformed = super.transformInsertQuery(node, queryId);
    const columns = this.columnsOf(
      node.into === undefined ? this.merges.at(-1) : this.keyOf(node.into),
    );

    if (columns === undefined) {
      return transformed;
    }

    const { values, onConflict } = transformed;

    return {
      ...transformed,
      ...(values !== undefined &&
      ValuesNode.is(values) &&
      transformed.columns !== undefined
        ? { values: rowsOf(values, transformed.columns, columns) }
        : {}),
      ...(onConflict?.updates === undefined
        ? {}
        : {
            onConflict: {
              ...onConflict,
              updates: updatesOf(onConflict.updates, columns),
            },
          }),
    };
  }

  protected override transformUpdateQuery(
    node: UpdateQueryNode,
    queryId?: QueryId,
  ): UpdateQueryNode {
    const transformed = super.transformUpdateQuery(node, queryId);
    const columns = this.columnsOf(
      node.table === undefined
        ? this.merges.at(-1)
        : this.sourceOf(node.table)?.key,
    );

    return columns === undefined || transformed.updates === undefined
      ? transformed
      : { ...transformed, updates: updatesOf(transformed.updates, columns) };
  }

  protected override transformMergeQuery(
    node: MergeQueryNode,
    queryId?: QueryId,
  ): MergeQueryNode {
    this.merges.push(this.sourceOf(node.into)?.key);

    try {
      return super.transformMergeQuery(node, queryId);
    } finally {
      this.merges.pop();
    }
  }

  protected override transformBinaryOperation(
    node: BinaryOperationNode,
    queryId?: QueryId,
  ): BinaryOperationNode {
    const transformed = super.transformBinaryOperation(node, queryId);
    const operator = OperatorNode.is(transformed.operator)
      ? transformed.operator.operator
      : undefined;
    const list = operator === "in" || operator === "not in";
    const left = this.literalOf(transformed.leftOperand);

    if (left !== undefined) {
      const rightOperand = compared(transformed.rightOperand, left, list);

      return rightOperand === transformed.rightOperand
        ? transformed
        : { ...transformed, rightOperand };
    }

    const right = this.literalOf(transformed.rightOperand);

    if (right !== undefined) {
      const leftOperand = compared(transformed.leftOperand, right, list);

      return leftOperand === transformed.leftOperand
        ? transformed
        : { ...transformed, leftOperand };
    }

    return transformed;
  }

  protected override transformFunction(
    node: FunctionNode,
    queryId?: QueryId,
  ): FunctionNode {
    const transformed = super.transformFunction(node, queryId);
    const [argument, ...rest] = transformed.arguments;

    if (
      !QUANTIFIERS.has(transformed.func.toLowerCase()) ||
      argument === undefined ||
      rest.length > 0
    ) {
      return transformed;
    }

    const literal = writtenNode(argument, COMMA);

    return literal === argument
      ? transformed
      : { ...transformed, arguments: [literal] };
  }

  /** The relations a query reads or writes, by the names of their columns. */
  private sourcesOf(node: QueryNode): Source[] {
    const tables: OperationNode[] = [];

    if ("from" in node && node.from !== undefined) {
      tables.push(...node.from.froms);
    }

    if ("joins" in node && node.joins !== undefined) {
      tables.push(...node.joins.map((join) => join.table));
    }

    if ("table" in node && node.table !== undefined) {
      tables.push(node.table);
    }

    if ("into" in node && node.into !== undefined) {
      tables.push(node.into);
    }

    if ("using" in node && node.using !== undefined) {
      const { using } = node;

      if (UsingNode.is(using)) {
        tables.push(...using.tables);
      } else if (JoinNode.is(using)) {
        tables.push(using.table);
      }
    }

    return tables.flatMap((table) => this.sourceOf(table) ?? []);
  }

  /** A relation a query names, aliased or not; nothing for anything else. */
  private sourceOf(node: OperationNode): Source | undefined {
    if (TableNode.is(node)) {
      return { name: node.table.identifier.name, key: this.keyOf(node) };
    }

    if (AliasNode.is(node) && IdentifierNode.is(node.alias)) {
      return {
        name: node.alias.name,
        key: TableNode.is(node.node) ? this.keyOf(node.node) : undefined,
      };
    }

    return undefined;
  }

  /**
   * The key in `DB` of a table a query names. A name a CTE in reach has
   * taken is the CTE's, and no relation of `DB`.
   */
  private keyOf(table: TableNode): string | undefined {
    const { schema, identifier } = table.table;

    if (
      schema === undefined &&
      this.ctes.some((names) => names.includes(identifier.name))
    ) {
      return undefined;
    }

    return schema === undefined || schema.name === "public"
      ? identifier.name
      : `${schema.name}.${identifier.name}`;
  }

  /** The columns of arrays of a relation of `DB`, when it has any. */
  private columnsOf(
    key: string | undefined,
  ): ReadonlyMap<string, string> | undefined {
    return key === undefined ? undefined : this.arrays.get(key);
  }

  /**
   * How the literal of the column of arrays a reference names is written,
   * found among the relations of the query it is in; nothing when it names
   * no such column, or one of an outer query.
   */
  private literalOf(node: OperationNode): string | undefined {
    const reference = ReferenceNode.is(node) ? node : undefined;
    const column = reference === undefined ? node : reference.column;

    if (!ColumnNode.is(column)) {
      return undefined;
    }

    const qualifier = reference?.table?.table.identifier.name;

    for (const source of this.scopes.at(-1) ?? []) {
      const literal =
        qualifier === undefined || qualifier === source.name
          ? this.columnsOf(source.key)?.get(column.column.name)
          : undefined;

      if (literal !== undefined) {
        return literal;
      }
    }

    return undefined;
  }
}

/** The rows of an insert, their arrays written as literals by column. */
function rowsOf(
  values: ValuesNode,
  columns: readonly ColumnNode[],
  arrays: ReadonlyMap<string, string>,
): ValuesNode {
  const literals = columns.map((column) => arrays.get(column.column.name));

  if (literals.every((literal) => literal === undefined)) {
    return values;
  }

  return ValuesNode.create(
    values.values.map((row) =>
      PrimitiveValueListNode.is(row)
        ? PrimitiveValueListNode.create(
            row.values.map((value, index) => written(value, literals[index])),
          )
        : ValueListNode.create(
            row.values.map((value, index) =>
              writtenNode(value, literals[index]),
            ),
          ),
    ),
  );
}

/** The `set`s of an update, their arrays written as literals by column. */
function updatesOf(
  updates: readonly ColumnUpdateNode[],
  arrays: ReadonlyMap<string, string>,
): ColumnUpdateNode[] {
  return updates.map((update) => {
    const column = ReferenceNode.is(update.column)
      ? update.column.column
      : update.column;
    const literal = ColumnNode.is(column)
      ? arrays.get(column.column.name)
      : undefined;
    const value = writtenNode(update.value, literal);

    return value === update.value ? update : { ...update, value };
  });
}

/**
 * What a column of arrays is compared with: an array as a literal, and a
 * list Kysely built of one, but for `in`, as the array it was. A list of
 * `in` keeps its items, each array among them a literal.
 */
function compared(
  node: OperationNode,
  literal: string,
  list: boolean,
): OperationNode {
  if (PrimitiveValueListNode.is(node)) {
    return list
      ? PrimitiveValueListNode.create(
          node.values.map((value) => written(value, literal)),
        )
      : ValueNode.create(arrayLiteral(node.values, literal));
  }

  if (ValueListNode.is(node) && list) {
    return ValueListNode.create(
      node.values.map((value) => writtenNode(value, literal)),
    );
  }

  return writtenNode(node, literal);
}

/**
 * A value node of an array as a literal, when `literal` says how one is
 * written: when the column it goes to holds arrays.
 */
function writtenNode(
  node: OperationNode,
  literal: string | undefined,
): OperationNode {
  if (
    literal === undefined ||
    !ValueNode.is(node) ||
    !Array.isArray(node.value)
  ) {
    return node;
  }

  const replaced: ValueNode = {
    ...node,
    value: arrayLiteral(node.value, literal),
  };

  return replaced;
}

/**
 * A value of an array as a literal, when `literal` says how one is
 * written: when the column it goes to holds arrays.
 */
function written(value: unknown, literal: string | undefined): unknown {
  return literal !== undefined && Array.isArray(value)
    ? arrayLiteral(value, literal)
    : value;
}
