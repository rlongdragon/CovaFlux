import { createOpaqueToken } from "../../utils/secrets.js";
import type {
  CreateHeadscaleUserInput,
  CreatePreAuthKeyInput,
  HeadscaleClient,
  HeadscaleNode,
  HeadscalePolicy,
  HeadscalePreAuthKey,
  HeadscaleUser
} from "./HeadscaleClient.js";

export class MockHeadscaleClient implements HeadscaleClient {
  private users = new Map<string, HeadscaleUser>();
  private nodes = new Map<string, HeadscaleNode>();
  private policy: HeadscalePolicy = { acls: [] };

  async health() {
    return;
  }

  async createUser(input: CreateHeadscaleUserInput) {
    const user = { name: input.name };
    this.users.set(input.name, user);
    return user;
  }

  async deleteUser(userName: string) {
    this.users.delete(userName);
  }

  async createPreAuthKey(input: CreatePreAuthKeyInput): Promise<HeadscalePreAuthKey> {
    if (!this.users.has(input.userName)) {
      this.users.set(input.userName, { name: input.userName });
    }

    const key = createOpaqueToken("hskey");
    const id = createOpaqueToken("mockpak");
    const nodeId = createOpaqueToken("mocknode");
    const suffix = nodeId.slice(-8).toLowerCase();
    const nodeName = input.nodeName ?? `${input.userName}-mock-${suffix}`;
    this.nodes.set(nodeId, {
      id: nodeId,
      userName: input.userName,
      name: nodeName,
      givenName: nodeName,
      machineKey: createOpaqueToken("mkey"),
      nodeKey: createOpaqueToken("nodekey"),
      ipAddresses: [],
      advertisedRoutes: [],
      isExitNode: false,
      online: true,
      expired: false,
      lastSeenAt: new Date()
    });

    return { id, key, expiresAt: input.expiresAt };
  }

  async listNodes() {
    return [...this.nodes.values()];
  }

  async expireNode(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (node) this.nodes.set(nodeId, { ...node, online: false, expired: true, expiresAt: new Date(0), lastSeenAt: new Date() });
  }

  async deleteNode(nodeId: string) {
    this.nodes.delete(nodeId);
  }

  async getPolicy() {
    return this.policy;
  }

  async applyPolicy(policy: HeadscalePolicy) {
    this.policy = policy;
  }
}
