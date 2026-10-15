/**
 * What a check constraint promises about one column, read from the text
 * Postgres prints it back as (`pg_get_constraintdef`).
 *
 * Two promises narrow a type. A list — `check (kind in ('retail', 'bulk'))`
 * or `check (kind = 'retail')` — makes the column a union of literals.
 * `check (array_position(tags, null) is null)` makes the elements of an
 * array non-null. A check of any other shape promises nothing here, and a
 * shape that is not recognised in full is read as no promise at all: the
 * plainer type is the honest one.
 *
 * @module
 */

/** A column a check is about, or `VALUE`, the value of a domain. */
export type Target = { readonly column: string } | { readonly domain: true };

/** `= ANY (…)`: a list of values. */
const ANY = /^CHECK \(\((.+?) = ANY \((.+)\)\)\)$/;

/** `= …`: one value. */
const ONE = /^CHECK \(\((.+?) = ('(?:[^']|'')*'::[^,]+|-?\d+)\)\)$/;

/** No element is NULL. */
const NO_NULLS = /^CHECK \(\(array_position\((.+?), NULL::.+\) IS NULL\)\)$/;

/** An array of values, cast to `text[]` when the column is a `varchar`. */
const ARRAY = /^(?:\(ARRAY\[(.*)\]\)::[a-z ]+\[\]|ARRAY\[(.*)\])$/;

/**
 * The next value of a list: a quoted constant, cast to a type with no
 * modifier, or a bare integer. A cast such as `::varchar(1)` changes the
 * value, which then is not the one written.
 */
const ITEM = /^(?:'((?:[^']|'')*)'(?:::[^,(]+)?|(-?\d+))(?:, |$)/;

/**
 * The values the check allows, as Postgres prints them, when it is a list
 * of values for `target`. Strings are unquoted; a negative integer, which
 * Postgres prints as `'-3'::integer`, is `-3` like any other.
 */
export function valuesOf(
  definition: string,
  target: Target,
): string[] | undefined {
  const list = ANY.exec(definition);

  if (list !== null) {
    const array = ARRAY.exec(list[2] ?? "");

    return isTarget(list[1] ?? "", target)
      ? itemsOf(array?.[1] ?? array?.[2])
      : undefined;
  }

  const one = ONE.exec(definition);

  return one !== null && isTarget(one[1] ?? "", target)
    ? itemsOf(one[2])
    : undefined;
}

/** Whether the check keeps every element of the array `target` non-null. */
export function forbidsNullElements(
  definition: string,
  target: Target,
): boolean {
  const check = NO_NULLS.exec(definition);

  return check !== null && isTarget(check[1] ?? "", target);
}

/**
 * Whether an operand is the target: the keyword `VALUE`, or its column,
 * as it is or cast to `text`, as Postgres compares a `varchar`. A cast to
 * any other type compares the value as that type — `s::int4 in (1, 2)`
 * lets `'01'` in —, so it is not the target. Postgres quotes a column's
 * name unless it is lowercase letters, digits and underscores, so an
 * unquoted `VALUE` is never a column's.
 */
function isTarget(operand: string, target: Target): boolean {
  const bare =
    /^\((.+)\)::(?:text|character varying)$/.exec(operand)?.[1] ?? operand;
  const quoted = /^"((?:[^"]|"")*)"$/.exec(bare)?.[1]?.replaceAll('""', '"');

  if ("domain" in target) {
    return bare === "VALUE";
  }

  return quoted === undefined
    ? /^[a-z_][a-z0-9_$]*$/.test(bare) && bare === target.column
    : quoted === target.column;
}

/** The values of a list as Postgres prints it, or none when it is another shape. */
function itemsOf(list: string | undefined): string[] | undefined {
  if (list === undefined) {
    return undefined;
  }

  const values: string[] = [];
  let rest = list;

  while (rest !== "") {
    const item = ITEM.exec(rest);

    if (item === null) {
      return undefined;
    }

    values.push(item[1]?.replaceAll("''", "'") ?? item[2] ?? "");
    rest = rest.slice(item[0].length);
  }

  return values.length === 0 ? undefined : values;
}
