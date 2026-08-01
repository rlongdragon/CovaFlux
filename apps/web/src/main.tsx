import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  Clipboard,
  Download,
  Ellipsis,
  Filter,
  KeyRound,
  LogOut,
  MonitorCog,
  CircleHelp,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import { downloadMachinesCsv, exportMachinesCsv, filterMachines, machineStatus, subnetRoutes, type MachineFilter, type NodeItem } from "./machines.js";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || `${window.location.protocol}//${window.location.hostname}:12145`;
const HEADSCALE_LOGIN_URL = import.meta.env.VITE_HEADSCALE_LOGIN_URL || `${window.location.protocol}//${window.location.hostname}`;

type Actor = { type: "user" | "api_token"; id: string; username?: string; role?: "admin" | "user" };
type ApiState = { nodes: NodeItem[] };
type RegistrationCommand = { key: string; nodeName?: string };


const initialData: ApiState = { nodes: [] };

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("covaflux_token") ?? "");
  const [actor, setActor] = useState<Actor | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<ApiState>(initialData);

  const [filter, setFilter] = useState<MachineFilter>({ status: "all", capability: "all", query: "" });
  const [showFilters, setShowFilters] = useState(false);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [nodeName, setNodeName] = useState("");
  const [registrationCommand, setRegistrationCommand] = useState<RegistrationCommand | null>(null);
  const [busy, setBusy] = useState(false);

  const authHeaders = useMemo(() => ({ ...(token ? { authorization: "Bearer " + token } : {}) }), [token]);

  async function api(path: string, options: RequestInit = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...authHeaders, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = Array.isArray(body.issues)
        ? body.issues.map((issue: { path?: string[]; message?: string }) => `${issue.path?.join(".") || "body"}: ${issue.message}`).join("; ")
        : undefined;
      throw new Error(validationMessage ?? body.message ?? body.error ?? `HTTP ${response.status}`);
    }
    return body;
  }

  async function login() {
    setBusy(true);
    try {
      const body = await api("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      localStorage.setItem("covaflux_token", body.token);
      setToken(body.token);
      setStatus("Welcome back");
    } finally {
      setBusy(false);
    }
  }

  async function loadAll(quiet = false) {
    if (!token) return;
    const me = await api("/me");
    const currentActor = me.actor as Actor;
    setActor(currentActor);
    const nodes = await api("/nodes");
    setData({ ...initialData, nodes });
    if (!quiet) setStatus("Machines updated");
  }

  async function syncNodes() {
    setBusy(true);
    try {
      await api("/nodes/sync", { method: "POST", body: "{}" });
      await loadAll(true);
      setStatus("Headscale inventory synchronized");
    } finally {
      setBusy(false);
    }
  }

  async function createRegistrationKey() {
    setBusy(true);
    try {
      const body = await api("/nodes/register-key", {
        method: "POST",
        body: JSON.stringify({ nodeName: nodeName || undefined, reusable: false, ephemeral: false, expiresInHours: 24 })
      });
      setRegistrationCommand({ key: body.key, nodeName: nodeName || undefined });
      setStatus("Registration key created");
    } finally {
      setBusy(false);
    }
  }

  async function nodeAction(node: NodeItem, action: "approve" | "disable" | "expire" | "delete") {
    if (action === "delete" && !window.confirm(`Delete ${node.givenName ?? node.name} from Headscale?`)) return;
    const request = action === "delete"
      ? { path: `/nodes/${node.id}`, method: "DELETE" }
      : action === "expire"
        ? { path: `/nodes/${node.id}/expire`, method: "POST" }
        : { path: `/nodes/${node.id}/exit-node/${action}`, method: "POST" };
    setBusy(true);
    try {
      await api(request.path, { method: request.method, ...(request.method === "POST" ? { body: "{}" } : {}) });
      await loadAll(true);
      setStatus(`${node.givenName ?? node.name} updated`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadAll(true).catch((error) => {
      setStatus(error.message);
      if (/401|unauthorized|invalid/i.test(error.message)) {
        localStorage.removeItem("covaflux_token");
        setToken("");
      }
    });
  }, [token]);

  if (!token) return <Login username={username} password={password} busy={busy} status={status} setUsername={setUsername} setPassword={setPassword} onLogin={() => login().catch((error) => setStatus(error.message))} />;

  const visibleNodes = filterMachines(data.nodes, filter);
  return (
    <div className="app-shell">
      <Topbar actor={actor} onLogout={() => { localStorage.removeItem("covaflux_token"); setToken(""); setActor(null); }} />
      <main className="workspace">
        <MachinesView
            nodes={visibleNodes}
            total={data.nodes.length}
            filter={filter}
            setFilter={setFilter}
            showFilters={showFilters}
            setShowFilters={setShowFilters}
            canManageExitNodes={actor?.type === "user" && actor.role === "admin"}
            busy={busy}
            onSync={() => syncNodes().catch((error) => setStatus(error.message))}
            onAdd={() => { setRegistrationCommand(null); setShowAddDevice(true); }}
            onExport={() => downloadMachinesCsv(exportMachinesCsv(visibleNodes))}
            onAction={(node, action) => nodeAction(node, action).catch((error) => setStatus(error.message))}
        />
      </main>
      {status && <div className="toast" role="status"><span>{status}</span><button aria-label="Dismiss notification" onClick={() => setStatus("")}><X size={15} /></button></div>}
      {showAddDevice && (
        <AddDeviceDialog
          nodeName={nodeName}
          setNodeName={setNodeName}
          command={registrationCommand}
          busy={busy}
          onCreate={() => createRegistrationKey().catch((error) => setStatus(error.message))}
          onClose={() => setShowAddDevice(false)}
          onCopy={(value) => navigator.clipboard.writeText(value).then(() => setStatus("Command copied"))}
        />
      )}
    </div>
  );
}

function Login({ username, password, busy, status, setUsername, setPassword, onLogin }: { username: string; password: string; busy: boolean; status: string; setUsername: (value: string) => void; setPassword: (value: string) => void; onLogin: () => void }) {
  return <main className="login-page"><section className="login-card"><Brand /><div className="login-copy"><h1>Sign in to CovaFlux</h1><p>Manage your private Headscale network.</p></div><label>Username<input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onLogin()} /></label>{status && <p className="login-error" role="alert">{status}</p>}<button className="primary full" disabled={busy} onClick={onLogin}><KeyRound size={16} /> {busy ? "Signing in…" : "Sign in"}</button></section></main>;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><i /><i /><i /><i /><i /></span><strong>CovaFlux</strong></div>;
}

