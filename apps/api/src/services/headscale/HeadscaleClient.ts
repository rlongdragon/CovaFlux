export interface CreateHeadscaleUserInput {
  name: string;
}

export interface HeadscaleUser {
  name: string;
}

export interface CreatePreAuthKeyInput {
  userName: string;
  nodeName?: string;
  reusable: boolean;
  ephemeral: boolean;
  expiresAt: Date;
}

export interface HeadscalePreAuthKey {
  id: string;
  key: string;
  expiresAt: Date;
}

export interface HeadscaleNode {
  id: string;
  userName: string;
  name: string;
  givenName?: string;
  machineKey?: string;
  nodeKey?: string;
  advertisedRoutes: string[];
  isExitNode: boolean;
  lastSeenAt?: Date;
}

export interface HeadscalePolicy {
  groups?: Record<string, string[]>;
  acls: Array<{
    action: "accept";
    src: string[];
    dst: string[];
  }>;
  autoApprovers?: Record<string, unknown>;
}

export interface HeadscaleClient {
  health(): Promise<void>;
  createUser(input: CreateHeadscaleUserInput): Promise<HeadscaleUser>;
  deleteUser(userName: string): Promise<void>;
  createPreAuthKey(input: CreatePreAuthKeyInput): Promise<HeadscalePreAuthKey>;
  listNodes(): Promise<HeadscaleNode[]>;
  expireNode(nodeId: string): Promise<void>;
  deleteNode(nodeId: string): Promise<void>;
  getPolicy(): Promise<HeadscalePolicy>;
  applyPolicy(policy: HeadscalePolicy): Promise<void>;
}
