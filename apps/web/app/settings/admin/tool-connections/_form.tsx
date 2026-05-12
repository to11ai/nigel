"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminCreateToolConnection } from "@/lib/admin/tool-connections-actions";
import type { ToolConnectionKind } from "@/lib/tool-connections";

// The form keeps the per-kind field surface inline so the data flow
// is one file deep — admins editing a single field shouldn't have to
// trace through three component layers. Each kind's section
// reads/writes a small typed state slice that maps directly onto the
// validated `config` and `secrets` payloads the server action wants.

type ScopeKind = "global" | "specialist";

type Props = {
  kinds: readonly ToolConnectionKind[];
  onCreated: () => void | Promise<void>;
};

export function ToolConnectionForm({ kinds, onCreated }: Props) {
  const [kind, setKind] = useState<ToolConnectionKind>("postgres");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("global");
  const [specialistName, setSpecialistName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Per-kind form state. Kept flat so the form re-renders cheaply
  // and a kind switch doesn't blow away every typed field.
  const [pg, setPg] = useState<PostgresFields>({
    host: "",
    port: "5432",
    database: "",
    user: "",
    sslMode: "require",
    readOnly: true,
    password: "",
  });
  const [ch, setCh] = useState<ClickhouseFields>({
    host: "",
    protocol: "https",
    port: "8443",
    database: "",
    user: "",
    readOnly: true,
    password: "",
  });
  const [rd, setRd] = useState<RedisFields>({
    host: "",
    port: "6379",
    db: "0",
    username: "",
    tls: true,
    readOnly: true,
    password: "",
  });
  const [mcpHttp, setMcpHttp] = useState<McpHttpFields>({
    url: "",
    bearerToken: "",
  });
  const [mcpStdio, setMcpStdio] = useState<McpStdioFields>({
    command: "",
    args: "",
  });
  const [mcpTransport, setMcpTransport] = useState<"http" | "stdio">("http");
  const [sl, setSl] = useState<SlackFields>({
    channel: "",
    username: "",
    webhookUrl: "",
  });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const built = buildPayload();
      if (!built) {
        // buildPayload toasted the validation issue itself.
        return;
      }
      const res = await adminCreateToolConnection({
        name: name.trim(),
        kind,
        description: description.trim() || null,
        config: built.config,
        secrets: built.secrets,
        scope:
          scopeKind === "global"
            ? { kind: "global" }
            : {
                kind: "specialist",
                specialistName: specialistName.trim(),
              },
      });
      if (res.success) {
        toast.success(`Created connection '${name.trim()}'`);
        await onCreated();
      } else {
        toast.error(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function buildPayload(): { config: unknown; secrets: unknown } | null {
    if (!name.trim()) {
      toast.error("Name is required");
      return null;
    }
    if (scopeKind === "specialist" && !specialistName.trim()) {
      toast.error("Specialist name is required for specialist-scoped rows");
      return null;
    }
    switch (kind) {
      case "postgres":
        return {
          config: {
            host: pg.host.trim(),
            port: numberOrUndefined(pg.port),
            database: pg.database.trim(),
            user: pg.user.trim(),
            sslMode: pg.sslMode,
            readOnly: pg.readOnly,
          },
          secrets: { password: pg.password },
        };
      case "clickhouse":
        return {
          config: {
            host: ch.host.trim(),
            protocol: ch.protocol,
            port: numberOrUndefined(ch.port),
            database: ch.database.trim(),
            user: ch.user.trim(),
            readOnly: ch.readOnly,
          },
          secrets: { password: ch.password },
        };
      case "redis":
        return {
          config: {
            host: rd.host.trim(),
            port: numberOrUndefined(rd.port),
            db: numberOrUndefined(rd.db),
            ...(rd.username.trim() ? { username: rd.username.trim() } : {}),
            tls: rd.tls,
            readOnly: rd.readOnly,
          },
          secrets: rd.password ? { password: rd.password } : {},
        };
      case "mcp":
        if (mcpTransport === "http") {
          return {
            config: { transport: "http", url: mcpHttp.url.trim() },
            secrets: mcpHttp.bearerToken
              ? { bearerToken: mcpHttp.bearerToken }
              : {},
          };
        }
        return {
          config: {
            transport: "stdio",
            command: mcpStdio.command.trim(),
            args: mcpStdio.args
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          },
          secrets: {},
        };
      case "slack":
        return {
          config: {
            channel: sl.channel.trim(),
            ...(sl.username.trim() ? { username: sl.username.trim() } : {}),
          },
          secrets: { webhookUrl: sl.webhookUrl.trim() },
        };
      default:
        toast.error(`unknown kind '${kind}'`);
        return null;
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="kind">Kind</Label>
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as ToolConnectionKind)}
          >
            <SelectTrigger id="kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-pg-readonly"
            autoFocus
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description (optional)</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Read-only replica of the prod app DB"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="scope">Scope</Label>
          <Select
            value={scopeKind}
            onValueChange={(v) => setScopeKind(v as ScopeKind)}
          >
            <SelectTrigger id="scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">global</SelectItem>
              <SelectItem value="specialist">
                specialist:&lt;name&gt;
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {scopeKind === "specialist" ? (
          <div className="space-y-1.5">
            <Label htmlFor="specialist">Specialist name</Label>
            <Input
              id="specialist"
              value={specialistName}
              onChange={(e) => setSpecialistName(e.target.value)}
              placeholder="data-analyst"
            />
          </div>
        ) : null}
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-3">
        {kind === "postgres" ? (
          <PostgresSection state={pg} setState={setPg} />
        ) : null}
        {kind === "clickhouse" ? (
          <ClickhouseSection state={ch} setState={setCh} />
        ) : null}
        {kind === "redis" ? <RedisSection state={rd} setState={setRd} /> : null}
        {kind === "mcp" ? (
          <McpSection
            transport={mcpTransport}
            setTransport={setMcpTransport}
            http={mcpHttp}
            setHttp={setMcpHttp}
            stdio={mcpStdio}
            setStdio={setMcpStdio}
          />
        ) : null}
        {kind === "slack" ? <SlackSection state={sl} setState={setSl} /> : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function numberOrUndefined(v: string): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

type PostgresFields = {
  host: string;
  port: string;
  database: string;
  user: string;
  sslMode: "disable" | "require" | "verify-ca" | "verify-full";
  readOnly: boolean;
  password: string;
};

function PostgresSection({
  state,
  setState,
}: {
  state: PostgresFields;
  setState: (s: PostgresFields) => void;
}) {
  return (
    <div className="space-y-3">
      <FieldRow label="Host" id="pg-host">
        <Input
          id="pg-host"
          value={state.host}
          onChange={(e) => setState({ ...state, host: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Port" id="pg-port">
        <Input
          id="pg-port"
          value={state.port}
          onChange={(e) => setState({ ...state, port: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Database" id="pg-db">
        <Input
          id="pg-db"
          value={state.database}
          onChange={(e) => setState({ ...state, database: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="User" id="pg-user">
        <Input
          id="pg-user"
          value={state.user}
          onChange={(e) => setState({ ...state, user: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="SSL mode" id="pg-ssl">
        <Select
          value={state.sslMode}
          onValueChange={(v) =>
            setState({ ...state, sslMode: v as PostgresFields["sslMode"] })
          }
        >
          <SelectTrigger id="pg-ssl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disable">disable</SelectItem>
            <SelectItem value="require">require</SelectItem>
            <SelectItem value="verify-ca">verify-ca</SelectItem>
            <SelectItem value="verify-full">verify-full</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <ReadOnlyToggle
        value={state.readOnly}
        onChange={(b) => setState({ ...state, readOnly: b })}
      />
      <FieldRow label="Password" id="pg-pw">
        <Input
          id="pg-pw"
          type="password"
          value={state.password}
          onChange={(e) => setState({ ...state, password: e.target.value })}
        />
      </FieldRow>
    </div>
  );
}

type ClickhouseFields = {
  host: string;
  protocol: "http" | "https";
  port: string;
  database: string;
  user: string;
  readOnly: boolean;
  password: string;
};

function ClickhouseSection({
  state,
  setState,
}: {
  state: ClickhouseFields;
  setState: (s: ClickhouseFields) => void;
}) {
  return (
    <div className="space-y-3">
      <FieldRow label="Host" id="ch-host">
        <Input
          id="ch-host"
          value={state.host}
          onChange={(e) => setState({ ...state, host: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Protocol" id="ch-proto">
        <Select
          value={state.protocol}
          onValueChange={(v) =>
            setState({ ...state, protocol: v as "http" | "https" })
          }
        >
          <SelectTrigger id="ch-proto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="https">https</SelectItem>
            <SelectItem value="http">http</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="Port" id="ch-port">
        <Input
          id="ch-port"
          value={state.port}
          onChange={(e) => setState({ ...state, port: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Database" id="ch-db">
        <Input
          id="ch-db"
          value={state.database}
          onChange={(e) => setState({ ...state, database: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="User" id="ch-user">
        <Input
          id="ch-user"
          value={state.user}
          onChange={(e) => setState({ ...state, user: e.target.value })}
        />
      </FieldRow>
      <ReadOnlyToggle
        value={state.readOnly}
        onChange={(b) => setState({ ...state, readOnly: b })}
      />
      <FieldRow label="Password" id="ch-pw">
        <Input
          id="ch-pw"
          type="password"
          value={state.password}
          onChange={(e) => setState({ ...state, password: e.target.value })}
        />
      </FieldRow>
    </div>
  );
}

type RedisFields = {
  host: string;
  port: string;
  db: string;
  username: string;
  tls: boolean;
  readOnly: boolean;
  password: string;
};

function RedisSection({
  state,
  setState,
}: {
  state: RedisFields;
  setState: (s: RedisFields) => void;
}) {
  return (
    <div className="space-y-3">
      <FieldRow label="Host" id="rd-host">
        <Input
          id="rd-host"
          value={state.host}
          onChange={(e) => setState({ ...state, host: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Port" id="rd-port">
        <Input
          id="rd-port"
          value={state.port}
          onChange={(e) => setState({ ...state, port: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="DB number" id="rd-db">
        <Input
          id="rd-db"
          value={state.db}
          onChange={(e) => setState({ ...state, db: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Username (optional, ACL)" id="rd-user">
        <Input
          id="rd-user"
          value={state.username}
          onChange={(e) => setState({ ...state, username: e.target.value })}
        />
      </FieldRow>
      <ToggleRow
        label="TLS"
        value={state.tls}
        onChange={(b) => setState({ ...state, tls: b })}
      />
      <ReadOnlyToggle
        value={state.readOnly}
        onChange={(b) => setState({ ...state, readOnly: b })}
      />
      <FieldRow label="Password (optional)" id="rd-pw">
        <Input
          id="rd-pw"
          type="password"
          value={state.password}
          onChange={(e) => setState({ ...state, password: e.target.value })}
        />
      </FieldRow>
    </div>
  );
}

type McpHttpFields = { url: string; bearerToken: string };
type McpStdioFields = { command: string; args: string };

function McpSection({
  transport,
  setTransport,
  http,
  setHttp,
  stdio,
  setStdio,
}: {
  transport: "http" | "stdio";
  setTransport: (t: "http" | "stdio") => void;
  http: McpHttpFields;
  setHttp: (s: McpHttpFields) => void;
  stdio: McpStdioFields;
  setStdio: (s: McpStdioFields) => void;
}) {
  return (
    <div className="space-y-3">
      <FieldRow label="Transport" id="mcp-trans">
        <Select
          value={transport}
          onValueChange={(v) => setTransport(v as "http" | "stdio")}
        >
          <SelectTrigger id="mcp-trans">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="http">http</SelectItem>
            <SelectItem value="stdio">stdio</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      {transport === "http" ? (
        <>
          <FieldRow label="URL" id="mcp-url">
            <Input
              id="mcp-url"
              value={http.url}
              onChange={(e) => setHttp({ ...http, url: e.target.value })}
              placeholder="https://mcp.example.com/sse"
            />
          </FieldRow>
          <FieldRow label="Bearer token (optional)" id="mcp-bearer">
            <Input
              id="mcp-bearer"
              type="password"
              value={http.bearerToken}
              onChange={(e) =>
                setHttp({ ...http, bearerToken: e.target.value })
              }
            />
          </FieldRow>
        </>
      ) : (
        <>
          <FieldRow label="Command" id="mcp-cmd">
            <Input
              id="mcp-cmd"
              value={stdio.command}
              onChange={(e) => setStdio({ ...stdio, command: e.target.value })}
              placeholder="pulumi-mcp"
            />
          </FieldRow>
          <FieldRow label="Args (one per line)" id="mcp-args">
            <Textarea
              id="mcp-args"
              value={stdio.args}
              onChange={(e) => setStdio({ ...stdio, args: e.target.value })}
              rows={3}
            />
          </FieldRow>
        </>
      )}
    </div>
  );
}

type SlackFields = {
  channel: string;
  username: string;
  webhookUrl: string;
};

function SlackSection({
  state,
  setState,
}: {
  state: SlackFields;
  setState: (s: SlackFields) => void;
}) {
  return (
    <div className="space-y-3">
      <FieldRow label="Channel" id="sl-ch">
        <Input
          id="sl-ch"
          value={state.channel}
          onChange={(e) => setState({ ...state, channel: e.target.value })}
          placeholder="#ops"
        />
      </FieldRow>
      <FieldRow label="Bot username (optional)" id="sl-name">
        <Input
          id="sl-name"
          value={state.username}
          onChange={(e) => setState({ ...state, username: e.target.value })}
        />
      </FieldRow>
      <FieldRow label="Webhook URL" id="sl-hook">
        <Input
          id="sl-hook"
          type="password"
          value={state.webhookUrl}
          onChange={(e) => setState({ ...state, webhookUrl: e.target.value })}
          placeholder="https://hooks.slack.com/services/T/B/X"
        />
      </FieldRow>
    </div>
  );
}

function FieldRow({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
      <Label>{label}</Label>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function ReadOnlyToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
      <div>
        <Label>Read-only</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Specialist tools refuse writes when this is on. Combine with a
          read-only database role for tightest enforcement.
        </p>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}
