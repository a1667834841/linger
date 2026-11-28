import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type {
  CustomMCPConnection,
  CustomMCPOAuthAttempt,
  CustomMCPTool,
} from "@/features/teamhub/teamhub-external-source-client";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { connectorMessages as m } from "./connectors.messages";
import { customMCPQueryKey, customMCPQueryOptions } from "./custom-mcp-queries";
import { openCustomMCPOAuthUrl } from "./oauth-popup";

export function CustomMCPSection({
  connections,
  onEdit,
}: {
  connections: CustomMCPConnection[];
  onEdit: (connection: CustomMCPConnection) => void;
}) {
  const t = useT();
  if (connections.length === 0) return null;
  return (
    <section className="mt-7" aria-label={t(m.customGroup)}>
      <h2 className="mb-2.5 text-sm font-medium text-muted-foreground">
        {t(m.customGroup)}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connections.map((connection) => (
          <div
            key={connection.id}
            className="flex items-center gap-3 rounded-xl border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{connection.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {connection.endpoint}
              </p>
              {connection.authorization_status ===
              "reauthorization_required" ? (
                <p className="text-xs text-app-danger">
                  {t(m.customConnectorOAuthExpired)}
                </p>
              ) : connection.authorization_status ===
                "additional_scope_required" ? (
                <p className="text-xs text-app-danger">
                  {t(m.customConnectorOAuthMoreAccess)}
                </p>
              ) : null}
            </div>
            <Button size="compact" onClick={() => onEdit(connection)}>
              {t(
                connection.authorization_status ===
                  "reauthorization_required" ||
                  connection.authorization_status ===
                    "additional_scope_required"
                  ? m.customConnectorReauthorize
                  : m.manage,
              )}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

const inputClass = "w-full rounded-md border bg-background px-3 py-2";

export function CustomMCPDialog({
  connection,
  onClose,
}: {
  connection: CustomMCPConnection | null;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(connection?.name ?? "");
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [token, setToken] = useState("");
  const [keepToken, setKeepToken] = useState(connection?.has_token ?? false);
  const [oauth, setOAuth] = useState(connection?.auth_method === "oauth");
  const [oauthForm, setOAuthForm] = useState<OAuthFormValues>({
    manual: connection?.oauth_registration === "manual",
    clientID: connection?.oauth_client_id ?? "",
    scope: connection?.required_scope ?? connection?.requested_scope ?? "",
    redirectURI: "",
  });
  const [attempt, setAttempt] = useState<CustomMCPOAuthAttempt>();
  const [blocked, setBlocked] = useState(false);
  const [tools, setTools] = useState<CustomMCPTool[] | undefined>(
    connection?.tools,
  );
  const [disconnect, setDisconnect] = useState(false);
  const retainToken =
    connection?.auth_method !== "oauth" &&
    keepToken &&
    endpoint.trim() === connection?.endpoint;
  const test = useMutation({
    mutationFn: () => client.testCustomMCP(endpoint.trim(), token),
    onSuccess: (result) => setTools(result.tools),
    onError: offerOAuth,
  });
  const save = useMutation({
    mutationFn: () =>
      client.saveCustomMCP({
        id: connection?.id,
        revision: connection?.revision,
        name: name.trim(),
        endpoint: endpoint.trim(),
        token: retainToken ? undefined : token,
      }),
    onSuccess: finish,
    onError: offerOAuth,
  });
  const authorize = useMutation({
    mutationFn: (redirectOnly: boolean) =>
      client.startCustomMCPOAuth({
        id: connection?.id,
        revision: connection?.revision,
        name: name.trim(),
        endpoint: endpoint.trim(),
        scope: oauthForm.scope.trim() || undefined,
        client_id: oauthForm.manual ? oauthForm.clientID.trim() : undefined,
        client_secret: oauthForm.manual ? oauthForm.clientSecret : undefined,
        redirect_only: redirectOnly || undefined,
      }),
    onSuccess: (result) => {
      updateOAuthForm({ redirectURI: result.redirect_uri });
      if (!result.authorization_url) return;
      setAttempt(result);
      setBlocked(!openCustomMCPOAuthUrl(result.authorization_url));
    },
    onError: (error) => {
      if (!(error instanceof TeamHubError)) return;
      if (error.code === "CUSTOM_MCP_OAUTH_REGISTRATION_REQUIRED") {
        updateOAuthForm({
          manual: true,
          redirectURI:
            error.details?.find(({ field }) => field === "redirect_uri")
              ?.reason ?? "",
        });
      }
      if (error.code === "CUSTOM_MCP_OAUTH_BINDING_CHANGED") void finish();
    },
  });
  function isComplete(connections?: CustomMCPConnection[]) {
    return connections?.some(
      (item) =>
        item.id === attempt?.connection_id &&
        item.auth_method === "oauth" &&
        item.revision > (connection?.revision ?? 0),
    );
  }

  const progress = useQuery({
    ...customMCPQueryOptions(client),
    enabled: Boolean(attempt?.connection_id),
    refetchInterval: ({ state }) =>
      attempt?.expires_at &&
      Date.parse(attempt.expires_at) > Date.now() &&
      !isComplete(state.data?.connections)
        ? 2_000
        : false,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteCustomMCP(id),
    onSuccess: finish,
  });
  const pending =
    test.isPending || save.isPending || remove.isPending || authorize.isPending;
  const error = oauth
    ? (authorize.error ?? remove.error)
    : (test.error ?? save.error ?? remove.error);

  async function finish() {
    await queryClient.invalidateQueries({ queryKey: customMCPQueryKey });
    onClose();
  }

  function updateOAuthForm(changes: Partial<OAuthFormValues>) {
    setOAuthForm((current) => ({ ...current, ...changes }));
  }

  function resetPreview() {
    setTools(undefined);
    test.reset();
    save.reset();
    authorize.reset();
    updateOAuthForm({ redirectURI: "" });
    setAttempt(undefined);
    setBlocked(false);
  }

  function offerOAuth(error: Error) {
    if (
      error instanceof TeamHubError &&
      error.code === "CUSTOM_MCP_OAUTH_REQUIRED"
    ) {
      setOAuth(true);
    }
  }

  if (isComplete(progress.data?.connections)) {
    return (
      <ModalDialog
        size="md"
        title={t(m.authorizationComplete)}
        onClose={onClose}
        footer={
          <Button tone="primary" onClick={onClose}>
            {t(commonMessages.done)}
          </Button>
        }
      >
        {null}
      </ModalDialog>
    );
  }

  return (
    <ModalDialog
      size="md"
      title={t(connection ? m.editCustomConnector : m.addCustomConnector)}
      onClose={onClose}
      footer={
        <>
          {connection ? (
            <Button
              disabled={pending}
              onClick={() =>
                disconnect ? remove.mutate(connection.id) : setDisconnect(true)
              }
            >
              {t(disconnect ? m.customConnectorDisconnect : m.disconnect)}
            </Button>
          ) : null}
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button
            tone="primary"
            disabled={
              pending ||
              !name.trim() ||
              !endpoint.trim() ||
              disconnect ||
              (oauth && oauthForm.manual && !oauthForm.clientID.trim())
            }
            onClick={() => (oauth ? authorize.mutate(false) : save.mutate())}
          >
            {t(
              oauth
                ? connection?.auth_method === "oauth"
                  ? m.customConnectorReauthorize
                  : m.customConnectorAuthorize
                : commonMessages.save,
            )}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-3" disabled={pending || disconnect}>
        <label className="block space-y-1 text-sm">
          <span>{t(m.customConnectorName)}</span>
          <input
            className={inputClass}
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t(m.customConnectorEndpoint)}</span>
          <input
            className={inputClass}
            type="url"
            maxLength={2048}
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              updateOAuthForm({ clientSecret: undefined });
              resetPreview();
            }}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t(m.customConnectorAuthentication)}</span>
          <select
            className={inputClass}
            value={oauth ? "oauth" : "bearer"}
            onChange={(e) => {
              setOAuth(e.target.value === "oauth");
              resetPreview();
            }}
          >
            <option value="bearer">
              {t(m.customConnectorBearerOrAnonymous)}
            </option>
            <option value="oauth">{t(m.customConnectorOAuth)}</option>
          </select>
        </label>
        {oauth ? (
          <CustomMCPOAuthFields
            connection={connection}
            values={oauthForm}
            onChange={updateOAuthForm}
            canShowRedirect={Boolean(endpoint.trim())}
            onShowRedirect={() => authorize.mutate(true)}
          />
        ) : null}
        {!oauth &&
        connection?.auth_method !== "oauth" &&
        connection?.has_token &&
        endpoint.trim() === connection.endpoint ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepToken}
              onChange={(e) => {
                setKeepToken(e.target.checked);
                resetPreview();
              }}
            />
            {t(m.customConnectorKeepToken)}
          </label>
        ) : null}
        {!oauth && !retainToken ? (
          <label className="block space-y-1 text-sm">
            <span>{t(m.customConnectorToken)}</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              maxLength={8192}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                resetPreview();
              }}
            />
          </label>
        ) : null}
        {oauth ? null : retainToken ? (
          <p className="text-sm text-muted-foreground">
            {t(m.customConnectorTestedOnSave)}
          </p>
        ) : (
          <Button disabled={!endpoint.trim()} onClick={() => test.mutate()}>
            {t(m.customConnectorTest)}
          </Button>
        )}
      </fieldset>
      {attempt?.authorization_url ? (
        <CustomMCPOAuthProgress
          blocked={blocked}
          onRetry={() =>
            setBlocked(!openCustomMCPOAuthUrl(attempt.authorization_url ?? ""))
          }
        />
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-app-danger">
          {error.message}
        </p>
      ) : null}
      {tools ? <CustomMCPToolPreview tools={tools} /> : null}
    </ModalDialog>
  );
}

