/** U1 显示面与控制器之间的那一根线：订阅控制器状态。 */
import { useEffect, useState } from 'react'
import type { NodeStatusController, NodeStatusState } from './controller.ts'

/**
 * 订阅节点状态。
 * @param controller - 状态控制器。
 * @returns 当前状态；控制器每次更新都会重新渲染。
 */
export function useNodeState(controller: NodeStatusController): NodeStatusState {
  const [state, setState] = useState<NodeStatusState>(() => controller.state())
  useEffect(() => controller.subscribe(setState), [controller])
  return state
}
