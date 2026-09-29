import { documentFileBytes } from "../rpc.js";
/**
 * Bind a package reader to the original HTML file's address.
 * @param readRelated - Remote reader using the Session in the root HTML address.
 * @param address - root HTML file address.
 * @param lifetime - tab lifetime.
 * @returns a reader that strips URL query/fragment, decodes one path, and preserves Host failures.
 */
export function createReadHtmlRelative(readRelated, address, lifetime) {
    return async (reference, signal) => {
        const suffix = reference.search(/[?#]/u);
        const path = decodeURIComponent(suffix === -1 ? reference : reference.slice(0, suffix));
        if (path.length === 0 || /^(?:[a-z][a-z\d+.-]*:|[/\\])/iu.test(path) || path.includes('\0') || path.includes('\\')) {
            throw new Error('HTML dependency must use a relative file path');
        }
        const combined = AbortSignal.any([lifetime, signal]);
        combined.throwIfAborted();
        const result = await readRelated(address, path, combined);
        combined.throwIfAborted();
        if (!result.ok)
            throw new Error(result.error.message);
        return documentFileBytes(result.value);
    };
}
//# sourceMappingURL=read-relative.js.map