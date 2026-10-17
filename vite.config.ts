import fs from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Dev only: when MAPLE_VIDEO points at a gameplay recording, serve it at /__video.mp4 (with Range support) for testing. */
function devVideo(): Plugin {
  const file = process.env.MAPLE_VIDEO;
  return {
    name: 'dev-video',
    apply: 'serve',
    configureServer(server) {
      if (!file || !fs.existsSync(file)) return;
      server.middlewares.use('/__video.mp4', (req, res) => {
        const size = fs.statSync(file).size;
        const [a, b] = (req.headers.range || 'bytes=0-').replace('bytes=', '').split('-');
        const start = +a, end = b ? +b : size - 1;
        res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/maple-exp-tracker/"); local dev serves from "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), devVideo()],
  server: { port: 5173 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
