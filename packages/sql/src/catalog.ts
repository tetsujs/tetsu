/**
 * The catalog of a database the migrations built, read into what the
 * generated file says of it: its relations and their columns, its enums,
 * the lists its checks allow, and the names of its constraints; and into
 * what typing a query of a file takes of it: a column by the OID of its
 * relation and its number, a type by its OID.
 *
 * Names are ordered here, by their characters, and never by `order by`,
 * whose collation differs from one server to the next: the same
 * migrations give the same file wherever they are built.
 *
 * @module
 */

import type { SQL } from "bun";
import type { Target } from "./checks.ts";
import { forbidsNullElements, valuesOf } from "./checks.ts";
import type { PgType, Written } from "./pg-types.ts";
import { BUILT_IN, DEFINED, EXTENSION, INT8_AS_STRING } from "./pg-types.ts";
import { JSON_ELEMENTS } from "./values.ts";

/**
 * A type of the generated file that a column type is built from: one of
 * the {@link Written} column types, or one that makes or wraps them.
 */
export type Helper =
  | Written
  | "ArrayOf"
  | "ArrayOfNullable"
  | "ArrayLiteral"
  | "Unknown"
  | "Generated"
  | "GeneratedAlways";

/** A union of literals the file names: an enum, or a list a check allows. */
export interface Alias {
  /** Its name in the file. */
  readonly name: string;

  /** Its members, in their order: strings or integers. */
  readonly values: readonly (string | number)[];
}

/** A column, as the file types it. */
export interface Column {
  readonly name: string;

  /** Its type, before it is made nullable or generated. */
  readonly type: string;

  /** Whether it may hold NULL. */
  readonly nullable: boolean;

  /**
   * Whether Postgres writes it: on an insert that leaves it out
   * (`default`), or always (`always`).
   */
  readonly generated: "no" | "default" | "always";

  /** Its comment, and a note when its type is unknown. */
  readonly comment: string | undefined;

  /**
   * How the literal of its arrays is written, when it holds arrays: by the
   * delimiter of their elements, a comma for most types, or as
   * {@link JSON_ELEMENTS} for json and jsonb.
   */
  readonly literal: string | undefined;
}

/** A table, view or materialized view. */
export interface Table {
  /** Its name, with its schema unless that is `public`. */
  readonly key: string;
  readonly comment: string | undefined;
  readonly columns: readonly Column[];
}

/** What the generated file says of a database. */
export interface Model {
  /** Its tables, `public` first, then by schema and name. */
  readonly tables: readonly Table[];

  /** The unions of literals, by name. */
  readonly aliases: readonly Alias[];

  /** The helper types the columns are built from. */
  readonly helpers: ReadonlySet<Helper>;

  /** The names of its constraints, as an error names them. */
  readonly constraints: readonly string[];
}

/**
 * A TypeScript type a value is written in: a keyword or a class, such as
 * `string` or `Date`; an alias of the generated file; a union; or an
 * array, which a parameter takes `readonly`.
 */
export type TsType =
  | { readonly kind: "keyword"; readonly name: string }
  | { readonly kind: "alias"; readonly name: string }
  | { readonly kind: "union"; readonly members: readonly TsType[] }
  | {
      readonly kind: "array";
      readonly element: TsType;
      readonly readonly: boolean;
    };

/** What a value is in TypeScript: as Bun reads it, and as it is written. */
export interface Values {
  /** The type it reads as, NULL aside. */
  readonly reads: TsType;

  /** The type it is written as, NULL aside. */
  readonly writes: TsType;
}

/** A column of a relation the generated file describes. */
export interface ColumnOrigin {
  readonly values: Values;

  /** Whether it may hold NULL, as `DB` says. */
  readonly nullable: boolean;
}

/** A type, as a value of it reads and is written. */
export interface TypeOrigin {
  readonly values: Values;

  /**
   * How the literal of an array of it is written, when it is an array
   * type: by the delimiter of its elements, or as {@link JSON_ELEMENTS}.
   */
  readonly literal: string | undefined;

  /** The OID of the type under its domains: its own, when it is none. */
  readonly base: number;
}

/**
 * What typing a query of a file reads of the catalog, past the model. A
 * type is typed as a column of it with no checks of its own, by the
 * aliases the model has: a list of a domain no column holds narrows
 * nothing, as the model has no alias for it.
 */
