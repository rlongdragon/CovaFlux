import type {
  CreateHeadscaleUserInput,
  CreatePreAuthKeyInput,
  HeadscaleClient,
  HeadscaleNode,
  HeadscalePolicy,
  HeadscalePreAuthKey,
  HeadscaleUser
} from "./HeadscaleClient.js";

interface HeadscaleLogger {
  info(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

interface HeadscaleApiUser {
  id?: string;
  name?: string;
}

interface HeadscaleApiPreAuthKey {
  id?: string;
  key?: string;
  expiration?: string;
}

interface HeadscaleApiNode {
  id?: string;
  machineKey?: string;
  nodeKey?: string;
  name?: string;
  givenName?: string;
  user?: HeadscaleApiUser;
  lastSeen?: string;
  approvedRoutes?: string[];
  availableRoutes?: string[];
  subnetRoutes?: string[];
}

export class RestHeadscaleClient implements HeadscaleClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly apiKey: string, private readonly logger?: HeadscaleLogger) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async health() {
    await this.request("/api/v1/health");
  }

  async createUser(input: CreateHeadscaleUserInput): Promise<HeadscaleUser> {
    const existing = await this.findUserByName(input.name);
    if (existing) return { name: existing.name ?? input.name };

    const response = await this.request<{ user?: HeadscaleApiUser }>("/api/v1/user", {
      method: "POST",
      body: { name: input.name }
    });
    return { name: response.user?.name ?? input.name };
  }

  async deleteUser(userName: string) {
    const user = await this.findUserByName(userName);
    if (!user?.id) return;
    await this.request(`/api/v1/user/${encodeURIComponent(user.id)}`, { method: "DELETE" });
  }

  async createPreAuthKey(input: CreatePreAuthKeyInput): Promise<HeadscalePreAuthKey> {
    const user = await this.findUserByName(input.userName);
    if (!user?.id) {
      throw new Error(`Headscale user not found: ${input.userName}`);
    }

    const response = await this.request<{ preAuthKey?: HeadscaleApiPreAuthKey }>("/api/v1/preauthkey", {
      method: "POST",
      body: {
        user: user.id,
        reusable: input.reusable,
        ephemeral: input.ephemeral,
        expiration: input.expiresAt.toISOString()
      }
    });
    const preAuthKey = response.preAuthKey;
    if (!preAuthKey?.id || !preAuthKey.key) {
      throw new Error("Headscale did not return a pre-auth key");
    }
    return {
      id: preAuthKey.id,
      key: preAuthKey.key,
      expiresAt: preAuthKey.expiration ? new Date(preAuthKey.expiration) : input.expiresAt
    };
  }

  async listNodes(): Promise<HeadscaleNode[]> {
    const response = await this.request<{ nodes?: HeadscaleApiNode[] }>("/api/v1/node");
    return (response.nodes ?? []).map((node) => {
      const advertisedRoutes = node.availableRoutes ?? node.subnetRoutes ?? [];
      return {
        id: this.requireString(node.id, "node.id"),
        userName: node.user?.name ?? "",
        name: node.name ?? node.givenName ?? this.requireString(node.id, "node.id"),
        givenName: node.givenName,
        machineKey: node.machineKey,
        nodeKey: node.nodeKey,
        advertisedRoutes,
        isExitNode: advertisedRoutes.includes("0.0.0.0/0") || advertisedRoutes.includes("::/0"),
        lastSeenAt: node.lastSeen ? new Date(node.lastSeen) : undefined
      };
    });
  }

  async expireNode(nodeId: string) {
    await this.request(`/api/v1/node/${encodeURIComponent(nodeId)}/expire`, { method: "POST" });
  }

  async deleteNode(nodeId: string) {
    await this.request(`/api/v1/node/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
  }

  async getPolicy(): Promise<HeadscalePolicy> {
    const response = await this.request<{ policy?: string }>("/api/v1/policy");
    if (!response.policy) return { acls: [] };
    return JSON.parse(response.policy) as HeadscalePolicy;
  }

  async applyPolicy(policy: HeadscalePolicy) {
    await this.request("/api/v1/policy", {
      method: "PUT",
      body: { policy: JSON.stringify(policy, null, 2) }
    });
  }

  private async findUserByName(name: string): Promise<HeadscaleApiUser | undefined> {
    const response = await this.request<{ users?: HeadscaleApiUser[] }>(`/api/v1/user?name=${encodeURIComponent(name)}`);
    return response.users?.find((user) => user.name === name);
  }

  private async request<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? "GET";
    const startedAt = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" })
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      });

      const text = await response.text();
      const durationMs = Date.now() - startedAt;
      const logData = { method, path, statusCode: response.status, durationMs };
      if (!response.ok) {
        this.logger?.error({ ...logData, responseBody: text || response.statusText }, "Headscale API request failed");
        throw new Error(`Headscale API ${response.status}: ${text || response.statusText}`);
      }

      this.logger?.info(logData, "Headscale API request completed");
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("Headscale API "))) {
        this.logger?.error({
          method,
          path,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        }, "Headscale API request errored");
      }
      throw error;
    }
  }

  private requireString(value: string | undefined, label: string) {
    if (!value) throw new Error(`Headscale response missing ${label}`);
    return value;
  }
}
