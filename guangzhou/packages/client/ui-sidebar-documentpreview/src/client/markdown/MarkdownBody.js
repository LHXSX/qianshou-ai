import { jsx as _jsx } from "react/jsx-runtime";
/** One retained Markdown renderer over the document owner's accumulated text. */
import { useMemo } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './MarkdownBody.module.css';
/**
 * Render one accumulated document; EOF completes the primitive's full parse.
 * @param props - owner-loaded contents and localized primitive labels.
 * @returns Markdown content, or nothing for a non-text delivery.
 */
export function MarkdownBody({ content, t }) {
    const copyLabel = t('code.copy');
    const copiedLabel = t('code.copied');
    const footnotes = t('footnotes');
    const labels = useMemo(() => ({
        code: { copyLabel, copiedLabel }, footnotes,
    }), [copyLabel, copiedLabel, footnotes]);
    if (content.kind !== 'text')
        return null;
    return (_jsx("div", { className: css.document, "data-document-markdown": true, children: _jsx(MarkdownText, { text: content.text, streaming: !content.eof, labels: labels }) }));
}
//# sourceMappingURL=MarkdownBody.js.map