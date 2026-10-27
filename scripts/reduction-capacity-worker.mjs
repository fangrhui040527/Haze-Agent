// Private verifier IPC only; the application's HTTP API is unchanged.
import './serve-tasks.mjs';

process.on('message', (message) => {
  if (message?.type !== 'reduction-capacity-metrics') return;
  process.send?.({
    type: 'reduction-capacity-metrics',
    request_id: message.request_id,
    rss_bytes: process.memoryUsage().rss,
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
  });
});
