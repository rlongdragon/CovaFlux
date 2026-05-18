import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clipboard, KeyRound, Power, RefreshCw, Shield, Trash2, Users, Workflow } from "lucide-react";
import "./styles.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  `${window.location.protocol}//${window.location.hostname}:12145`;

type ApiState = {
  users: unknown[];
  nodes: unknown[];
  groups: unknown[];
  shares: unknown[];
  policy: unknown;
  tokens: unknown[];
  auditLogs: unknown[];
};

type Actor = {
  type: "user" | "api_token";
  id: string;
  username?: string;
  role?: "admin" | "user";
};

type UserItem = {
  id: string;
  username: string;
  role?: string;
};

type NodeItem = {
  id: string;
  headscaleNodeId?: string;
  name: string;
  givenName?: string | null;
  isExitNode?: boolean;
  ownerUserId?: string | null;
  owner?: UserItem | null;
  ipAddresses?: string[];
  online?: boolean;
  expired?: boolean;
  lastSeenAt?: string | null;
  expiresAt?: string | null;
  driftStatus?: string;
};

type GroupItem = {
  id: string;
  name: string;
  members?: Array<{ user?: UserItem }>;
};

type ShareItem = {
  id: string;
  node?: NodeItem;
  targetUser?: UserItem | null;
  targetGroup?: GroupItem | null;
  allowExitNode: boolean;
  revokedAt?: string | null;
};