export interface Lookup {
  /**
   * A column, by the OID of its relation and its number, when the model
   * describes the relation.
   */
  column(relation: number, position: number): ColumnOrigin | undefined;

  /** A type, by its OID. */
  type(type: number): TypeOrigin;

  /**
   * The values a column of a relation the model describes may hold, by
   * the names of its schema, its relation and itself: those of the list
   * or the enum that narrows it, or nothing when none does.
   */
  allowed(
    schema: string,
    relation: string,
    column: string,
  ): readonly (string | number)[] | undefined;
}

/** The catalog, read: the model, and what typing a query reads of it. */
export interface Catalog {
  readonly model: Model;
  readonly lookup: Lookup;
}

/** A relation, as the catalog lists it. */
interface RelationRow {
  readonly id: number;
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly comment: string | null;
}

/** A column, as the catalog lists it. */
interface ColumnRow {
  readonly relation: number;
  readonly name: string;
  readonly position: number;

  /**
   * Whether every row holds a value: `not null`, and on Postgres 18 not
   * `not valid`, which leaves the rows before it as they were.
   */
  readonly not_null: boolean;
  readonly has_default: boolean;
  readonly identity: string;
  readonly generated: string;
  readonly type: number;

  /**
   * Whether its collation tells values apart by their characters: one
   * that does not, such as a case-insensitive one, lets a list's check
   * pass values that are not in it.
   */
  readonly deterministic: boolean;
  readonly comment: string | null;
}

/** A type, as the catalog lists it. */
interface TypeRow {
  readonly id: number;
  readonly schema: string;
  readonly name: string;
  readonly kind: string;

  /**
   * Whether it is the array type of its element: `int2vector`, which
   * Postgres also lists with an element, is not.
   */
  readonly array: boolean;
  readonly element: number;
  readonly base: number;
  readonly not_null: boolean;

  /** Whether, being a domain, it has a default of its own. */
  readonly has_default: boolean;

  /** What separates its values in the literal of an array of it. */
  readonly delimiter: string;
}

/** A check of one column, or of a domain. */
interface CheckRow {
  readonly relation: number;
  readonly domain: number;
  readonly position: number | null;
  readonly definition: string;
}

/** The rows {@link readCatalog} reads. */
interface Rows {
  readonly relations: readonly RelationRow[];
  readonly columns: readonly ColumnRow[];
  readonly types: readonly TypeRow[];
  readonly labels: readonly { type: number; label: string }[];
  readonly checks: readonly CheckRow[];
  readonly names: readonly { name: string }[];
}

/** The schemas Postgres keeps for itself, left out. */
const USER_SCHEMA = "n.nspname <> 'information_schema' and n.nspname !~ '^pg_'";

/** The relations the file describes: no partition, and not the journal. */
const DESCRIBED = `c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
  and ${USER_SCHEMA} and c.oid is distinct from to_regclass($1)`;

/** Reads the model of the database `sql` is connected to, as {@link readCatalog}. */
export async function readModel(
  sql: SQL,
  journal: string,
  int8: "bigint" | "string" = "bigint",
): Promise<Model> {
  return (await readCatalog(sql, journal, int8)).model;
}

/**
 * Reads the catalog of the database `sql` is connected to. The journal,
 * schema-qualified as `migrate` resolved it before the migrations ran, is
 * left out with its constraints: resolved afterwards, its bare name could
 * find a table a migration made in a schema earlier in the `search_path`.
 * `int8` says what an `int8` reads as: a `bigint`, or a string.
 */
