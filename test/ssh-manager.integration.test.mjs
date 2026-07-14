import assert from "node:assert/strict";
import test from "node:test";
import { SshManager } from "../electron/services/ssh-manager.mjs";
import { startSshServer } from "../test-support/ssh-fixture.mjs";

function connection(port) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "integration",
    host: "127.0.0.1",
    port,
    username: "root",
    authMethod: "password",
  };
}

test("真实 ssh2 握手、密码终端和主机指纹阻断", async () => {
  const fixture = await startSshServer();
  const events = [];
  const manager = new SshManager((type, payload) => events.push({ type, payload }));

  try {
    const observed = await manager.inspectHost(connection(fixture.port));
    assert.match(observed.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.equal(observed.algorithm, "ssh-ed25519");

    await assert.rejects(
      manager.connect({
        connection: connection(fixture.port),
        password: "test-password",
        knownHost: { fingerprint: "SHA256:incorrect" },
        dimensions: { cols: 100, rows: 30 },
      }),
      (error) => error.code === "HOST_KEY_MISMATCH",
    );

    await assert.rejects(
      manager.connect({
        connection: connection(fixture.port),
        password: "wrong-password",
        knownHost: observed,
        dimensions: { cols: 100, rows: 30 },
      }),
      (error) => error.code === "AUTH_FAILED",
    );

    const connected = await manager.connect({
      connection: connection(fixture.port),
      password: "test-password",
      knownHost: observed,
      dimensions: { cols: 100, rows: 30 },
    });
    assert.equal(connected.connectionId, connection(fixture.port).id);
    assert.equal(connected.home, null);
    assert.equal(connected.sftpError.code, "SFTP_OPEN_FAILED");

    const attached = manager.attachTerminal(connected.sessionId);
    assert.match(new TextDecoder().decode(attached.initialData), /integration-ready\$ /);

    const liveData = new Promise((resolve) => {
      const check = () => {
        const event = events.find((item) => item.type === "terminal-data"
          && new TextDecoder().decode(item.payload.data).includes("hello-terminal"));
        if (event) resolve(event);
        else setTimeout(check, 10);
      };
      check();
    });
    await manager.writeTerminal(connected.sessionId, "hello-terminal\n");
    await Promise.race([
      liveData,
      new Promise((_, reject) => setTimeout(() => reject(new Error("等待终端回显超时")), 2_000)),
    ]);
    await manager.disconnect(connected.sessionId);
  } finally {
    manager.disconnectAll();
    await fixture.close();
  }
});
