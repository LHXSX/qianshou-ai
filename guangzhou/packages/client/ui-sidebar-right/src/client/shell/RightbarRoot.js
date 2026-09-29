import { jsx as _jsx } from "react/jsx-runtime";
/**
 * Render the Session-bound Sidebar only while the Conversation is selected.
 * @param props - frame geometry, panel selection, and the authorized Session renderer.
 * @returns the current Session's right Sidebar, or no content for a global panel.
 */
export function RightbarRoot({ usePanelInfo, SessionProvider, renderSlot, width, viewportWidth, canShow, }) {
    const visible = usePanelInfo(info => info.activePanelId === null);
    if (!visible)
        return null;
    return (_jsx(SessionProvider, { children: renderSlot('rightbar.session', { width, viewportWidth, canShow }) }));
}
//# sourceMappingURL=RightbarRoot.js.map