type RegistrationCommand = {
  key: string;
  nodeName?: string;
};

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("covaflux_token") ?? "");
  const [actor, setActor] = useState<Actor | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("change-me-password");
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "user" });
  const [nodeName, setNodeName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [targetGroupId, setTargetGroupId] = useState("");
  const [memberGroupId, setMemberGroupId] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [allowExitNode, setAllowExitNode] = useState(false);
  const [registrationCommand, setRegistrationCommand] = useState<RegistrationCommand | null>(null);
  const [status, setStatus] = useState("");
  const [data, setData] = useState<ApiState>({
    users: [],
    nodes: [],
    groups: [],
    shares: [],
    policy: null,
    tokens: [],
    auditLogs: []
  });

  const authHeaders = useMemo(() => ({
    ...(token ? { authorization: `Bearer ${token}` } : {})
  }), [token]);

  async function api(path: string, options: RequestInit = {}) {
    const requestHeaders = {
      ...authHeaders,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    };
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: requestHeaders
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const validationMessage = Array.isArray(body.issues)
        ? body.issues.map((issue: { path?: string[]; message?: string }) => `${issue.path?.join(".") || "body"}: ${issue.message}`).join("; ")
        : undefined;
      throw new Error(validationMessage ?? body.message ?? body.error ?? `HTTP ${res.status}`);
    }
    return body;
  }

  async function login() {
    const body = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    localStorage.setItem("covaflux_token", body.token);
    setToken(body.token);
    setStatus("登入成功");
  }

  async function loadAll() {
    if (!token) return;
    const me = await api("/me");
    const currentActor = me.actor as Actor;
    setActor(currentActor);

    const [users, nodes, groups, shares] = await Promise.all([
      api("/users"),
      api("/nodes"),
      api("/groups"),
      api("/shares")
    ]);

    let policy = null;
    let tokens: unknown[] = [];
    let auditLogs: unknown[] = [];

    if (currentActor.type === "user" && currentActor.role === "admin") {
      [policy, tokens, auditLogs] = await Promise.all([
        api("/policy/preview"),
        api("/api-tokens"),
        api("/audit-logs")
      ]);
    }

    setData({ users, nodes, groups, shares, policy, tokens, auditLogs });
    setStatus("資料已更新");
  }

  async function createUser() {
    await api("/users", {
      method: "POST",
      body: JSON.stringify(newUser)
    });
    setNewUser({ username: "", password: "", role: "user" });
    await loadAll();
  }

  async function createGroup() {
    await api("/groups", {
      method: "POST",
      body: JSON.stringify({ name: groupName })
    });
    setGroupName("");
    await loadAll();
  }

  async function createRegistrationKey() {
    const body = await api("/nodes/register-key", {
      method: "POST",
      body: JSON.stringify({ nodeName: nodeName || undefined, reusable: false, ephemeral: false, expiresInHours: 24 })
    });
    setRegistrationCommand({ key: body.key, nodeName: nodeName || undefined });
    setNodeName("");
    setStatus(`註冊 key: ${body.key}`);
    await api("/nodes/sync", { method: "POST", body: JSON.stringify({}) });
    await loadAll();
  }

  async function copyCommand(command: string) {
    await navigator.clipboard.writeText(command);
    setStatus("已複製指令");
  }

  async function shareNodeToUser() {
    await api(`/nodes/${selectedNodeId}/shares/users`, {
      method: "POST",
      body: JSON.stringify({ targetUserId, allowExitNode })
    });
    setStatus("已分享節點給 user");
    await loadAll();
  }

  async function shareNodeToGroup() {
    await api(`/nodes/${selectedNodeId}/shares/groups`, {
      method: "POST",
      body: JSON.stringify({ targetGroupId, allowExitNode })
    });
    setStatus("已分享節點給 group");
    await loadAll();
  }

  async function addGroupMember() {
    await api(`/groups/${memberGroupId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: memberUserId })
    });
    setStatus("已加入 group member");
    await loadAll();
  }

  async function revokeShare(shareId: string) {
    await api(`/shares/${shareId}`, { method: "DELETE" });
    setStatus("已撤銷 share");
    await loadAll();
  }

  async function applyPolicy() {
    await api("/policy/apply", { method: "POST", body: JSON.stringify({}) });
    await loadAll();
  }

  async function syncNodes() {
    await api("/nodes/sync", { method: "POST", body: JSON.stringify({}) });
    setStatus("節點已同步");
    await loadAll();
  }

  async function expireNode(nodeId: string) {
    await api(`/nodes/${nodeId}/expire`, { method: "POST", body: JSON.stringify({}) });
    setStatus("節點已設為 expired");
    await syncNodes();
  }

  async function deleteNode(nodeId: string) {
    if (!window.confirm("確定要從 Headscale 刪除這個節點？")) return;
    await api(`/nodes/${nodeId}`, { method: "DELETE" });
    setStatus("節點已刪除");
    await loadAll();
  }

  useEffect(() => {
    loadAll().catch((error) => setStatus(error.message));
  }, [token]);

  const users = data.users as UserItem[];
  const nodes = data.nodes as NodeItem[];
  const groups = data.groups as GroupItem[];
  const shares = data.shares as ShareItem[];
  const tailscaleLoginServer = `http://${window.location.hostname}`;
  const tailscaleBaseCommand = registrationCommand
    ? `sudo tailscale up --reset --login-server=${tailscaleLoginServer} --auth-key=${registrationCommand.key}`
    : "";
  const tailscaleExitNodeCommand = tailscaleBaseCommand ? `${tailscaleBaseCommand} --advertise-exit-node` : "";

  return (
    <main>
      <header>
        <div>
          <h1>CovaFlux</h1>
          <p>Headscale 管理 API 開發測試前台</p>
        </div>
        <button onClick={() => loadAll().catch((error) => setStatus(error.message))}>
          <RefreshCw size={16} /> 重新整理
        </button>
      </header>

      <section className="toolbar">
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button onClick={() => login().catch((error) => setStatus(error.message))}>
          <KeyRound size={16} /> 登入
        </button>
        <button onClick={() => { localStorage.removeItem("covaflux_token"); setToken(""); setActor(null); }}>
          登出
        </button>
      </section>

      {status && <div className="status">{status}</div>}
      {actor && <div className="status">目前登入：{actor.username ?? actor.id} / {actor.role ?? actor.type}</div>}

      <div className="grid">
        <Panel title="Users" icon={<Users size={18} />}>
          {actor?.role === "admin" && (
            <div className="inline">
              <input placeholder="username" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} />
              <input placeholder="password, min 8 chars" minLength={8} type="password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} />
              <select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <button onClick={() => createUser().catch((error) => setStatus(error.message))}>建立</button>
            </div>
          )}
          <Json data={data.users} />
        </Panel>

        <Panel title="Nodes" icon={<Workflow size={18} />}>
          <div className="inline">
            <input placeholder="node name" value={nodeName} onChange={(event) => setNodeName(event.target.value)} />
            <button onClick={() => createRegistrationKey().catch((error) => setStatus(error.message))}>建立註冊 key</button>
            <button onClick={() => syncNodes().catch((error) => setStatus(error.message))}>Sync Nodes</button>
          </div>
          {registrationCommand && (
            <div className="command-box">
              <div className="command-header">
                <strong>節點加入指令{registrationCommand.nodeName ? ` / ${registrationCommand.nodeName}` : ""}</strong>
              </div>
              <CommandLine label="一般節點" command={tailscaleBaseCommand} onCopy={copyCommand} />
              <CommandLine label="Exit node" command={tailscaleExitNodeCommand} onCopy={copyCommand} />
            </div>
          )}
          <NodeList nodes={nodes} onExpire={expireNode} onDelete={deleteNode} onError={setStatus} />
        </Panel>

        <Panel title="Groups" icon={<Users size={18} />}>
          <div className="inline">
            <input placeholder="group name" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
            <button onClick={() => createGroup().catch((error) => setStatus(error.message))}>建立</button>
          </div>
          <div className="inline form-row">
            <select value={memberGroupId} onChange={(event) => setMemberGroupId(event.target.value)}>
              <option value="">選 group</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <select value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)}>
              <option value="">選 member user</option>
              {users.filter((user) => user.id !== actor?.id).map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
            </select>
            <button disabled={!memberGroupId || !memberUserId} onClick={() => addGroupMember().catch((error) => setStatus(error.message))}>加入成員</button>
          </div>
          <Json data={data.groups} />
        </Panel>

        <Panel title="Share Node" icon={<Workflow size={18} />}>
          <div className="inline form-row">
            <select value={selectedNodeId} onChange={(event) => setSelectedNodeId(event.target.value)}>
              <option value="">選 node</option>
              {nodes.map((node) => <option key={node.id} value={node.id}>{node.givenName ?? node.name}</option>)}
            </select>
            <label className="check">
              <input type="checkbox" checked={allowExitNode} onChange={(event) => setAllowExitNode(event.target.checked)} />
              allow exit node
            </label>
          </div>
          <div className="inline form-row">
            <select value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)}>
              <option value="">選 target user</option>
              {users.filter((user) => user.id !== actor?.id).map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
            </select>
            <button disabled={!selectedNodeId || !targetUserId} onClick={() => shareNodeToUser().catch((error) => setStatus(error.message))}>分享給 User</button>
          </div>
          <div className="inline form-row">
            <select value={targetGroupId} onChange={(event) => setTargetGroupId(event.target.value)}>
              <option value="">選 target group</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <button disabled={!selectedNodeId || !targetGroupId} onClick={() => shareNodeToGroup().catch((error) => setStatus(error.message))}>分享給 Group</button>
          </div>
        </Panel>

        {actor?.role === "admin" && (
          <Panel title="Policy" icon={<Shield size={18} />}>
            <button onClick={() => applyPolicy().catch((error) => setStatus(error.message))}>Apply Policy</button>
            <Json data={data.policy} />
          </Panel>
        )}

        <Panel title="Shares / Tokens / Audit" icon={<KeyRound size={18} />}>
          <h3>Shares</h3>
          <div className="list">
            {shares.map((share) => (
              <div className="list-item" key={share.id}>
                <span>{share.node?.givenName ?? share.node?.name ?? share.id}</span>
                <span>{share.targetUser?.username ?? share.targetGroup?.name ?? "unknown"}</span>
                <span>{share.allowExitNode ? "exit allowed" : "node only"}</span>
                {!share.revokedAt && <button onClick={() => revokeShare(share.id).catch((error) => setStatus(error.message))}>撤銷</button>}
              </div>
            ))}
          </div>
          <Json data={data.shares} />
          {actor?.role === "admin" && (
            <>
              <h3>API Tokens</h3>
              <Json data={data.tokens} />
              <h3>Audit Logs</h3>
              <Json data={data.auditLogs} />
            </>
          )}
        </Panel>
      </div>
    </main>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{icon}{title}</h2>
      {children}
    </section>
  );
}