function Topbar({ actor, onLogout }: { actor: Actor | null; onLogout: () => void }) {
  return <><header className="topbar"><div className="topbar-inner"><Brand /><div className="account"><button className="icon-button" title="Help"><CircleHelp size={18} /></button><span className="avatar"><UserRound size={15} /></span><span className="account-name">{actor?.username ?? actor?.id ?? "Account"}</span><button className="icon-button" title="Sign out" onClick={onLogout}><LogOut size={17} /></button></div></div></header><div className="nav-shell"><nav className="main-nav" aria-label="Main navigation"><button className="active"><MonitorCog size={15} /> Machines</button></nav></div></>;
}

function MachinesView({ nodes, total, filter, setFilter, showFilters, setShowFilters, canManageExitNodes, busy, onSync, onAdd, onExport, onAction }: { nodes: NodeItem[]; total: number; filter: MachineFilter; setFilter: React.Dispatch<React.SetStateAction<MachineFilter>>; showFilters: boolean; setShowFilters: (value: boolean) => void; canManageExitNodes: boolean; busy: boolean; onSync: () => void; onAdd: () => void; onExport: () => void; onAction: (node: NodeItem, action: "approve" | "disable" | "expire" | "delete") => void }) {
  const activeFilterCount = Number(filter.status !== "all") + Number(filter.capability !== "all");
  return <section className="machines-page"><div className="page-heading"><div><h1>Machines</h1><p>Manage the devices connected to your network. <button className="learn-link">Learn more</button></p></div><button className="primary" onClick={onAdd}>Add device <ChevronDown size={14} /></button></div><div className="machine-tools"><div className="search-box"><Search size={17} /><input aria-label="Search machines" placeholder="Search by name, owner, tag, version…" value={filter.query ?? ""} onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))} />{filter.query && <button aria-label="Clear search" onClick={() => setFilter((current) => ({ ...current, query: "" }))}><X size={15} /></button>}</div><div className="filter-wrap"><button className={`secondary ${activeFilterCount ? "selected" : ""}`} onClick={() => setShowFilters(!showFilters)}><Filter size={16} /> Filters {activeFilterCount > 0 && <b>{activeFilterCount}</b>} <ChevronDown size={14} /></button>{showFilters && <FilterMenu filter={filter} setFilter={setFilter} onClose={() => setShowFilters(false)} />}</div><button className="learn-link tools-learn">Learn more</button><button className="icon-button tool-icon" title="Synchronize machines" disabled={busy} onClick={onSync}><RefreshCw size={17} className={busy ? "spin" : ""} /></button><button className="icon-button tool-icon" title="Export visible machines as CSV" onClick={onExport}><Download size={17} /></button></div><div className="result-meta"><span>{nodes.length === total ? `${total} machine${total === 1 ? "" : "s"}` : `${nodes.length} of ${total} machines`}</span>{(activeFilterCount > 0 || filter.query) && <button onClick={() => setFilter({ status: "all", capability: "all", query: "" })}>Clear all</button>}</div><MachineTable nodes={nodes} canManageExitNodes={canManageExitNodes} onAction={onAction} /></section>;
}

