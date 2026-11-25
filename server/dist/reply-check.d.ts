import { type ErrorEnvelope, type RegistryEntry, type RequestEnvelope, type ResultEnvelope } from '@safi/shared';
export type ReplyVerdict = {
    kind: 'result';
    envelope: ResultEnvelope;
} | {
    kind: 'error';
    envelope: ErrorEnvelope;
}
/** `reason` is for server logs only; it is never sent to the browser. */
 | {
    kind: 'invalid';
    reason: string;
};
/**
 * Independent double-check of a worker reply: JSON parse, envelope schema, correlation and identity
 * fields against the request we sent, and (for results) the body against the registry validator.
 */
export declare function verifyReply(raw: Uint8Array, req: RequestEnvelope, entry: RegistryEntry): ReplyVerdict;
