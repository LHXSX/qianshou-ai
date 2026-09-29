import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CharacterStage } from "./CharacterStage.js";
import { VRMCompanion } from "./VRMCompanion.js";
/**
 * Project real voice activity onto a transparent, movable full-body character.
 * @param props - Existing controller state and actions; children remain mounted when tucked away.
 * @returns Character chrome without creating a microphone, task, or playback owner.
 */
export function FloatingVoicePanel({ state, status, activity, onClose, onInterrupt, revealControls, children, t, }) {
    const characterState = state === 'listening' || state === 'speaking'
        ? state : state === 'thinking' || state === 'executing' || state === 'waiting' || state === 'starting' ? 'busy' : 'idle';
    return _jsxs(CharacterStage, { t: t, state: characterState, status: status, onClose: onClose, onInterrupt: onInterrupt, revealControls: revealControls ?? state === 'paused', renderCharacter: frame => _jsx(VRMCompanion, { t: t, frame: frame, speaking: state === 'speaking', modelUrl: "/qianshou/voice-companion.vrm" }), children: [activity !== undefined && activity !== status && _jsx("p", { children: activity }), children] });
}
//# sourceMappingURL=FloatingVoicePanel.js.map