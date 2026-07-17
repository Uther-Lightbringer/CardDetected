import { exec } from 'node:child_process';
import { startServer } from './server.js';

const port = Number(process.env.PORT ?? 9000);
const server = startServer({ port });

server.on('listening', () => {
  const adminUrl = `http://127.0.0.1:${port}/admin.html`;
  console.log('================================================');
  console.log('  CardDetect 游戏服务器已启动');
  console.log(`  客户端连接地址: ws://<本机IP>:${port}`);
  console.log(`  可视化管理面板: ${adminUrl}`);
  console.log('================================================');

  // 启动后自动打开可视化面板（NO_OPEN=1 可禁用，测试时用）
  if (!process.env.NO_OPEN) {
    const cmd =
      process.platform === 'win32'
        ? `start "" "${adminUrl}"`
        : process.platform === 'darwin'
          ? `open "${adminUrl}"`
          : `xdg-open "${adminUrl}"`;
    exec(cmd, () => {});
  }
});
