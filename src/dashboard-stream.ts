import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

/** Full snapshots make reconnect safe without replaying mutations or model calls. */
export function snapshotStream<T>(read: () => T, record?: string) {
  const clients = new Set<ServerResponse>();
  const draining = new WeakSet<ServerResponse>();
  let watcher: fs.FSWatcher | undefined; let timer: ReturnType<typeof setInterval> | undefined; let queued: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { watcher?.close(); watcher = undefined; if (timer) clearInterval(timer); timer = undefined; if (queued) clearTimeout(queued); queued = undefined; };
  const frame = () => {
    try { return `event: snapshot\ndata: ${JSON.stringify(read())}\n\n`; }
    catch { return `event: unavailable\ndata: ${JSON.stringify({ error: '无法读取项目记录。文件恢复后会自动重连。' })}\n\n`; }
  };
  const send = (client: ServerResponse, data: string) => {
    if (client.destroyed || client.writableEnded) { clients.delete(client); return; }
    // Full snapshots are replaceable. Skip updates while the previous write drains;
    // a large snapshot can exceed the stream high-water mark on a healthy socket.
    if (draining.has(client)) return;
    if (!client.write(data)) { draining.add(client); client.once('drain', () => draining.delete(client)); }
  };
  const publish = () => { if (!clients.size) return; const data = frame(); for (const client of clients) send(client, data); };
  const watch = () => {
    if (!record || watcher || !clients.size) return;
    try {
      watcher = fs.watch(path.dirname(record), (_event, file) => {
        if (file && String(file) !== path.basename(record)) return;
        if (!queued) queued = setTimeout(() => { queued = undefined; publish(); }, 100);
      });
      watcher.on('error', () => { watcher?.close(); watcher = undefined; });
    } catch { /* The periodic check also handles a missing/recreated directory. */ }
  };
  return {
    attach(res: ServerResponse) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); res.write('retry: 1000\n\n'); clients.add(res);
      res.once('close', () => { clients.delete(res); if (!clients.size) stop(); });
      watch(); send(res, frame());
      timer ??= setInterval(() => { watch(); publish(); }, 1000);
    },
    publish,
    close() { stop(); for (const client of clients) client.end(); clients.clear(); },
  };
}
