'use strict';
// Tiny static file server for end-to-end tests (http://127.0.0.1 is a secure
// context, so camera APIs are available).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json'
};

function startServer(port = 0) {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = path.normalize(path.join(ROOT, urlPath));
        if (!file.startsWith(ROOT)) {
            res.writeHead(403).end();
            return;
        }
        if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
        fs.readFile(file, (err, body) => {
            if (err) {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
            res.end(body);
        });
    });
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) });
        });
    });
}

module.exports = { startServer };
