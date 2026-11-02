export function oneLine(value, limit = 180) {
  const line = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
export function createProgressNotifier(notify) {
  let last = '';
  return (message, level = 'info') => {
    const line = oneLine(message);
    if (line === last) return false;
    last = line; notify(line, level); return true;
  };
}
