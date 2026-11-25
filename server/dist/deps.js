/** Thrown by a NatsRequester when no subscriber was listening: the request was never delivered. */
export class NoRespondersFailure extends Error {
    constructor(message = 'no responders') {
        super(message);
        this.name = 'NoRespondersFailure';
    }
}
export const systemClock = { now: () => Date.now() };
