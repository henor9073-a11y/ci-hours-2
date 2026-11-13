import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { assertSafeBookArchive } from '../lib/books.js';

function archive(name, data) {
  const zip = new AdmZip();
  zip.addFile(name, data);
  return zip.toBuffer();
}

function replaceEvery(buffer, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const out = Buffer.from(buffer);
  const before = Buffer.from(from);
  const after = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while ((offset = out.indexOf(before, offset)) !== -1) {
    after.copy(out, offset);
    offset += after.length;
    replacements += 1;
  }
  assert.ok(replacements >= 2, 'fixture must patch local and central ZIP names');
  return out;
}

const valid = archive('word/document.xml', Buffer.from('<w:document><w:p>hello</w:p></w:document>'));
const report = await assertSafeBookArchive(valid, 'valid.docx');
assert.equal(report.entries, 1);
assert.ok(report.uncompressedBytes > 0);

const traversal = replaceEvery(archive('safe.txt', Buffer.from('hello')), 'safe.txt', '../x.txt');
await assert.rejects(assertSafeBookArchive(traversal, 'traversal.epub'), /越界路径|invalid relative path/i);

const bomb = archive('word/document.xml', Buffer.alloc(17 * 1024 * 1024, 0));
await assert.rejects(assertSafeBookArchive(bomb, 'bomb.docx'), /单个文件展开后过大/);

await assert.rejects(
  assertSafeBookArchive(Buffer.from('PK\x03\x04broken'), 'broken.epub'),
  /不安全或已损坏/
);

console.log('✓ EPUB/DOCX 流式预检：正常文件放行，目录穿越、解压炸弹和损坏压缩包拒绝');
