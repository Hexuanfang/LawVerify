import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import httpProxy from 'http-proxy';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..');
dotenv.config({
    path: path.join(serverRoot, '.env'),
    override: true,
});
const port = Number(process.env.COLLABORA_PROXY_PORT ?? 9981);
const target = process.env.COLLABORA_PROXY_TARGET ?? 'http://127.0.0.1:9980';
const proxy = httpProxy.createProxyServer({
    target,
    changeOrigin: true,
    secure: false,
    ws: true,
    xfwd: true,
});
proxy.on('error', (error, _request, response) => {
    if (response && 'writeHead' in response) {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message: 'Collabora 代理不可用。', detail: error.message }));
        return;
    }
    console.error('Collabora proxy error:', error);
});
const server = http.createServer((request, response) => {
    proxy.web(request, response);
});
server.on('upgrade', (request, socket, head) => {
    proxy.ws(request, socket, head);
});
server.listen(port, '0.0.0.0', () => {
    console.log(`Collabora proxy running on http://0.0.0.0:${port} -> ${target}`);
});
