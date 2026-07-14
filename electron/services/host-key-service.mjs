import crypto from "node:crypto";
import { AppError } from "./app-error.mjs";
import { validateId } from "./validation.mjs";

const CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;

export class HostKeyService {
  #connections;
  #knownHosts;
  #ssh;
  #challenges = new Map();

  constructor({ connections, knownHosts, ssh }) {
    this.#connections = connections;
    this.#knownHosts = knownHosts;
    this.#ssh = ssh;
  }

  async probe(connectionId) {
    const id = validateId(connectionId, "连接标识");
    const connection = await this.#connections.get(id);
    const observed = await this.#ssh.inspectHost(connection);
    const known = await this.#knownHosts.get(connection.host, connection.port);

    if (known && known.fingerprint === observed.fingerprint) {
      return {
        status: "trusted",
        fingerprint: observed.fingerprint,
        algorithm: observed.algorithm,
      };
    }
    if (known) {
      return {
        status: "mismatch",
        host: connection.host,
        port: connection.port,
        algorithm: observed.algorithm,
        expectedFingerprint: known.fingerprint,
        receivedFingerprint: observed.fingerprint,
      };
    }

    this.#removeExpiredChallenges();
    const challengeId = crypto.randomUUID();
    this.#challenges.set(challengeId, {
      connectionId: id,
      host: connection.host,
      port: connection.port,
      algorithm: observed.algorithm,
      fingerprint: observed.fingerprint,
      expiresAt: Date.now() + CHALLENGE_LIFETIME_MS,
    });
    return {
      status: "unknown",
      challengeId,
      host: connection.host,
      port: connection.port,
      algorithm: observed.algorithm,
      fingerprint: observed.fingerprint,
      expiresAt: new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString(),
    };
  }

  async accept(challengeId) {
    const id = validateId(challengeId, "指纹确认标识");
    const challenge = this.#challenges.get(id);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      this.#challenges.delete(id);
      throw new AppError("HOST_KEY_CHALLENGE_EXPIRED", "主机指纹确认已过期，请重新连接并再次核对。" );
    }
    const connection = await this.#connections.get(challenge.connectionId);
    if (connection.host !== challenge.host || connection.port !== challenge.port) {
      this.#challenges.delete(id);
      throw new AppError("HOST_KEY_CHALLENGE_INVALID", "连接配置已变化，不能接受旧的主机指纹。" );
    }
    const trusted = await this.#knownHosts.trust(challenge);
    this.#challenges.delete(id);
    return {
      connectionId: challenge.connectionId,
      fingerprint: trusted.fingerprint,
      algorithm: trusted.algorithm,
    };
  }

  #removeExpiredChallenges() {
    const now = Date.now();
    for (const [id, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(id);
    }
  }
}
