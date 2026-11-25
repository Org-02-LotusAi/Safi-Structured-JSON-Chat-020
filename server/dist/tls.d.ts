/** TLS is decided independently of proxy trust: cert+key => HTTPS; plain HTTP only when explicitly allowed. */
export declare function readTls(env: NodeJS.ProcessEnv, allowPlainHttp: boolean): {
    key: Buffer;
    cert: Buffer;
} | undefined;
