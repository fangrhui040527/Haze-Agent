import { stripVTControlCharacters } from 'node:util';

const labels = [
  'Zetaris containers',
  'Backend build',
  'Frontend + backend API',
];

/** Keep startup progress in one terminal panel, or emit final rows to a log. */
export function createStartupDisplay({
  output = process.stdout,
  now = Date.now,
} = {}) {
  const interactive = Boolean(output.isTTY && process.env.TERM !== 'dumb');
  const startedAt = now();
  const rows = labels.map((label) => ({
    label,
    status: 'WAITING',
    detail: '',
    startedAt: undefined,
  }));
  const emitted = new Set();
  let footer = [];
  let renderedLines = 0;
  let closed = false;
  let urlsEmitted = false;
  let timer;

  const plain = (value) =>
    stripVTControlCharacters(String(value)).replace(/[\r\n\t]/g, ' ');
  const elapsed = (start) =>
    `${(Math.max(0, now() - start) / 1000).toFixed(1)}s`;
  const rowText = ({ label, status, detail, startedAt: rowStartedAt }) => {
    const timing = status === 'STARTING' ? elapsed(rowStartedAt) : '';
    const description = [detail, timing].filter(Boolean).join(' | ');
    return `  ${label.padEnd(24)} ${status}${description ? `  ${description}` : ''}`;
  };

  function syncTimer() {
    const running =
      interactive && rows.some((row) => row.status === 'STARTING');
    if (running && !timer) {
      timer = setInterval(render, 100);
      timer.unref();
    } else if (!running && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function clear() {
    if (!renderedLines) return;
    output.write(`\u001b[${renderedLines}A\r\u001b[0J`);
    renderedLines = 0;
  }

  function render() {
    if (!interactive || closed) return;
    clear();
    const width = Math.max(1, (output.columns || 80) - 1);
    const lines = ['  Haze Agent', '', ...rows.map(rowText), ...footer].map(
      (line) => Array.from(plain(line)).slice(0, width).join(''),
    );
    output.write(`${lines.join('\n')}\n`);
    renderedLines = lines.length;
  }

  function update(index, status, detail = '') {
    if (closed) return;
    const row = rows[index];
    if (!row) throw new RangeError(`Unknown startup component: ${index}`);
    const nextStatus = plain(status);
    const frozenTime =
      row.status === 'STARTING' && !['STARTING', 'WAITING'].includes(nextStatus)
        ? elapsed(row.startedAt)
        : '';
    if (nextStatus === 'STARTING' && row.status !== 'STARTING')
      row.startedAt = now();
    else if (nextStatus !== 'STARTING') row.startedAt = undefined;
    row.status = nextStatus;
    row.detail = plain(detail || frozenTime);
    syncTimer();
    if (interactive) render();
    else if (
      !['WAITING', 'STARTING'].includes(row.status) &&
      !emitted.has(index)
    ) {
      emitted.add(index);
      output.write(`${rowText(row)}\n`);
    }
  }

  function urls(local = [], network = [], elapsedSeconds) {
    if (closed) return;
    const seconds = elapsedSeconds ?? ((now() - startedAt) / 1000).toFixed(1);
    footer = [
      '',
      ...local.map((url) => `  App      ${plain(url)}`),
      ...network.map((url) => `  Network  ${plain(url)}`),
      `  Started in ${plain(seconds)}s`,
      '  Ctrl+C: stop app | docker compose stop: stop Zetaris',
    ];
    if (interactive) render();
    else if (!urlsEmitted) {
      urlsEmitted = true;
      output.write(`${footer.join('\n')}\n`);
    }
  }

  function log(text) {
    if (!text) return;
    const message = stripVTControlCharacters(String(text));
    if (!message) return;
    if (interactive && !closed) clear();
    output.write(message.endsWith('\n') ? message : `${message}\n`);
    render();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (interactive) output.removeListener('resize', render);
  }

  if (interactive) {
    output.on('resize', render);
    render();
  } else output.write('  Haze Agent\n');

  return { update, urls, log, close };
}