function NodeList({
  nodes,
  onExpire,
  onDelete,
  onError
}: {
  nodes: NodeItem[];
  onExpire: (nodeId: string) => Promise<void>;
  onDelete: (nodeId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  if (nodes.length === 0) {
    return <div className="empty-state">尚未同步到節點</div>;
  }

  return (
    <div className="node-table">
      <div className="node-row node-head">
        <span>節點</span>
        <span>狀態</span>
        <span>IP</span>
        <span>Owner</span>
        <span>Last seen</span>
        <span>操作</span>
      </div>
      {nodes.map((node) => {
        const ipAddresses = node.ipAddresses ?? [];
        const statusLabel = node.expired ? "expired" : node.online ? "online" : "offline";
        return (
          <div className="node-row" key={node.id}>
            <div className="node-name">
              <strong>{node.givenName ?? node.name}</strong>
              <small>hs #{node.headscaleNodeId ?? "-"} / {node.driftStatus ?? "managed"}</small>
            </div>
            <span className={`pill ${statusLabel}`}>{statusLabel}</span>
            <span className="mono">{ipAddresses.join(", ") || "-"}</span>
            <span>{node.owner?.username ?? node.ownerUserId ?? "-"}</span>
            <span>{formatDate(node.lastSeenAt)}</span>
            <div className="node-actions">
              <button
                disabled={node.expired}
                onClick={() => onExpire(node.id).catch((error) => onError(error.message))}
                title="Expire node"
              >
                <Power size={15} /> Expire
              </button>
              <button
                className="danger"
                onClick={() => onDelete(node.id).catch((error) => onError(error.message))}
                title="Delete node from Headscale"
              >
                <Trash2 size={15} /> Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Json({ data }: { data: unknown }) {
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}

function CommandLine({ label, command, onCopy }: { label: string; command: string; onCopy: (command: string) => Promise<void> }) {
  return (
    <div className="command-line">
      <span>{label}</span>
      <code>{command}</code>
      <button onClick={() => onCopy(command).catch(() => undefined)} title={`複製${label}指令`}>
        <Clipboard size={16} /> 複製
      </button>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

createRoot(document.getElementById("root")!).render(<App />);
