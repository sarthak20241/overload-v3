/**
 * Tiny structured logger. Each log line is a single JSON object on stdout
 * so GitHub Actions / log aggregators can parse them. Pretty-prints in TTY
 * for local debugging.
 */
const isTTY = process.stdout.isTTY === true;

function emit(level: string, source: string, msg: string, fields?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  if (isTTY) {
    const icons: Record<string, string> = {
      info: '  ',
      add: '+ ',
      skip: '~ ',
      reject: '× ',
      error: '! ',
      warn: '? ',
    };
    const icon = icons[level] ?? '  ';
    const extras = fields
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    console.log(`${icon}[${source}] ${msg}${extras}`);
  } else {
    console.log(JSON.stringify({ ts, level, source, msg, ...(fields ?? {}) }));
  }
}

export const log = {
  info: (source: string, msg: string, fields?: Record<string, unknown>) =>
    emit('info', source, msg, fields),
  add: (source: string, msg: string, fields?: Record<string, unknown>) =>
    emit('add', source, msg, fields),
  skip: (source: string, msg: string, fields?: Record<string, unknown>) =>
    emit('skip', source, msg, fields),
  reject: (source: string, msg: string, fields?: Record<string, unknown>) =>
    emit('reject', source, msg, fields),
  warn: (source: string, msg: string, fields?: Record<string, unknown>) =>
    emit('warn', source, msg, fields),
  error: (source: string, msg: string, fields?: Record<string, unknown>) =>
    emit('error', source, msg, fields),
};
