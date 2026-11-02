/** 健康与容量快照：给 NeoBot 判断 daemon 能不能再接任务。 */

export class WorkerHealth {
  constructor({ config, registry, client, sessions }) {
    this.config = config;
    this.registry = registry;
    this.client = client;
    this.sessions = sessions;
  }

  snapshot() {
    const tasks = this.registry.list();
    const running = tasks.filter((task) =>
      ['starting', 'running', 'waiting_permission'].includes(task.status),
    ).length;
    return {
      version: '0.1.0',
      daemon_id: this.config.daemonId,
      capacity: this.config.maxWorkers,
      running,
      queued: tasks.filter((task) => task.status === 'queued').length,
      local_sessions: this.sessions.aliveTaskIds().length,
      sync: this.client.status(),
    };
  }
}