export async function readCatalog(
  sql: SQL,
  journal: string,
  int8: "bigint" | "string" = "bigint",
): Promise<Catalog> {
  const relations: RelationRow[] = await sql.unsafe(
    `select c.oid as id, n.nspname as schema, c.relname as name,
            c.relkind as kind, obj_description(c.oid, 'pg_class') as comment
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where ${DESCRIBED}`,
    [journal],
  );
  const columns: ColumnRow[] = await sql.unsafe(
    `select a.attrelid as relation, a.attname as name, a.attnum as position,
            a.attnotnull and not exists (
              select 1 from pg_constraint k
              where k.contype = 'n' and k.conrelid = a.attrelid
                and k.conkey = array[a.attnum] and not k.convalidated
            ) as not_null,
            a.atthasdef as has_default, a.attidentity as identity,
            a.attgenerated as generated, a.atttypid as type,
            coalesce(co.collisdeterministic, true) as deterministic,
            col_description(a.attrelid, a.attnum) as comment
     from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_collation co on co.oid = a.attcollation
     where ${DESCRIBED} and a.attnum > 0 and not a.attisdropped`,
    [journal],
  );
  const types: TypeRow[] = await sql.unsafe(
    `select t.oid as id, n.nspname as schema, t.typname as name,
            t.typtype as kind, coalesce(e.typarray = t.oid, false) as array,
            t.typelem as element, t.typbasetype as base,
            t.typnotnull as not_null, t.typdefaultbin is not null as has_default,
            t.typdelim as delimiter
     from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       left join pg_type e on e.oid = t.typelem`,
  );
  const labels: { type: number; label: string }[] = await sql.unsafe(
    "select enumtypid as type, enumlabel as label from pg_enum order by enumtypid, enumsortorder",
  );
  const checks: CheckRow[] = await sql.unsafe(
    `select k.conrelid as relation, k.contypid as domain,
            k.conkey[1] as position, pg_get_constraintdef(k.oid) as definition
     from pg_constraint k
     where k.contype = 'c' and (k.contypid <> 0 or cardinality(k.conkey) = 1)`,
  );
  const names: { name: string }[] = await sql.unsafe(
    `select k.conname as name
     from pg_constraint k join pg_namespace n on n.oid = k.connamespace
     where k.contype in ('p', 'u', 'f', 'c', 'x') and ${USER_SCHEMA}
       and k.conrelid is distinct from to_regclass($1)
       and not exists (
         select 1 from pg_class c where c.oid = k.conrelid and c.relkind = 'f'
       )
     union
     select i.relname
     from pg_index x
       join pg_class i on i.oid = x.indexrelid
       join pg_namespace n on n.oid = i.relnamespace
     where x.indisunique and ${USER_SCHEMA}
       and x.indrelid is distinct from to_regclass($1)
       and not exists (
         select 1 from pg_constraint k
         where k.conindid = x.indexrelid and k.contype in ('p', 'u', 'x')
       )`,
    [journal],
  );

  const builder = new Builder(
    { relations, columns, types, labels, checks, names },
    int8,
  );

  return {
    model: builder.model,
    lookup: {
      column: (relation, position) => builder.origin(relation, position),
      type: (type) => builder.typeOrigin(type),
      allowed: (schema, relation, column) =>
        builder.allowed(schema, relation, column),
    },
  };
}

/**
 * Names the file defines or uses, which an alias cannot take: an enum
 * named `date` would otherwise become the `Date` a timestamp reads as.
 */
const RESERVED = [
  "DB",
  "Constraint",
  "Schema",
  "ColumnType",
  "Timestamp",
  "CalendarDate",
  "Json",
  "Bytea",
  "Int8",
  "ArrayOf",
  "ArrayOfNullable",
  "ArrayLiteral",
  "Unknown",
  "Generated",
  "GeneratedAlways",
  "Date",
  "Buffer",
  "Uint8Array",
  "Record",
  "NonNullable",
];

/**
 * The types a list in a check narrows, past enums: those whose values read
 * as written. A `char(n)` reads padded, and a `citext` matches its list
 * whatever the case, so neither is narrowed.
 */
const LISTABLE: ReadonlySet<string> = new Set([
  "text",
  "varchar",
  "int2",
  "int4",
]);

/** The type a column, or an array element, reads as, with a note when unknown. */
interface Typed {
  readonly type: string;

  /** What its values are in TypeScript. */
  readonly values: Values;
  readonly note?: string;

  /** How the literal of its arrays is written, when it holds arrays. */
  readonly literal?: string;
}

/** What a column's checks and its domains' checks promise. */
interface Promises {
  /** The lists its domains' checks allow. */
  readonly domain: readonly (readonly string[])[];

  /** The lists its own checks allow. */
  readonly own: readonly (readonly string[])[];

  /** Whether a check keeps its array elements non-null. */
  readonly noNulls: boolean;
}

/** What a foreign table's constraints promise: nothing Postgres keeps. */
const NO_PROMISES: Promises = { domain: [], own: [], noNulls: false };

