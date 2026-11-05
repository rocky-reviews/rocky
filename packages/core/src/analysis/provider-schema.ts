/**
 * The JSON Schema a role sends to a provider, derived from the emitted Zod schema (H4-4, ADR
 * 0013 amendment).
 *
 * The sent schema guides and constrains the model; it never validates anything. Validation is
 * the port's `parse`, which runs the Zod schema itself, so a constraint that is rewritten here
 * is still enforced on the answer.
 *
 * One rewrite: a combinator (`anyOf`, `oneOf`, `allOf`) that sits **beside a `type`** is a
 * hand-written constraint on the typed value ("at least one of these fields"), added with
 * `.meta()` for the published analysis-document schema. Zod itself never emits that shape (a
 * union is a bare combinator; an enum is `type` + `enum`). Provider transforms do not take it:
 * the Anthropic SDK's structured-output transform refuses any variant without a `type` (the graph
 * role failed before a request was sent), and giving a variant `type: "object"` would be worse,
 * since the transform closes every object (`additionalProperties: false`, `properties: {}`) and
 * the variant would then forbid every property. So the combinator moves into the description,
 * in the same `{key: json}` fold the SDK uses for constraints it strips (`minLength`, ...): the
 * model still reads it; the schema stays well-typed everywhere.
 *
 * A combinator with no sibling `type` is a union and is left as it is.
 */

type Schema = Record<string, unknown>;

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

/** Keywords whose value is one subschema. */
const ONE = [
  "items",
  "additionalProperties",
  "not",
  "propertyNames",
  "if",
  "then",
  "else",
] as const;
/** Keywords whose value is a list of subschemas. */
const MANY = [...COMBINATORS, "prefixItems"] as const;
/** Keywords whose value maps names to subschemas. */
const MAP = [
  "properties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
] as const;

const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const includes = (keys: readonly string[], key: string): boolean => keys.includes(key);

const rewrite = (node: Schema): Schema => {
  // A combinator beside a type is folded into the description instead of being copied.
  const typed = typeof node["type"] === "string";
  const folded: string[] = [];
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (typed && includes(COMBINATORS, key) && Array.isArray(value)) {
      folded.push(`${key}: ${JSON.stringify(value)}`);
    } else if (includes(ONE, key) && isObject(value)) {
      out[key] = rewrite(value);
    } else if (includes(MANY, key) && Array.isArray(value)) {
      out[key] = value.map((entry: unknown) => (isObject(entry) ? rewrite(entry) : entry));
    } else if (includes(MAP, key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          isObject(entry) ? rewrite(entry) : entry,
        ]),
      );
    } else {
      out[key] = value;
    }
  }
  if (folded.length === 0) return out;
  const description = typeof out["description"] === "string" ? `${out["description"]}\n\n` : "";
  out["description"] = `${description}{${folded.join(", ")}}`;
  return out;
};

/** A copy of the emitted schema with every type-sided combinator folded into its description. */
export const providerJsonSchema = (schema: Readonly<Schema>): Schema => rewrite(schema);
