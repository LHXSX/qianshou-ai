import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { IconBranchOutline16, IconChecklistOutline14, IconChevronDownOutline14, IconCodeOutline16, IconFolderClose16, IconFolderOpen16, IconRightUpOutline16, IconSettingsOutline16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path';
import css from './HeroShell.module.css';
/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd) {
    const base = workspaceTitleOf(cwd);
    return base !== '' ? base : cwd;
}
/**
 * The workspace chip (folder + label + chevron), always interactive: before
 * the first message the workspace stays switchable — picking another one
 * moves the New Session flow to that workspace's blank session. Without a
 * label the chip renders its placeholder state: closed folder + the
 * "Choose workspace" call to action.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → placeholder.
 * @param props.menuOpen - menu expansion echo.
 * @param props.onClick - menu toggle.
 * @returns the chip button element.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }) {
    return (_jsxs("button", { ref: buttonRef, type: "button", className: css.workspace, "aria-label": t('hero.chooseWorkspace'), "aria-haspopup": "menu", "aria-expanded": menuOpen, onClick: onClick, children: [label === undefined
                ? _jsx(IconFolderClose16, { className: css.folder, size: 16 })
                : _jsx(IconFolderOpen16, { className: css.folder, size: 16 }), _jsx("span", { className: css.workspaceLabel, children: label ?? t('hero.chooseWorkspace') }), _jsx(IconChevronDownOutline14, { className: css.chevron, size: 12 })] }));
}
/** Read at call time so forge tests can stub the client build profile. */
function isForgeBuild() {
    return process.env.DSH_CLIENT_BUILD_PROFILE === 'forge';
}
/** Colored glyph for one product capability card. */
function ProductCardMark({ id }) {
    return (_jsx("span", { className: css.productCardMark, "data-card": id, "aria-hidden": "true", children: id === 'agents' ? (_jsx("svg", { viewBox: "0 0 24 24", width: "18", height: "18", children: _jsx("path", { fill: "currentColor", d: "M12 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-5.5 9a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm11 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM12 11.5c-2.6 0-4.8 1.5-5.6 3.6-.2.5.2 1.1.8 1.1h9.6c.6 0 1-.6.8-1.1-.8-2.1-3-3.6-5.6-3.6Z" }) })) : id === 'dispatch' ? (_jsx("svg", { viewBox: "0 0 24 24", width: "18", height: "18", children: _jsx("path", { fill: "currentColor", d: "M4 5h7v5H4V5Zm9 0h7v9h-7V5ZM4 12h7v7H4v-7Zm9 7v-5h7v5h-7Z" }) })) : id === 'multimodal' ? (_jsx("svg", { viewBox: "0 0 24 24", width: "18", height: "18", children: _jsx("path", { fill: "currentColor", d: "M5 5h8l2 2h4v12H5V5Zm2 9 2.5-3 2 2.4L14 11l3 5H7l0-2Z" }) })) : (_jsx("svg", { viewBox: "0 0 24 24", width: "18", height: "18", children: _jsx("path", { fill: "currentColor", d: "M11 4h2l.8 2.4h2.7l.8 2.5-2.1 1.6.8 2.5-2.2 1.5L12 16.9l-1.8-1.4-2.2-1.5.8-2.5-2.1-1.6.8-2.5h2.7L11 4Z" }) })) }));
}
/** Developer home chrome; the resident editor remains owned by ConversationRoot. */
export function HeroShell({ t, renderSlot, children }) {
    if (isForgeBuild()) {
        /**
         * Forge 首屏：**左对齐的紧凑头部 + 输入框（由 `children` 渲染）为主角**。
         *
         * ## 为什么删掉了装饰地球与居中三段式
         *
         * 这里原来是一个居中的大标题 + 副标题 + 描述，压在 4 张能力卡网格之上，
         * 右上角还有一张装饰性地球图。三份外部技能的取证把这套判定为最典型的
         * 生成痕迹（`qianshou-design-system` §4）：
         *
         * - **Template Hero Plus Card Grid**："居中标题 + 段落，压在可预测的功能卡网格上；
         *   每一节都能和任何 SaaS 落地页互换；页面没有产品结构"；
         * - **Narrow Page Shell**：内容被卡在 720px 里，两侧大量留空，"像贴在页面上的 mockup"；
         * - `frontend-design` 明确要求：网页首屏应当放**这个主题最有特征的东西**，
         *   而"大数字 + 渐变点缀 + 功能卡"是默认答案，除非它真的是最优解。
         *
         * 对"本机智能体工作台"来说，最有特征的东西**不是一段自我介绍**，
         * 而是"现在就能开工"这件事本身。所以视觉重心从"文案"移到**输入框**：
         * 标题压到 24px、单行、左对齐，副标题与描述合并成一行弱化文字，
         * 装饰地球直接删掉（它不承载任何信息，属于 **Motion/Decoration As Decoration**）。
         */
        return (_jsxs("div", { className: css.productRoot, children: [_jsxs("div", { className: css.productCopy, children: [_jsx("h1", { className: css.productHeadline, children: t('hero.headline') }), _jsxs("p", { className: css.productTagline, children: [t('hero.tagline'), _jsx("span", { className: css.productDot, "aria-hidden": "true", children: "\u00B7" }), t('hero.description')] })] }), children] }));
    }
    return (_jsxs("div", { className: css.root, children: [_jsxs("div", { className: css.stack, children: [_jsxs("div", { className: css.identity, children: [_jsx("div", { className: css.markFrame, "aria-hidden": "true", children: renderSlot('conversation.hero.brand.mark', { size: 34, className: css.mark }, {
                                    fallback: _jsxs("svg", { className: css.mark, width: "34", height: "34", viewBox: "0 0 32 32", fill: "none", "aria-hidden": "true", children: [_jsx("rect", { x: "1", y: "1", width: "30", height: "30", rx: "9", fill: "currentColor" }), _jsxs("g", { className: css.markStroke, strokeWidth: "1.15", fill: "none", strokeLinecap: "round", children: [_jsx("circle", { cx: "16", cy: "16", r: "3.3" }), _jsx("path", { d: "M20 16h4M18 19.5l2 3.5M14 19.5l-2 3.5M12 16H8M14 12.5l-2-3.5M18 12.5l2-3.5" }), _jsx("circle", { cx: "24", cy: "16", r: "1.1" }), _jsx("circle", { cx: "20", cy: "23", r: "1.1" }), _jsx("circle", { cx: "12", cy: "23", r: "1.1" }), _jsx("circle", { cx: "8", cy: "16", r: "1.1" }), _jsx("circle", { cx: "12", cy: "9", r: "1.1" }), _jsx("circle", { cx: "20", cy: "9", r: "1.1" })] })] }),
                                }) }), _jsxs("div", { className: css.brandCopy, children: [_jsx("span", { className: css.brand, children: t('hero.brand') }), _jsx("span", { className: css.previewBadge, children: t('hero.preview') })] })] }), _jsx("h1", { className: css.headline, children: t('hero.headline') }), _jsx("p", { className: css.description, children: t('hero.description') })] }), children] }));
}
const STARTERS = [
    { id: 'understand', Icon: IconBranchOutline16 },
    { id: 'fix', Icon: IconSettingsOutline16 },
    { id: 'review', Icon: IconChecklistOutline14 },
    { id: 'build', Icon: IconCodeOutline16 },
];
const PRODUCT_CARDS = [
    'agents', 'dispatch', 'multimodal', 'industry',
];
const PRODUCT_SUGGESTS = ['1', '2', '3'];
/** Explicit starter gestures only fill the draft; they never submit a task. */
export function StarterActions({ t, disabled, onSelect }) {
    if (isForgeBuild()) {
        /**
         * 建议：**只有文字的行内 chip，不是带标记与箭头的卡片**。
         *
         * 原来这里是 6 条" 22px 色块 + 文案 + 右箭头 "的卡片，占三行、158px 高，
         * 而每条只承载一句短语——**容器比内容重**（`ui-aesthetics` 的 Surface Inflation）。
         * 建议条的作用是"给一句能直接开工的话"，它应当轻到几乎不像控件：
         * 没有图标、没有箭头、底色透明、只在 hover 时给一点提示。
         *
         * 数量从 6 收到 3：`qianshou-design-system` §4 记录了工作台类产品的首屏模块上限
         * （AntD 5–9），原来 4 卡 + 6 条 = 10 个平级入口，每个都在抢"先点我"。
         *
         * **能力卡保留**：它们承载"这个产品现在能干什么"，是新人第一眼的定向信息。
         * 我一度想把它们一起删掉——那是过度反应：真问题不是"有卡片"，而是
         * **内容被卡在 720px 的窄容器里**（Narrow Page Shell）。所以解法是放开宽度
         * （见 `.productHome` 的 max-width 与下面的算术注释），不是删信息。
         */
        return (_jsxs("div", { className: css.productHome, role: "group", "aria-label": t('hero.actions'), children: [_jsx("div", { className: css.productGrid, children: PRODUCT_CARDS.map(id => (_jsxs("button", { type: "button", className: css.productCard, "data-starter": id, disabled: disabled, onClick: () => { onSelect(t(`hero.card.${id}.prompt`)); }, children: [_jsx(ProductCardMark, { id: id }), _jsxs("span", { className: css.productCardCopy, children: [_jsx("span", { className: css.productCardTitle, children: t(`hero.card.${id}.title`) }), _jsx("span", { className: css.productCardDescription, children: t(`hero.card.${id}.description`) })] })] }, id))) }), _jsx("div", { className: css.suggestRow, children: PRODUCT_SUGGESTS.map(id => (_jsx("button", { type: "button", className: css.suggest, disabled: disabled, onClick: () => { onSelect(t(`hero.suggest.${id}`)); }, children: _jsx("span", { children: t(`hero.suggest.${id}`) }) }, id))) })] }));
    }
    return _jsx("div", { className: css.starters, role: "group", "aria-label": t('hero.actions'), children: _jsx("div", { className: css.starterGrid, children: STARTERS.map(({ id, Icon }) => _jsxs("button", { type: "button", className: css.starter, "data-starter": id, disabled: disabled, onClick: () => { onSelect(t(`hero.${id}.prompt`)); }, children: [_jsx("span", { className: css.starterIcon, "aria-hidden": "true", children: _jsx(Icon, { size: 19 }) }), _jsxs("span", { className: css.starterCopy, children: [_jsx("span", { className: css.starterTitle, children: t(`hero.${id}.title`) }), _jsx("span", { className: css.starterDescription, children: t(`hero.${id}.description`) })] }), _jsx("span", { className: css.starterArrow, "aria-hidden": "true", children: _jsx(IconRightUpOutline16, { size: 15 }) })] }, id)) }) });
}
//# sourceMappingURL=EmptyHero.js.map