/** Builds the model of a catalog, naming aliases as it meets them. */
class Builder {
  private readonly catalog: Rows;

  /** What an `int8` reads as. */
  private readonly int8: "bigint" | "string";

  private readonly types: ReadonlyMap<number, TypeRow>;
  private readonly enums = new Map<number, string>();
  private readonly domains = new Map<number, string>();
  private readonly taken = new Set(RESERVED);
  private readonly aliases: Alias[] = [];
  private readonly helpers = new Set<Helper>();

  /** The columns of the model, by the OID of their relation and their number. */
  private readonly origins = new Map<string, ColumnOrigin>();

  /** The same columns, by the names of their schema, their relation and themselves. */
  private readonly named = new Map<string, ColumnOrigin>();

  /**
   * Whether the model is built: from then on, typing names no alias and
   * uses no helper, as the file is written already.
   */
  private frozen = false;

  /** The model, built on construction. */
  readonly model: Model;

  constructor(catalog: Rows, int8: "bigint" | "string") {
    this.catalog = catalog;
    this.int8 = int8;
    this.types = new Map(catalog.types.map((type) => [type.id, type]));

    const enums = catalog.types
      .filter((type) => type.kind === "e" && isUserSchema(type.schema))
      .toSorted((a, b) => compareBy(a, b, (type) => [type.schema, type.name]));

    for (const type of enums) {
      this.enums.set(
        type.id,
        this.alias(pascal(type.schema, type.name), this.labels(type)) as string,
      );
    }

    const tables = catalog.relations
      .toSorted((a, b) =>
        compareBy(a, b, (relation) => [
          relation.schema === "public" ? "0" : "1",
          relation.schema,
          relation.name,
        ]),
      )
      .map((relation) => this.table(relation));
    const keys = new Set<string>();

    for (const table of tables) {
      if (keys.has(table.key)) {
        throw new Error(
          `two relations would both be "${table.key}" in DB: one is named with a dot, and Kysely reads a dot as the end of a schema's name`,
        );
      }

      keys.add(table.key);
    }

    this.model = {
      tables,
      aliases: this.aliases.toSorted((a, b) => compare(a.name, b.name)),
      helpers: this.helpers,
      constraints: catalog.names.map((row) => row.name).toSorted(compare),
    };
    this.frozen = true;
  }

  /** A column of the model, by the OID of its relation and its number. */
  origin(relation: number, position: number): ColumnOrigin | undefined {
    return this.origins.get(`${relation}:${position}`);
  }

  /** {@link Lookup.allowed}. */
  allowed(
    schema: string,
    relation: string,
    column: string,
  ): readonly (string | number)[] | undefined {
    const reads = this.named.get(JSON.stringify([schema, relation, column]))
      ?.values.reads;

    return reads?.kind === "alias"
      ? this.aliases.find((alias) => alias.name === reads.name)?.values
      : undefined;
  }

  /**
   * A type, as a column of it with no checks of its own is typed: an
   * enum's alias, a domain's list by the alias the model has for it, or
   * what its type reads as.
   */
  typeOrigin(id: number): TypeOrigin {
    const declared = this.types.get(id);
    const base = this.unwrap(declared);

    if (declared === undefined || base === undefined) {
      return { values: UNKNOWN_VALUES, literal: undefined, base: id };
    }

    const promises = this.promises(declared, [], { column: "" }, true);

    return {
      values: base.array
        ? this.array(base, promises.noNulls).values
        : this.scalar(declared, base, promises, "").values,
      literal: base.array
        ? this.literalOf(this.types.get(base.element))
        : undefined,
      base: base.id,
    };
  }

