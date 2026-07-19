// Edge headless + CDP：打开游戏 → 单人 → 建存档 → 新对局 → 截图战斗屏
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from '../node_modules/ws/wrapper.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9223;
const URL_GAME = 'http://localhost:5173';
const OUT = process.argv[2] ?? 'shot-battle.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(tmpdir(), 'edge-cdp-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1680,950', '--hide-scrollbars', URL_GAME,
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本错误: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
};
const clickBtn = (text) => evaluate(
  `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('${text}'))?.click(), document.body.innerText.slice(0,200)`,
);

try {
  // 等 devtools 就绪
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { continue; }
    if (targets?.some((t) => t.type === 'page')) break;
  }
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173')) ?? targets.find((t) => t.type === 'page');
  console.log('attach:', page.url);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  });
  await send('Page.enable');
  await send('Page.navigate', { url: URL_GAME });
  // 等 React 渲染出主菜单按钮
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const ready = await evaluate(`document.querySelectorAll('button').length`);
    if (ready > 0) break;
  }

  console.log('step1:', await clickBtn('单人游戏'));
  await sleep(600);
  await evaluate(`
    const inp = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '截图侠');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(200);
  console.log('step2:', await clickBtn('创建存档'));
  await sleep(800);
  // 回到列表后点进存档主页
  await evaluate(`[...document.querySelectorAll('button,div')].find(e=>e.children.length<4 && e.textContent.trim()==='截图侠')?.click()`);
  await sleep(600);
  console.log('step3:', await clickBtn('新的对局'));
  await sleep(2000); // 进场动画

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('✓ 截图已保存:', OUT);
} catch (e) {
  console.error('❌', e instanceof Error ? e.message : e);
  try { console.log('页面内容:', await evaluate('document.body.innerText.slice(0,300)')); } catch {}
} finally {
  edge.kill();
  process.exit(0);
}
