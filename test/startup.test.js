/**
 * @file 启动脚本可用性测试（node:test，零依赖）。
 *
 * 背景（真实交付事故）：`start.bat` 曾以 **LF 行尾** 交付。Windows 的 cmd.exe 要求
 * `.bat` 使用 CRLF，否则会把整行解析错乱——实测表现为一连串
 * `'ho' 不是内部或外部命令`、`'start' 不是内部或外部命令`，脚本一条命令都没执行成功。
 * 由于双击启动是本产品的唯一主入口，这等于「应用完全打不开」，
 * 而当时所有测试都是绿的（测试从不执行 .bat，也不会检查行尾）。
 *
 * 本文件把这件事变成可执行断言：行尾、编码、关键命令存在性、路径分隔符。
 *
 * 运行：`node --test test/startup.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAT = path.join(ROOT, 'start.bat');

const raw = fs.readFileSync(BAT);

test('start.bat 必须是 CRLF 行尾（cmd.exe 的硬性要求）', () => {
  const lfOnly = (raw.toString('latin1').match(/(?<!\r)\n/g) || []).length;
  assert.equal(lfOnly, 0, `发现 ${lfOnly} 处裸 LF 行尾。Windows cmd 需要 CRLF，否则脚本会被解析错乱（曾导致应用完全无法启动）`);
  assert.ok(raw.includes('\r\n'), 'start.bat 应至少含一个 CRLF');
});

test('start.bat 不得带 UTF-8 BOM（会让首行 @echo off 失效，命令被回显）', () => {
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  assert.equal(hasBom, false, 'start.bat 不应带 UTF-8 BOM');
});

test('start.bat 必须是纯 ASCII（避免 cmd 代码页把中文注释解析成命令）', () => {
  const text = raw.toString('latin1');
  const bad = [...text].filter((ch) => ch.charCodeAt(0) > 127);
  assert.equal(bad.length, 0, `start.bat 含 ${bad.length} 个非 ASCII 字符，可能被 cmd 误解析`);
});

test('start.bat 必须能启动服务端入口，并在失败时保留窗口', () => {
  const text = raw.toString('utf8');
  assert.match(text, /node\s+server\\server\.js/i, '应调用 node server\\server.js（注意用反斜杠）');
  assert.match(text, /^\s*pause\s*$/im, '结尾应有 pause，否则出错时窗口一闪而过用户看不到原因');
  assert.match(text, /cd\s+\/d\s+"%~dp0"/i, '应先切换到脚本所在目录，否则从别处调用会找不到 server/');
});

test('服务端入口文件存在且可被 node 解析', () => {
  const entry = path.join(ROOT, 'server', 'server.js');
  assert.ok(fs.existsSync(entry), 'server/server.js 必须存在');
  const src = fs.readFileSync(entry, 'utf8');
  // 入口要调用 main()，否则进程启动后会静默退出（启动路径改动时极易漏掉）
  assert.match(src, /^main\(\);?$/m, 'server.js 必须实际调用 main()');
});
