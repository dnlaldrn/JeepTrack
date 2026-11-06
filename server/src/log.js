export function log(event, fields = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
}
