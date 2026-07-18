import assert from 'node:assert';
import { validateAvatarFile } from '../src/avatar';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

console.log('自定义头像校验测试');

test('合法 png/jpg/jpeg/webp 通过（后缀大写也接受）', () => {
  assert.equal(validateAvatarFile('a.png', 'image/png', 1024), null);
  assert.equal(validateAvatarFile('b.jpg', 'image/jpeg', 1024), null);
  assert.equal(validateAvatarFile('c.jpeg', 'image/jpeg', 1024), null);
  assert.equal(validateAvatarFile('d.webp', 'image/webp', 1024), null);
  assert.equal(validateAvatarFile('E.PNG', 'image/png', 1024), null);
});

test('坏后缀被拒绝（gif/exe/无后缀）', () => {
  assert.ok(validateAvatarFile('x.gif', 'image/gif', 1024));
  assert.ok(validateAvatarFile('evil.exe', 'application/octet-stream', 1024));
  assert.ok(validateAvatarFile('noext', 'image/png', 1024));
});

test('坏 MIME 被拒绝（后缀合法但 MIME 不符）', () => {
  assert.ok(validateAvatarFile('x.png', 'image/gif', 1024));
  assert.ok(validateAvatarFile('x.jpg', 'text/plain', 1024));
  assert.ok(validateAvatarFile('x.webp', '', 1024));
});

test('大小边界：2MB 通过，超过 2MB 拒绝', () => {
  assert.equal(validateAvatarFile('ok.png', 'image/png', 2 * 1024 * 1024), null);
  assert.ok(validateAvatarFile('big.png', 'image/png', 2 * 1024 * 1024 + 1));
});

console.log(`\n全部 ${passed} 个测试通过 ✅`);