  /**
   * A relation and its columns. Postgres cannot tell whether a view's
   * column holds NULL, and does not keep a foreign table's `not null`, so
   * their columns are nullable. A materialized view is written only by
   * refreshing it, so its columns are never written.
   */
  private table(relation: RelationRow): Table {
    const unkept =
      relation.kind === "v" || relation.kind === "m" || relation.kind === "f";
    const columns = this.catalog.columns
      .filter((column) => column.relation === relation.id)
      .toSorted((a, b) => a.position - b.position)
      .map((column): Column => {
        const typed = this.column(relation, column);
        const declared = this.types.get(column.type);
        const nullable =
          unkept ||
          !(
            column.not_null ||
            (declared !== undefined && this.domainNotNull(declared))
          );
        const comment = [column.comment, typed.note]
          .filter((part) => typeof part === "string")
          .join("\n\n");
        const generated =
          relation.kind === "m" ||
          column.identity === "a" ||
          column.generated !== ""
            ? "always"
            : column.identity === "d" ||
                column.has_default ||
                (declared !== undefined && this.domainDefault(declared))
              ? "default"
              : "no";
        const type =
          typed.type === "unknown" && !nullable ? "Unknown" : typed.type;

        if (type === "Unknown") {
          this.use("Unknown");
        }

        if (generated === "always") {
          this.use("GeneratedAlways");
        } else if (generated === "default") {
          this.use("Generated");
        }

        const origin = { values: typed.values, nullable };

        this.origins.set(`${relation.id}:${column.position}`, origin);
        this.named.set(
          JSON.stringify([relation.schema, relation.name, column.name]),
          origin,
        );

        return {
          name: column.name,
          type,
          nullable,
          generated,
          comment: comment === "" ? undefined : comment,
          literal: typed.literal,
        };
      });

    return {
      key:
        relation.schema === "public"
          ? relation.name
          : `${relation.schema}.${relation.name}`,
      comment: relation.comment ?? undefined,
      columns,
    };
  }

  /**
   * The type of a column: an array, or a scalar. A foreign table's checks
   * are not Postgres's to keep, so they promise nothing.
   */
  private column(relation: RelationRow, column: ColumnRow): Typed {
    const declared = this.types.get(column.type);
    const base = this.unwrap(declared);

    if (declared === undefined || base === undefined) {
      return unknownType(String(column.type));
    }

    const own = this.catalog.checks.filter(
      (row) => row.relation === relation.id && row.position === column.position,
    );
    const promises =
      relation.kind === "f"
        ? NO_PROMISES
        : this.promises(
            declared,
            own,
            { column: column.name },
            column.deterministic,
          );
    const owner = pascal(relation.schema, `${relation.name}_${column.name}`);

    if (base.array) {
      return {
        ...this.array(base, promises.noNulls),
        literal: this.literalOf(this.types.get(base.element)),
      };
    }

    return this.scalar(declared, base, promises, owner);
  }

  /**
   * An array: of what Bun parses, `ArrayOf` or `ArrayOfNullable`;
   * otherwise `ArrayLiteral`. Its elements are typed as a column of their
   * own: a `timestamp` as a `Timestamp`, which they read and are written as.
   */
  private array(array: TypeRow, noNulls: boolean): Typed {
    const declared = this.types.get(array.element);
    const element = this.unwrap(declared);
    const pg = element === undefined ? undefined : this.pg(element);

    if (declared === undefined || element === undefined || pg === undefined) {
      return unknownType(`${declared?.name ?? array.name}[]`);
    }

    if (pg.arrays && declared.kind !== "d" && element.kind !== "e") {
      const helper = noNulls ? "ArrayOf" : "ArrayOfNullable";
      const { reads, writes } = pgValues(pg);

      this.use(helper);

      if (pg.written !== undefined) {
        this.use(pg.written);
      }

      return {
        type: `${helper}<${pg.written ?? pg.reads}>`,
        values: {
          reads: arrayOf(reads, !noNulls, false),
          writes: arrayOf(writes, !noNulls, true),
        },
      };
    }

    const promises = this.promises(declared, [], { column: "" }, true);
    const scalar = this.scalar(declared, element, promises, "");

    this.use("ArrayLiteral");

    return {
      type: `ArrayLiteral<${scalar.type}>`,
      values: {
        reads: keyword("string"),
        writes: arrayOf(scalar.values.writes, false, true),
      },
    };
  }