function FilterMenu({ filter, setFilter, onClose }: { filter: MachineFilter; setFilter: React.Dispatch<React.SetStateAction<MachineFilter>>; onClose: () => void }) {
  return <div className="filter-menu"><div className="menu-title"><strong>Filter machines</strong><button onClick={onClose}><X size={15} /></button></div><fieldset><legend>Status</legend>{(["all", "online", "offline", "expired"] as const).map((value) => <label key={value}><input type="radio" name="status" checked={filter.status === value} onChange={() => setFilter((current) => ({ ...current, status: value }))} /> {capitalize(value)}</label>)}</fieldset><fieldset><legend>Capability</legend>{(["all", "exit-node", "subnet"] as const).map((value) => <label key={value}><input type="radio" name="capability" checked={filter.capability === value} onChange={() => setFilter((current) => ({ ...current, capability: value }))} /> {value === "exit-node" ? "Exit node" : value === "subnet" ? "Subnet router" : "All"}</label>)}</fieldset><button className="reset-filter" onClick={() => setFilter((current) => ({ ...current, status: "all", capability: "all" }))}>Reset filters</button></div>;
}

function MachineTable({ nodes, canManageExitNodes, onAction }: { nodes: NodeItem[]; canManageExitNodes: boolean; onAction: (node: NodeItem, action: "approve" | "disable" | "expire" | "delete") => void }) {
  if (!nodes.length) return <div className="empty-machines"><MonitorCog size={28} /><h2>No machines found</h2><p>Try changing your search or filters.</p></div>;
  return <div className="table-scroll"><table className="machine-table"><thead><tr><th>Machine</th><th>Addresses</th><th>Last seen</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{nodes.map((node) => <MachineRow key={node.id} node={node} canManageExitNodes={canManageExitNodes} onAction={onAction} />)}</tbody></table></div>;
}

