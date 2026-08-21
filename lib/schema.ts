/**
 * The slice of TypeBox this package used, as plain JSON Schema.
 *
 * `parameters` on a tool is JSON Schema by the time it reaches the model, and
 * Type.Object({...}) is a builder that produces exactly that. Depending on
 * typebox to build it makes the package undistributable: pi installs a package
 * by cloning it and does NOT install its dependencies, and typebox lives inside
 * pi's own node_modules where a cloned package cannot resolve it. That worked
 * only while these files were loaded from a checkout with its own node_modules,
 * which is the arrangement being removed.
 *
 * So this is not a rewrite for its own sake — it is what makes `pi install
 * https://github.com/rcrdortiz/phi` work at all. The package now has zero
 * runtime dependencies, which also means nothing to drift, audit, or lock.
 */

export interface Schema {
	type?: string;
	description?: string;
	[k: string]: unknown;
}

/** Marks a property optional; stripped from `required` by Obj(). */
const OPTIONAL = Symbol.for("phi.optional");

export const Type = {
	String(opts: { description?: string } = {}): Schema {
		return { type: "string", ...opts };
	},
	Number(opts: { description?: string } = {}): Schema {
		return { type: "number", ...opts };
	},
	Boolean(opts: { description?: string } = {}): Schema {
		return { type: "boolean", ...opts };
	},
	Array(items: Schema, opts: { description?: string } = {}): Schema {
		return { type: "array", items, ...opts };
	},
	Union(variants: Schema[], opts: { description?: string } = {}): Schema {
		return { anyOf: variants, ...opts };
	},
	Optional(schema: Schema): Schema {
		return { ...schema, [OPTIONAL]: true };
	},
	Object(properties: Record<string, Schema>, opts: { description?: string } = {}): Schema {
		const required = Object.entries(properties)
			.filter(([, v]) => !(v as Record<symbol, unknown>)[OPTIONAL])
			.map(([k]) => k);
		const cleaned: Record<string, Schema> = {};
		for (const [k, v] of Object.entries(properties)) {
			const { [OPTIONAL]: _drop, ...rest } = v as Record<string | symbol, unknown>;
			cleaned[k] = rest as Schema;
		}
		return { type: "object", ...(required.length ? { required } : {}), properties: cleaned, ...opts };
	},
};
