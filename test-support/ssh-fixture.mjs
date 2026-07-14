import ssh2 from "ssh2";

const { Server, utils } = ssh2;

export function startSshServer() {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => undefined);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "root" && context.password === "test-password") {
        context.accept();
      } else {
        context.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("window-change", (acceptWindowChange) => acceptWindowChange?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("integration-ready$ ");
          stream.on("data", (data) => stream.write(data));
        });
        session.on("sftp", (_acceptSftp, rejectSftp) => rejectSftp?.());
      });
    });
  });
  server.on("error", () => undefined);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        async close() {
          for (const client of clients) client.end();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}
