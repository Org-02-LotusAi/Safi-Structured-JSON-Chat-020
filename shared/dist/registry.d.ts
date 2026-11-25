import type { ValidateFunction } from 'ajv/dist/2020.js';
export declare class RegistryError extends Error {
    constructor(message: string);
}
export interface RegistryEntry {
    id: string;
    version: string;
    sha256: string;
    label: string;
    ui_choice: boolean;
    schema: Record<string, unknown>;
    validate: ValidateFunction;
}
export interface Registry {
    list(): RegistryEntry[];
    get(id: string, version?: string): RegistryEntry | undefined;
    getLatest(id: string): RegistryEntry | undefined;
}
/** Keywords permitted in a reply schema (OpenAI strict subset) plus metadata. */
export declare const ALLOWED_KEYWORDS: Set<string>;
/** Recursively checks a reply schema against the strict subset. Returns problems (empty = ok). */
export declare function checkStrictSubset(schema: unknown, at?: string): string[];
/** Loads registry.json, verifies every digest and the strict subset, compiles validators. Throws RegistryError. */
export declare function loadRegistry(schemasDir?: string): Registry;
