import assert from "node:assert/strict";
import test from "node:test";
import { parseRemotePathInput } from "../src/services/remote-path-input.js";

test("远程路径输入继续支持绝对路径并执行规范化", () => {
  assert.equal(parseRemotePathInput("/var//www/./app", "/root"), "/var/www/app");
  assert.equal(parseRemotePathInput("/", "/root"), "/");
});

test("cd 支持绝对路径、当前目录相对路径和父目录", () => {
  assert.equal(parseRemotePathInput("cd /var/log", "/root"), "/var/log");
  assert.equal(parseRemotePathInput("cd releases/2026", "/srv"), "/srv/releases/2026");
  assert.equal(parseRemotePathInput("cd ../log", "/srv/app"), "/srv/log");
  assert.equal(parseRemotePathInput("cd .", "/srv/app"), "/srv/app");
});

test("cd 支持带空格的单引号、双引号路径和 -- 分隔符", () => {
  assert.equal(parseRemotePathInput("cd 'release 2026'", "/srv"), "/srv/release 2026");
  assert.equal(parseRemotePathInput('cd \"/var/log archive\"', "/root"), "/var/log archive");
  assert.equal(parseRemotePathInput("cd -- -cache", "/srv"), "/srv/-cache");
  assert.equal(parseRemotePathInput("cd --cache", "/srv"), "/srv/--cache");
});

test("路径框拒绝其他命令、组合命令和无法解析的 home 语义", () => {
  assert.throws(() => parseRemotePathInput("ls /var/log", "/root"), { code: "INVALID_REMOTE_PATH_INPUT" });
  assert.throws(() => parseRemotePathInput("cd /tmp; rm -rf /", "/root"), { code: "INVALID_REMOTE_PATH_INPUT" });
  assert.throws(() => parseRemotePathInput("cd", "/root"), { code: "INVALID_REMOTE_PATH_INPUT" });
  assert.throws(() => parseRemotePathInput("cd ~", "/root"), { code: "INVALID_REMOTE_PATH_INPUT" });
  assert.throws(() => parseRemotePathInput("cd 'unterminated", "/root"), { code: "INVALID_REMOTE_PATH_INPUT" });
  assert.throws(() => parseRemotePathInput("cd ../../etc", "/root"), { code: "INVALID_REMOTE_PATH_INPUT" });
});