function CustomMCPOAuthProgress({
  blocked,
  onRetry,
}: {
  blocked: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-3 space-y-2 text-sm" role="status">
      <p>{t(blocked ? m.popupBlocked : m.customConnectorOAuthWaiting)}</p>
      {blocked ? (
        <Button onClick={onRetry}>{t(m.openAuthorizationWindow)}</Button>
      ) : null}
    </div>
  );
}

function CustomMCPToolPreview({ tools }: { tools: CustomMCPTool[] }) {
  const t = useT();
  return (
    <section className="mt-3 text-sm" aria-label={t(m.customConnectorToolList)}>
      <p className="font-medium">{t(m.customConnectorToolList)}</p>
      {tools.length ? (
        <ul className="max-h-40 overflow-y-auto">
          {tools.map((tool) => (
            <li key={tool.name}>{tool.name}</li>
          ))}
        </ul>
      ) : (
        <p>{t(m.customConnectorNoTools)}</p>
      )}
    </section>
  );
}

interface OAuthFormValues {
  manual: boolean;
  clientID: string;
  clientSecret?: string;
  scope: string;
  redirectURI: string;
}

function CustomMCPOAuthFields({
  connection,
  values,
  onChange,
  canShowRedirect,
  onShowRedirect,
}: {
  connection: CustomMCPConnection | null;
  values: OAuthFormValues;
  onChange: (changes: Partial<OAuthFormValues>) => void;
  canShowRedirect: boolean;
  onShowRedirect: () => void;
}) {
  const t = useT();
  return (
    <>
      <label className="block space-y-1 text-sm">
        <span>{t(m.customConnectorScope)}</span>
        <input
          className={inputClass}
          value={values.scope}
          maxLength={4096}
          onChange={(e) => onChange({ scope: e.target.value })}
        />
      </label>
      {connection?.authorization_status === "additional_scope_required" ? (
        <p role="status" className="text-sm text-app-danger">
          {t(m.customConnectorOAuthMoreAccess)} {connection.required_scope}
        </p>
      ) : connection?.authorization_status === "reauthorization_required" ? (
        <p role="status" className="text-sm text-app-danger">
          {t(m.customConnectorOAuthExpired)}
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.manual}
          onChange={(e) => onChange({ manual: e.target.checked })}
        />
        {t(m.customConnectorManualClient)}
      </label>
      {values.manual ? (
        <>
          <label className="block space-y-1 text-sm">
            <span>{t(m.customConnectorClientID)}</span>
            <input
              className={inputClass}
              value={values.clientID}
              maxLength={8192}
              onChange={(e) =>
                onChange({ clientID: e.target.value, clientSecret: undefined })
              }
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t(m.customConnectorClientSecret)}</span>
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={values.clientSecret ?? ""}
              maxLength={8192}
              onChange={(e) => onChange({ clientSecret: e.target.value })}
            />
          </label>
          {values.redirectURI ? (
            <label className="block space-y-1 text-sm">
              <span>{t(m.customConnectorRedirectURI)}</span>
              <input
                className={inputClass}
                value={values.redirectURI}
                readOnly
                onFocus={(e) => e.target.select()}
              />
            </label>
          ) : (
            <Button disabled={!canShowRedirect} onClick={onShowRedirect}>
              {t(m.customConnectorShowRedirectURI)}
            </Button>
          )}
        </>
      ) : null}
    </>
  );
}