  /**
   * A scalar: an enum's alias, a list's alias, or what its type reads as.
   * Lists narrow an enum, `text`, `varchar`, `int2` and `int4`, to what
   * all of them allow.
   */
  private scalar(
    declared: TypeRow,
    base: TypeRow,
    promises: Promises,
    owner: string,
  ): Typed {
    const pg = this.pg(base);

    if (pg === undefined) {
      return unknownType(base.name);
    }

    const enumAlias = this.enums.get(base.id);
    const labels = base.kind === "e" ? this.labels(base) : undefined;
    const lists = [...promises.domain, ...promises.own];
    const listable =
      labels !== undefined ||
      (base.schema === "pg_catalog" && LISTABLE.has(base.name));
    const numeric = pg.reads === "number";
    const allowed =
      lists.length === 0 || !listable
        ? undefined
        : lists.reduce<readonly string[]>(
            (values, list) => values.filter((value) => list.includes(value)),
            labels ?? lists[0] ?? [],
          );

    if (
      allowed !== undefined &&
      !(labels !== undefined && allowed.length === labels.length)
    ) {
      const values = allowed.map((value) => (numeric ? Number(value) : value));
      const named =
        promises.own.length === 0 && declared.kind === "d"
          ? this.domainAlias(declared, values)
          : this.alias(owner, values);

      if (named !== undefined) {
        return { type: named, values: same({ kind: "alias", name: named }) };
      }
    }

    if (enumAlias !== undefined) {
      return {
        type: enumAlias,
        values: same({ kind: "alias", name: enumAlias }),
      };
    }

    if (pg.written !== undefined) {
      this.use(pg.written);
    }

    return { type: pg.written ?? pg.reads, values: pgValues(pg) };
  }

  /**
   * What the checks of a type's domains, and the column's own, promise.
   * A column whose collation does not tell values apart by their
   * characters lets its own lists pass values outside them, so they
   * promise nothing; a domain's checks hold whatever the column's.
   */
  private promises(
    declared: TypeRow,
    own: readonly CheckRow[],
    target: Target,
    deterministic: boolean,
  ): Promises {
    const domain: string[][] = [];
    const lists: string[][] = [];
    let noNulls = false;

    for (
      let current: TypeRow | undefined = declared;
      current?.kind === "d";
      current = this.types.get(current.base)
    ) {
      const id = current.id;

      for (const row of this.catalog.checks) {
        if (row.domain === id) {
          const values = valuesOf(row.definition, { domain: true });

          if (values !== undefined) {
            domain.push(values);
          }

          noNulls ||= forbidsNullElements(row.definition, { domain: true });
        }
      }
    }

    for (const row of own) {
      const values = valuesOf(row.definition, target);

      if (values !== undefined && deterministic) {
        lists.push(values);
      }

      noNulls ||= forbidsNullElements(row.definition, target);
    }

    return { domain, own: lists, noNulls };
  }

  /** How a type reads: an `int8` as {@link Builder.int8} says. */
  private pg(type: TypeRow): PgType | undefined {
    return this.int8 === "string" &&
      type.schema === "pg_catalog" &&
      type.name === "int8"
      ? INT8_AS_STRING
      : pgTypeOf(type);
  }

  /**
   * How the literal of an array of `element` is written: as JSON for json
   * and jsonb, under their domains too, otherwise by the delimiter of the
   * element type.
   */
  private literalOf(element: TypeRow | undefined): string {
    const base = this.unwrap(element);

    return base !== undefined && pgTypeOf(base)?.written === "Json"
      ? JSON_ELEMENTS
      : (element?.delimiter ?? ",");
  }

  /**
   * The alias of a domain's list, named once for all its columns: none,
   * once the model is built, for a domain it has no alias for.
   */
  private domainAlias(
    domain: TypeRow,
    values: readonly (string | number)[],
  ): string | undefined {
    const named =
      this.domains.get(domain.id) ??
      this.alias(pascal(domain.schema, domain.name), values);

    if (named !== undefined) {
      this.domains.set(domain.id, named);
    }

    return named;
  }

  /**
   * Names an alias, after a number when another has taken its name: none,
   * once the model is built.
   */
  private alias(
    wanted: string,
    values: readonly (string | number)[],
  ): string | undefined {
    if (this.frozen) {
      return undefined;
    }

    let name = wanted;

    for (let suffix = 2; this.taken.has(name); suffix += 1) {
      name = `${wanted}${suffix}`;
    }

    this.taken.add(name);
    this.aliases.push({ name, values });

    return name;
  }

  /** Marks a helper type as used by the file, while it is being built. */
  private use(helper: Helper): void {
    if (!this.frozen) {
      this.helpers.add(helper);
    }
  }

  /** An enum's labels, in their order. */
  private labels(type: TypeRow): string[] {
    return this.catalog.labels
      .filter((row) => row.type === type.id)
      .map((row) => row.label);
  }

