export interface PublicMetrics {
  online_nodes: number;
  total_nodes: number;
  running_tasks: number;
  completed_tasks: number;
}

/** Map the actual public snapshot contract. Missing data must never become a demo baseline. */
export function parsePublicMetrics(value: unknown, now = Date.now()): { metrics: PublicMetrics; generatedAt: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public snapshot');
  const input = value as Record<string, unknown>;
  const raw = input.top_metrics;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing public metrics');
  const top = raw as Record<string, unknown>;
  const count = (key: string): number => {
    const number = top[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new Error('Invalid public count');
    return number;
  };
  const generatedAt = typeof input.generated_at === 'string' ? Date.parse(input.generated_at) : NaN;
  if (!Number.isFinite(generatedAt) || generatedAt > now + 5_000 || now - generatedAt > 60_000) throw new Error('Public snapshot is stale');
  const metrics = { online_nodes: count('nodes_online'), total_nodes: count('nodes_total'),
    running_tasks: count('tasks_running'), completed_tasks: count('tasks_done') };
  const totalTasks = count('tasks_total');
  if (metrics.online_nodes > metrics.total_nodes || metrics.running_tasks + metrics.completed_tasks > totalTasks) throw new Error('Inconsistent public metrics');
  return { metrics, generatedAt };
}

export function formatPublicCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString('zh-CN') : '—';
}
