import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 加载管理面板 HTML。
 * 注意：打包 exe 时（scripts/build-server.mjs）本模块会被 esbuild 插件替换为内嵌 HTML 的版本，
 * 使单个 exe 不依赖外部文件；开发阶段则实时读 public/admin.html，改完刷新即生效。
 */
export function loadAdminHtml(): string {
  const candidates = [
    path.join(__dirname, '..', 'public', 'admin.html'),
    path.join(process.cwd(), 'public', 'admin.html'),
    path.join(process.cwd(), 'admin.html'),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      // 尝试下一个候选路径
    }
  }
  return '<!DOCTYPE html><html lang="zh-CN"><body style="font-family:sans-serif;background:#12141a;color:#d8dde6;display:flex;align-items:center;justify-content:center;height:100vh"><h1>⚠️ 未找到 admin.html</h1></body></html>';
}
