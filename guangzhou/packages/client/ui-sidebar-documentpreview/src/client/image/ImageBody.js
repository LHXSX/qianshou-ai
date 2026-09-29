import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Complete image bytes rendered at their intrinsic CSS-pixel dimensions. */
import { useEffect, useMemo, useState } from 'react';
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path';
import { LoadingIndicator } from "../LoadingIndicator.js";
import { hostFileOf } from "../rpc.js";
import css from './ImageBody.module.css';
const IMAGE_MEDIA_TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
};
/**
 * Resolve a supported filename to the media type assigned to its Blob.
 * @param path - decoded workspace file path.
 * @returns the image media type, or undefined for an unregistered suffix.
 */
export function imageMediaType(path) {
    const normalized = path.replaceAll('\\', '/');
    const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
    const extension = name.slice(name.lastIndexOf('.') + 1);
    return IMAGE_MEDIA_TYPES[extension];
}
/**
 * Present complete image bytes without fitting or scaling them to the pane.
 * @param props - document bytes, resource identity, and locale.
 * @returns an intrinsic-size image whose containing document body provides scrolling.
 */
export function ImageBody({ content, resourceAddress, t }) {
    const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress]);
    const mediaType = imageMediaType(path);
    const data = content.kind === 'bytes' ? content.data : undefined;
    const [source, setSource] = useState();
    useEffect(() => {
        if (data === undefined || mediaType === undefined)
            return;
        let url;
        try {
            url = URL.createObjectURL(new Blob([data], { type: mediaType }));
            setSource({ kind: 'ready', data, mediaType, url });
        }
        catch {
            setSource({ kind: 'failed', data, mediaType });
        }
        return () => {
            if (url !== undefined)
                URL.revokeObjectURL(url);
        };
    }, [data, mediaType]);
    if (data === undefined || mediaType === undefined) {
        return _jsx("p", { className: css.status, role: "alert", children: t('unsupported') });
    }
    if (source?.data !== data || source.mediaType !== mediaType) {
        return _jsx(LoadingIndicator, { className: css.status, label: t('loading') });
    }
    if (source.kind === 'failed')
        return _jsx("p", { className: css.status, role: "alert", children: t('failed') });
    const { name } = pathPartsOf(path);
    return _jsx(LoadedImage, { url: source.url, name: name, t: t }, source.url);
}
/** SVG stays in the browser's static image mode because its bytes only reach an img Blob URL. */
function LoadedImage({ url, name, t }) {
    const [state, setState] = useState('loading');
    return _jsxs("div", { className: css.frame, "data-image-preview": true, children: [state === 'loading' && _jsx(LoadingIndicator, { className: css.status, label: t('loading') }), state === 'failed' && _jsx("p", { className: css.status, role: "alert", children: t('failed') }), _jsx("img", { className: css.image, src: url, alt: t('preview', { name }), decoding: "async", draggable: false, referrerPolicy: "no-referrer", hidden: state !== 'ready', onLoad: () => { setState('ready'); }, onError: () => { setState('failed'); } })] });
}
//# sourceMappingURL=ImageBody.js.map