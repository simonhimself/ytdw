import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const publicRoot = new URL('../public/', import.meta.url);
const headerFile = await readFile(new URL('_headers', publicRoot), 'utf8');
const headers = Object.fromEntries(headerFile.split('\n').filter(line => line.startsWith('  ')).map(line => {
  const index = line.indexOf(':');
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}));
const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'application/javascript'], '/theme.js': ['theme.js', 'application/javascript'] };
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = pathname.startsWith('/s/') ? files['/'] : files[pathname];
  if (!file) { response.writeHead(404, headers); response.end('Not found'); return; }
  try {
    response.writeHead(200, { ...headers, 'content-type': file[1], 'cache-control': 'no-store' });
    response.end(await readFile(new URL(file[0], publicRoot)));
  } catch { response.writeHead(500); response.end('Fixture failed'); }
}).listen(8789, '127.0.0.1');
