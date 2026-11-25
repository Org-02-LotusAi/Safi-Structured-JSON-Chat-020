import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createAjv, DEFAULT_SCHEMAS_DIR } from './validators.js';
export class RegistryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RegistryError';
    }
}
/** Keywords permitted in a reply schema (OpenAI strict subset) plus metadata. */
export const ALLOWED_KEYWORDS = new Set([
    'type', 'properties', 'required', 'additionalProperties', 'enum', 'items', 'description',
    '$schema', '$id', 'title',
]);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Recursively checks a reply schema against the strict subset. Returns problems (empty = ok). */
export function checkStrictSubset(schema, at = '#') {
    if (!isObj(schema))
        return [`${at}: schema must be an object`];
    const problems = [];
    for (const key of Object.keys(schema)) {
        if (!ALLOWED_KEYWORDS.has(key))
            problems.push(`${at}: unsupported keyword "${key}"`);
    }
    if (schema.type === 'object') {
        if (schema.additionalProperties !== false)
            problems.push(`${at}: object must set additionalProperties:false`);
        const props = isObj(schema.properties) ? Object.keys(schema.properties) : [];
        const req = Array.isArray(schema.required) ? schema.required : [];
        if (props.some((p) => !req.includes(p)))
            problems.push(`${at}: every property must be listed in required`);
    }
    if (isObj(schema.properties)) {
        for (const [k, v] of Object.entries(schema.properties))
            problems.push(...checkStrictSubset(v, `${at}/properties/${k}`));
    }
    if (schema.items !== undefined)
        problems.push(...checkStrictSubset(schema.items, `${at}/items`));
    return problems;
}
function compareSemver(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
/** Loads registry.json, verifies every digest and the strict subset, compiles validators. Throws RegistryError. */
export function loadRegistry(schemasDir = DEFAULT_SCHEMAS_DIR) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(schemasDir, 'registry.json'), 'utf8'));
    }
    catch (e) {
        throw new RegistryError(`cannot read registry.json: ${e.message}`);
    }
    if (!isObj(manifest) || !Array.isArray(manifest.schemas) || manifest.schemas.length === 0) {
        throw new RegistryError('registry.json must contain a non-empty "schemas" array');
    }
    const ajv = createAjv();
    const entries = [];
    for (const raw of manifest.schemas) {
        if (!isObj(raw) || ![raw.id, raw.version, raw.file, raw.sha256, raw.label].every((x) => typeof x === 'string')) {
            throw new RegistryError('registry entry is missing id/version/file/sha256/label');
        }
        const { id, version, file, sha256, label } = raw;
        if (path.basename(file) !== file)
            throw new RegistryError(`${id}@${version}: file must be a plain file name`);
        if (entries.some((e) => e.id === id && e.version === version))
            throw new RegistryError(`duplicate registry entry ${id}@${version}`);
        let bytes;
        try {
            bytes = fs.readFileSync(path.join(schemasDir, file));
        }
        catch (e) {
            throw new RegistryError(`${id}@${version}: cannot read ${file}: ${e.message}`);
        }
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== sha256)
            throw new RegistryError(`${id}@${version}: SHA-256 mismatch for ${file} (expected ${sha256}, got ${actual})`);
        let schema;
        try {
            schema = JSON.parse(bytes.toString('utf8'));
        }
        catch (e) {
            throw new RegistryError(`${id}@${version}: ${file} is not valid JSON: ${e.message}`);
        }
        const problems = checkStrictSubset(schema);
        if (problems.length > 0)
            throw new RegistryError(`${id}@${version}: ${problems.join('; ')}`);
        let validate;
        try {
            validate = ajv.compile(schema);
        }
        catch (e) {
            throw new RegistryError(`${id}@${version}: schema failed to compile: ${e.message}`);
        }
        entries.push({ id, version, sha256, label, ui_choice: raw.ui_choice === true, schema, validate });
    }
    const getLatest = (id) => entries.filter((e) => e.id === id).sort((a, b) => compareSemver(b.version, a.version))[0];
    return {
        list: () => [...entries],
        get: (id, version) => (version === undefined ? getLatest(id) : entries.find((e) => e.id === id && e.version === version)),
        getLatest,
    };
}
