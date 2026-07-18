/**
 * 服务器 exe 打包脚本（Node.js SEA 单文件方案，全程离线，无需下载预编译二进制）：
 * 1. esbuild 把服务器（含 shared 依赖）打成单个 CJS 文件，
 *    并把 src/adminHtml.ts 替换为「内嵌管理面板 HTML」的版本（exe 不依赖外部文件）
 * 2. Node SEA：以本机 node.exe 为底座，注入应用代码 blob，生成 CardDetectServer.exe
 * 用法：node build-server.mjs
 * Docker 镜像构建只需要第 1 步：BUNDLE_ONLY=1 node build-server.mjs
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pkgDir);

// ---------- 1. esbuild 打包 ----------
const adminHtml = readFileSync(path.join(pkgDir, 'public', 'admin.html'), 'utf-8');

/** 把对 './adminHtml.js' 的引用替换为内嵌 HTML 的内联模块 */
const inlineAdminHtmlPlugin = {
  name: 'inline-admin-html',
  setup(b) {
    b.onResolve({ filter: /adminHtml\.js$/ }, () => ({ path: 'adminHtml-inline', namespace: 'inline' }));
    b.onLoad({ filter: /.*/, namespace: 'inline' }, () => ({
      contents: `export function loadAdminHtml() { return ${JSON.stringify(adminHtml)}; }`,
      loader: 'js',
    }));
  },
};

mkdirSync('build', { recursive: true });
mkdirSync('release', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'build/server.cjs',
  // ws 的可选原生加速模块：不打包，运行时自动降级为纯 JS 实现
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [inlineAdminHtmlPlugin],
  logLevel: 'warning',
});
console.log('✓ [1/4] esbuild 打包完成: build/server.cjs');

if (process.env.BUNDLE_ONLY) {
  // Docker 镜像构建到此为止（容器内直接用 node 跑 server.cjs）
  process.exit(0);
}

// ---------- 2. 生成 SEA blob ----------
const seaConfig = {
  main: 'build/server.cjs',
  output: 'build/sea.blob',
  disableExperimentalSEAWarning: true,
};
writeFileSync('build/sea-config.json', JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'build/sea-config.json'], { stdio: 'inherit' });
console.log('✓ [2/4] SEA blob 生成: build/sea.blob');

// ---------- 3. 复制 node.exe 作为底座 ----------
const exePath = path.join('release', 'CardDetectServer.exe');
copyFileSync(process.execPath, exePath);
console.log(`✓ [3/4] 已复制 node 运行时: ${exePath}`);

// ---------- 4. 注入 blob ----------
execFileSync(
  'npx',
  [
    'postject',
    exePath,
    'NODE_SEA_BLOB',
    'build/sea.blob',
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit', shell: true },
);
console.log('✓ [4/4] 注入完成');
console.log(`\n🎉 服务器 exe 已生成: ${path.resolve(exePath)}`);
console.log('   双击运行即可启动（数据文件将写入 exe 同级目录的 data/ 下）');
