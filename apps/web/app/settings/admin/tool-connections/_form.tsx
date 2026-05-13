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
import {
  adminCreateToolConnection,
  adminUpdateToolConnection,
  type ToolConnectionEditItem,
} from "@/lib/admin/tool-connections-actions";
// Same reason as page.tsx: import the type directly from `types.ts`
// rather than the barrel that drags in `postgres`.
import type { ToolConnectionKind } from "@/lib/tool-connections/types";

// The form keeps the per-kind field surface inline so the data flow
// is one file deep — admins editing a single field shouldn't have to
// trace through three component layers. Each kind's section
// reads/writes a small typed state slice that maps directly onto the
// validated `config` and `secrets` payloads the server action wants.
//
// Edit mode (when `editing` is supplied): kind + name are locked
// (changing kind would invalidate the config + secrets shape; name
// is the identity used by every resolver call site). Secret fields
// stay blank — existing ciphertext can't be decrypted client-side
// to prefill, and the contract is "leave blank to keep, fill to
// replace".

type ScopeKind = "global" | "specialist";

type Props = {
  kinds: readonly ToolConnectionKind[];
  onSubmitted: () => void | Promise<void>;
  editing?: ToolConnectionEditItem | null;
};

export function ToolConnectionForm({ kinds, onSubmitted, editing }: Props) {
  const isEdit = editing != null;
  const initialScope = parseScopeString(editing?.scope ?? "global");
  const [kind, setKind] = useState<ToolConnectionKind>(
    editing?.kind ?? "postgres",
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [scopeKind, setScopeKind] = useState<ScopeKind>(initialScope.kind);
  const [specialistName, setSpecialistName] = useState(
    initialScope.kind === "specialist" ? initialScope.specialistName : "",
  );
  const [submitting, setSubmitting] = useState(false);

  // Per-kind form state. Kept flat so the form re-renders cheaply
  // and a kind switch doesn't blow away every typed field. In edit
  // mode each kind initializes from the row's existing `configJson`
  // (when it matches the row's kind) and leaves secret fields blank.
  const initialConfig = isEdit ? editing.configJson : undefined;
  const initialKind = editing?.kind;
  const [pg, setPg] = useState<PostgresFields>(
    initialKind === "postgres"
      ? readPostgresConfig(initialConfig)
      : {
          host: "",
          port: "5432",
          database: "",
          user: "",
          sslMode: "require",
          readOnly: true,
          password: "",
        },
  );
  const [ch, setCh] = useState<ClickhouseFields>(
    initialKind === "clickhouse"
      ? readClickhouseConfig(initialConfig)
      : {
          host: "",
          protocol: "https",
          port: "8443",
          database: "",
          user: "",
          readOnly: true,
          password: "",
        },
  );
  const [rd, setRd] = useState<RedisFields>(
    initialKind === "redis"
      ? readRedisConfig(initialConfig)
      : {
          host: "",
          port: "6379",
          db: "0",
          username: "",
          tls: true,
          readOnly: true,
          password: "",
        },
  );
  const initialMcp =
    initialKind === "mcp" ? readMcpConfig(initialConfig) : null;
  const [mcpHttp, setMcpHttp] = useState<McpHttpFields>(
    initialMcp?.transport === "http"
      ? { url: initialMcp.url, bearerToken: "" }
      : { url: "", bearerToken: "" },
  );
  const [mcpStdio, setMcpStdio] = useState<McpStdioFields>(
    initialMcp?.transport === "stdio"
      ? { command: initialMcp.command, args: initialMcp.args.join("\n") }
      : { command: "", args: "" },
  );
  const [mcpTransport, setMcpTransport] = useState<"http" | "stdio">(
    initialMcp?.transport ?? "http",
  );
  const [sl, setSl] = useState<SlackFields>(
    initialKind === "slack"
      ? readSlackConfig(initialConfig)
      : { channel: "", username: "", webhookUrl: "" },
  );

  // Snapshot the config payload that `buildPayload` would emit at
  // mount time. On submit, compare the freshly built config to this
  // snapshot — if they're byte-identical, skip `config` in the
  // patch. Two motivations:
  //
  // 1. Honor the patch contract advertised by `adminUpdateToolConnection`
  //    ("omit `config` to leave the configJson untouched"). Sending
  //    `config` unconditionally would invoke server-side validation
  //    + an extra DB write on every save.
  // 2. Future-proof: if a new optional `configJson` field ships on
  //    the server schema without a corresponding form reader, the
  //    form's rebuilt config would drop that field and silently
  //    overwrite it on every edit. Comparing to the mount-time
  //    snapshot guarantees we only mutate `configJson` when the
  //    admin actually changed something on the form.
  //
  // The snapshot is computed once via useState's lazy initializer
  // and never re-derived — the form is remounted via `key` from the
  // page when a different row is targeted, so the snapshot stays
  // bound to its row. `buildPayload` is a hoisted function
  // declaration below, safe to reference here.
  const [initialConfigSnapshot] = useState(() => {
    const built = buildPayload();
    return built ? JSON.stringify(built.config) : null;
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
      const scope =
        scopeKind === "global"
          ? ({ kind: "global" } as const)
          : {
              kind: "specialist" as const,
              specialistName: specialistName.trim(),
            };
      if (isEdit && editing) {
        // Edit semantics:
        //   - `secrets`: send only when the user filled a secret
        //     field. An empty payload would otherwise re-encrypt-
        //     and-write an empty object and break resolution.
        //   - `config`: send only when the built config differs
        //     from the mount-time snapshot. Honors the patch
        //     contract and avoids dropping any server-schema field
        //     the form's readers don't know about.
        const configChanged =
          JSON.stringify(built.config) !== initialConfigSnapshot;
        const res = await adminUpdateToolConnection({
          id: editing.id,
          description: description.trim() || null,
          ...(configChanged ? { config: built.config } : {}),
          ...(built.secretsProvided ? { secrets: built.secrets } : {}),
          scope,
        });
        if (res.success) {
          toast.success(`Updated connection '${editing.name}'`);
          await onSubmitted();
        } else {
          toast.error(res.error);
        }
        return;
      }
      const res = await adminCreateToolConnection({
        name: name.trim(),
        kind,
        description: description.trim() || null,
        config: built.config,
        secrets: built.secrets,
        scope,
      });
      if (res.success) {
        toast.success(`Created connection '${name.trim()}'`);
        await onSubmitted();
      } else {
        toast.error(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // `secretsProvided` lets the edit path tell "user filled a secret"
  // apart from "form has the same blank state as create on a kind
  // with all-optional secrets" (mcp stdio, redis, slack-with-only-
  // url-blank). In edit mode the empty-secret-payload should NOT
  // overwrite the existing ciphertext.
  function buildPayload(): {
    config: unknown;
    secrets: unknown;
    secretsProvided: boolean;
  } | null {
    if (!isEdit && !name.trim()) {
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
          secretsProvided: pg.password.length > 0,
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
          secretsProvided: ch.password.length > 0,
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
          secretsProvided: rd.password.length > 0,
        };
      case "mcp":
        if (mcpTransport === "http") {
          return {
            config: { transport: "http", url: mcpHttp.url.trim() },
            secrets: mcpHttp.bearerToken
              ? { bearerToken: mcpHttp.bearerToken }
              : {},
            secretsProvided: mcpHttp.bearerToken.length > 0,
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
          // mcp stdio carries no secrets by default.
          secretsProvided: false,
        };
      case "slack":
        return {
          config: {
            channel: sl.channel.trim(),
            ...(sl.username.trim() ? { username: sl.username.trim() } : {}),
          },
          secrets: { webhookUrl: sl.webhookUrl.trim() },
          secretsProvided: sl.webhookUrl.length > 0,
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
            disabled={isEdit}
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
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              Kind is immutable; to change it, delete and recreate.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod-pg-readonly"
            autoFocus={!isEdit}
            disabled={isEdit}
          />
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              Name is the identity referenced by every resolver call; not
              editable.
            </p>
          ) : null}
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

      {isEdit ? (
        <p className="text-xs text-muted-foreground">
          Leave any secret field blank to keep the existing encrypted value.
          Filling a secret field rotates that secret to the new value.
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitting
            ? isEdit
              ? "Saving…"
              : "Creating…"
            : isEdit
              ? "Save changes"
              : "Create"}
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

// Scope round-trip. Server format is `global` or `specialist:<name>`;
// the form keeps the two halves split for UX.
function parseScopeString(
  raw: string,
): { kind: "global" } | { kind: "specialist"; specialistName: string } {
  if (raw === "global") return { kind: "global" };
  if (raw.startsWith("specialist:")) {
    return {
      kind: "specialist",
      specialistName: raw.slice("specialist:".length),
    };
  }
  return { kind: "global" };
}

// Per-kind config readers. Each one defensively coerces an
// unknown-typed `configJson` from the server into the form's field
// shape. Missing fields fall back to sensible defaults; an entirely
// wrong-shape payload still produces a working (empty) form so the
// admin can fix the row.
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNumString(v: unknown, fallback: string): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v;
  return fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function readPostgresConfig(raw: unknown): PostgresFields {
  const o = asObject(raw);
  const sslRaw = asString(o.sslMode, "require");
  const sslMode: PostgresFields["sslMode"] =
    sslRaw === "disable" ||
    sslRaw === "require" ||
    sslRaw === "verify-ca" ||
    sslRaw === "verify-full"
      ? sslRaw
      : "require";
  return {
    host: asString(o.host),
    port: asNumString(o.port, "5432"),
    database: asString(o.database),
    user: asString(o.user),
    sslMode,
    readOnly: asBool(o.readOnly, true),
    password: "",
  };
}

function readClickhouseConfig(raw: unknown): ClickhouseFields {
  const o = asObject(raw);
  const protoRaw = asString(o.protocol, "https");
  const protocol: ClickhouseFields["protocol"] =
    protoRaw === "http" || protoRaw === "https" ? protoRaw : "https";
  return {
    host: asString(o.host),
    protocol,
    port: asNumString(o.port, protocol === "https" ? "8443" : "8123"),
    database: asString(o.database),
    user: asString(o.user),
    readOnly: asBool(o.readOnly, true),
    password: "",
  };
}

function readRedisConfig(raw: unknown): RedisFields {
  const o = asObject(raw);
  return {
    host: asString(o.host),
    port: asNumString(o.port, "6379"),
    db: asNumString(o.db, "0"),
    username: asString(o.username),
    tls: asBool(o.tls, true),
    readOnly: asBool(o.readOnly, true),
    password: "",
  };
}

function readMcpConfig(
  raw: unknown,
):
  | { transport: "http"; url: string }
  | { transport: "stdio"; command: string; args: string[] }
  | null {
  const o = asObject(raw);
  if (o.transport === "http") {
    return { transport: "http", url: asString(o.url) };
  }
  if (o.transport === "stdio") {
    const argsRaw = Array.isArray(o.args) ? o.args : [];
    return {
      transport: "stdio",
      command: asString(o.command),
      args: argsRaw.filter((x): x is string => typeof x === "string"),
    };
  }
  return null;
}

function readSlackConfig(raw: unknown): SlackFields {
  const o = asObject(raw);
  return {
    channel: asString(o.channel),
    username: asString(o.username),
    webhookUrl: "",
  };
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