  /** The type under a type's domains. */
  private unwrap(type: TypeRow | undefined): TypeRow | undefined {
    let current = type;

    while (current?.kind === "d") {
      current = this.types.get(current.base);
    }

    return current;
  }

  /** Whether one of a type's domains has a default. */
  private domainDefault(type: TypeRow): boolean {
    for (
      let current: TypeRow | undefined = type;
      current?.kind === "d";
      current = this.types.get(current.base)
    ) {
      if (current.has_default) {
        return true;
      }
    }

    return false;
  }

  /** Whether one of a type's domains is `not null`. */
  private domainNotNull(type: TypeRow): boolean {
    for (
      let current: TypeRow | undefined = type;
      current?.kind === "d";
      current = this.types.get(current.base)
    ) {
      if (current.not_null) {
        return true;
      }
    }

    return false;
  }
}

/** What a value of a type the generator does not know is. */
const UNKNOWN_VALUES: Values = same(keyword("unknown"));

/**
 * What a value of each of the column types is, which the helper types of
 * the file define: as it reads, and as it is written.
 */
const WRITTEN_VALUES: Readonly<Record<Written, Values>> = {
  Timestamp: {
    reads: keyword("Date"),
    writes: union(keyword("Date"), keyword("string")),
  },
  CalendarDate: {
    reads: keyword("Date"),
    writes: union(keyword("Date"), keyword("string")),
  },
  Json: { reads: keyword("unknown"), writes: keyword("object") },
  Bytea: { reads: keyword("Buffer"), writes: keyword("Uint8Array") },
  Int8: {
    reads: keyword("string"),
    writes: union(keyword("string"), keyword("number"), keyword("bigint")),
  },
};

/** An unknown type, with the note that says so. */
function unknownType(name: string): Typed {
  return {
    type: "unknown",
    values: UNKNOWN_VALUES,
    note: `\`${name}\`: a type the generator does not know, so its values are not typed.`,
  };
}

/** What a value of a type the table knows is. */
function pgValues(pg: PgType): Values {
  return pg.written === undefined
    ? same(keyword(pg.reads))
    : WRITTEN_VALUES[pg.written];
}

/** Values that read as they are written. */
function same(type: TsType): Values {
  return { reads: type, writes: type };
}

function keyword(name: string): TsType {
  return { kind: "keyword", name };
}

/** A union of `members`, their own unions taken apart. */
function union(...members: TsType[]): TsType {
  return {
    kind: "union",
    members: members.flatMap((member) =>
      member.kind === "union" ? member.members : [member],
    ),
  };
}

/** An array of `element`, or of it and NULL. */
function arrayOf(element: TsType, nulls: boolean, readonly: boolean): TsType {
  return {
    kind: "array",
    element: nulls ? union(element, keyword("null")) : element,
    readonly,
  };
}

/** How a type reads, or nothing when the table does not know it. */
function pgTypeOf(type: TypeRow): PgType | undefined {
  if (type.schema === "pg_catalog") {
    return BUILT_IN[type.name] ?? DEFINED[type.kind];
  }

  return type.kind === "b" ? EXTENSION[type.name] : DEFINED[type.kind];
}

/** Whether a schema is the application's, not one Postgres keeps. */
function isUserSchema(schema: string): boolean {
  return schema !== "information_schema" && !schema.startsWith("pg_");
}

/** Orders strings by their characters, whatever the locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders two values by the strings `by` gives, the first that differ. */
function compareBy<T>(a: T, b: T, by: (value: T) => readonly string[]): number {
  const left = by(a);
  const right = by(b);

  for (const [index, part] of left.entries()) {
    const order = compare(part, right[index] ?? "");

    if (order !== 0) {
      return order;
    }
  }

  return 0;
}

/**
 * A type name in PascalCase, with its schema unless that is `public`:
 * `order_status` is `OrderStatus`, `billing.order_status` is
 * `BillingOrderStatus`. Only characters an identifier may hold are kept,
 * and a name that would not start as one starts with an underscore.
 */
function pascal(schema: string, name: string): string {
  const joined = `${schema === "public" ? "" : `${schema}_`}${name}`
    .split(/[_\P{ID_Continue}]+/u)
    .filter((word) => word !== "")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join("");

  return /^\p{ID_Start}/u.test(joined) ? joined : `_${joined}`;
}
