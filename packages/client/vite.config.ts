import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // 打包后用 file:// 加载（Electron），资源路径必须是相对路径；dev 阶段保持绝对路径
  base: command === 'build' ? './' : '/',
  server: { port: 5173 },
}));