function MachineRow({ node, canManageExitNodes, onAction }: { node: NodeItem; canManageExitNodes: boolean; onAction: (node: NodeItem, action: "approve" | "disable" | "expire" | "delete") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const status = machineStatus(node);
  const routes = subnetRoutes(node);
  const name = node.givenName ?? node.name;
  useEffect(() => { const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as globalThis.Node)) setOpen(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  return <tr><td><div className="machine-name"><div><span className={`status-dot mobile-status ${status}`} /> <strong>{name}</strong></div><span>{node.owner?.username ?? node.ownerUserId ?? "Unassigned"}</span><div className="badges">{node.expired && <Badge tone="neutral">Expired</Badge>}{node.isExitNode && <Badge tone={node.isExitNodeApproved ? "blue" : "warning"}>{node.isExitNodeApproved ? "Exit node" : "Exit pending"}</Badge>}{routes.length > 0 && <Badge tone="blue">Subnets</Badge>}{node.driftStatus && node.driftStatus !== "managed" && <Badge tone="warning">{node.driftStatus}</Badge>}</div></div></td><td><AddressList name={name} addresses={node.ipAddresses ?? []} /></td><td><div className="last-seen"><span className={`status-dot ${status}`} /> <span>{node.online && !node.expired ? "Connected" : formatRelative(node.lastSeenAt)}</span>{node.expiresAt && <small>{node.expired ? `Expired ${formatShortDate(node.expiresAt)}` : `Expires ${formatShortDate(node.expiresAt)}`}</small>}</div></td><td className="action-cell"><div className="row-menu" ref={ref}><button className="ellipsis" aria-label={`Actions for ${name}`} aria-expanded={open} onClick={() => setOpen(!open)}><Ellipsis size={19} /></button>{open && <div className="action-menu">{canManageExitNodes && node.isExitNode && !node.isExitNodeApproved && <button onClick={() => { onAction(node, "approve"); setOpen(false); }}><Shield size={15} /> Approve exit node</button>}{canManageExitNodes && node.isExitNodeApproved && <button onClick={() => { onAction(node, "disable"); setOpen(false); }}><Shield size={15} /> Disable exit node</button>}<button disabled={node.expired} onClick={() => { onAction(node, "expire"); setOpen(false); }}><KeyRound size={15} /> Expire key</button><hr /><button className="danger-text" onClick={() => { onAction(node, "delete"); setOpen(false); }}><Trash2 size={15} /> Delete machine</button></div>}</div></td></tr>;
}

function AddressList({ name, addresses }: { name: string; addresses: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!addresses.length) return <span className="muted">No address</span>;
  const detailAddresses = [name, ...addresses];
  return <div className="address-wrap"><button className="address-list" onClick={() => setExpanded(!expanded)}><span>{addresses[0]}</span><ChevronDown size={14} /></button>{expanded && <div className="address-popover">{detailAddresses.map((value) => <div key={value}><span>{value}</span><button title={`Copy ${value}`} onClick={() => navigator.clipboard.writeText(value)}><Clipboard size={14} /></button></div>)}</div>}</div>;
}

function Badge({ tone, children }: { tone: "neutral" | "blue" | "warning"; children: React.ReactNode }) { return <span className={`badge ${tone}`}>{children}</span>; }

function AddDeviceDialog({ nodeName, setNodeName, command, busy, onCreate, onClose, onCopy }: { nodeName: string; setNodeName: (value: string) => void; command: RegistrationCommand | null; busy: boolean; onCreate: () => void; onClose: () => void; onCopy: (value: string) => void }) {
  const loginServer = HEADSCALE_LOGIN_URL;
  const base = command ? `sudo tailscale up --reset --login-server=${loginServer} --auth-key=${command.key}` : "";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-device-title"><div className="modal-heading"><div><h2 id="add-device-title">Add a device</h2><p>Create a single-use key and connect a Tailscale client to CovaFlux.</p></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></div>{!command ? <><label>Machine name <span>Optional</span><input autoFocus placeholder="e.g. build-server" value={nodeName} onChange={(event) => setNodeName(event.target.value)} /></label><div className="modal-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={onCreate}>{busy ? "Creating…" : "Create key"}</button></div></> : <div className="setup-commands"><p>Run one of these commands on the new machine. The key expires in 24 hours.</p><Command label="Standard device" value={base} onCopy={onCopy} /><Command label="Exit node" value={`${base} --advertise-exit-node`} onCopy={onCopy} /><div className="secret-note"><Shield size={16} /> Treat this command as a secret. It contains a temporary authentication key.</div><div className="modal-actions"><button className="primary" onClick={onClose}>Done</button></div></div>}</section></div>;
}

function Command({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string) => void }) { return <div className="command"><strong>{label}</strong><div><code>{value}</code><button title={`Copy ${label} command`} onClick={() => onCopy(value)}><Clipboard size={16} /></button></div></div>; }



function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatShortDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "unknown" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }).format(date); }
function formatRelative(value?: string | null) { if (!value) return "Never"; const date = new Date(value); if (Number.isNaN(date.getTime())) return "Unknown"; const delta = Date.now() - date.getTime(); const minutes = Math.floor(delta / 60_000); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; const days = Math.floor(hours / 24); if (days < 14) return `${days}d ago`; return formatShortDate(value); }

createRoot(document.getElementById("root")!).render(<App />);
