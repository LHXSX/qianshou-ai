"""Draft for local_h3: node-local progress from the submitted API graph only.

No network, storage, model imports, inferred overall percentage or fixed node IDs.
"""
from __future__ import annotations

from collections.abc import Mapping
import math
from types import MappingProxyType


# Exact classes verified in the local H3 graph builders. Unknown plugins stay generic.
CLASS_PHASES = MappingProxyType({
    'CLIPLoader': 'loading',
    'VAELoader': 'loading',
    'UNETLoader': 'loading',
    'LoraLoaderBypassModelOnly': 'loading',
    'LoadImage': 'loading_inputs',
    'BasicScheduler': 'preparing',
    'KSamplerSelect': 'preparing',
    'BasicGuider': 'preparing',
    'RandomNoise': 'preparing',
    'PathchSageAttentionKJ': 'preparing',
    'MiniMaxH3ImageToVideo': 'conditioning',
    'SamplerCustomAdvanced': 'sampling',
    'LayerUtility: PurgeVRAM V2': 'releasing_memory',
    'VAEDecode': 'decoding',
    'VAEDecodeAudio': 'decoding_audio',
    'VHS_VideoCombine': 'encoding',
    'ImageFromBatch': 'extracting_frames',
    'SaveImage': 'saving_frames',
})


def node_id(value):
    if type(value) is int and value >= 0:
        return str(value)
    if isinstance(value, str) and value and value == value.strip():
        return value
    return None


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def node_counters(value, maximum):
    """Sanitize observed counters, never substitute steps, one, zero or stale data."""
    value = value if _finite_number(value) and value >= 0 else None
    maximum = maximum if _finite_number(maximum) and maximum > 0 else None
    percent = None
    if value is not None and maximum is not None and value <= maximum:
        percent = round(100.0 * (value / maximum), 1)
    return value, maximum, percent


class GraphProgress:
    def __init__(self, submitted_graph):
        if not isinstance(submitted_graph, Mapping) or not submitted_graph:
            raise ValueError('Progress requires the submitted API graph')
        classes = {}
        for key, row in submitted_graph.items():
            identifier = node_id(key)
            if identifier is None or identifier in classes or not isinstance(row, Mapping):
                raise ValueError('Invalid or ambiguous API graph node')
            kind = row.get('class_type')
            if not isinstance(kind, str) or not kind.strip():
                raise ValueError('API graph node requires class_type')
            classes[identifier] = kind
        # Keep the exact submission mapping even if the caller later edits its graph.
        self.classes = MappingProxyType(classes)
        self.active_node = None
        self.has_node_activity = False
        self.finishing = False

    def _stage(self, node, *, finishing=False):
        kind = self.classes.get(node)
        phase = 'finishing' if finishing else CLASS_PHASES.get(kind, 'executing')
        message = phase if kind in CLASS_PHASES or finishing else f'executing node {node or "unknown"}'
        return {'node': node, 'class_type': kind, 'phase': phase,
                'percent': None, 'value': None, 'max': None,
                'progress_scope': 'node', 'indeterminate': True, 'message': message}

    def consume(self, event):
        if not isinstance(event, Mapping):
            return None
        kind = event.get('type')
        if kind == 'execution_start':
            self.active_node = None
            self.has_node_activity = False
            self.finishing = False
            result = self._stage(None)
            result.update(phase='starting', message='execution started')
            return result
        if kind == 'executing':
            self.has_node_activity = True
            self.active_node = node_id(event.get('node'))
            self.finishing = event.get('node') is None
            # An explicit null means execution is ending, not job success.
            return self._stage(self.active_node, finishing=self.finishing)
        if kind == 'progress':
            if self.finishing:
                return None
            self.has_node_activity = True
            raw_node = event.get('node')
            if raw_node is not None:
                self.active_node = node_id(raw_node)
            # Missing node uses only observed execution context, never value/max.
            result = self._stage(self.active_node)
            value, maximum, percent = node_counters(event.get('value'), event.get('max'))
            result.update(value=value, max=maximum, percent=percent, indeterminate=percent is None)
            if percent is not None:
                result['message'] += f' {value}/{maximum} ({percent}%)'
            return result
        if kind == 'queue':
            queue = {'queue_state': event.get('queue_state'), 'queue_position': event.get('queue_position')}
            if self.has_node_activity:
                return queue
            result = self._stage(None)
            state = event.get('queue_state')
            result.update(queue, phase=state if state in ('running', 'pending', 'waiting') else 'queued_comfy',
                          message=f'queue {state} pos={event.get("queue_position")}')
            return result
        # Cached nodes, heartbeats and history are not counter or completion events.
        return None
