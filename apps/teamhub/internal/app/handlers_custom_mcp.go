package app

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const customMCPOAuthCallbackPath = "/v0/custom-mcp-connections/oauth/callback"

func (a *App) listCustomMCP(c *gin.Context) {
	session := currentPrincipal(c).Session
	items, err := a.externalSources.ListCustomMCP(c.Request.Context(), session.HumanTenantID, session.HumanActorID)
	if a.writeCustomMCPError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"connections": items})
}

func (a *App) saveCustomMCP(c *gin.Context) {
	var input httpapi.SaveCustomMcpConnectionJSONRequestBody
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 24<<10), &input, "invalid MCP connector") != nil ||
		(input.Id == nil) != (input.Revision == nil) ||
		input.Revision != nil && (*input.Revision < 1 || *input.Id == "") {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid custom connector configuration")
		return
	}
	session := currentPrincipal(c).Session
	config := externalsource.CustomMCPConnection{Name: input.Name, Endpoint: input.Endpoint}
	if input.Id != nil {
		config.ID, config.Revision = *input.Id, *input.Revision
	}
	item, err := a.externalSources.SaveCustomMCP(c.Request.Context(), session.AccountID, session.HumanTenantID, session.HumanActorID,
		config, input.Token)
	if a.writeCustomMCPError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, item)
}

func (a *App) testCustomMCP(c *gin.Context) {
	var input httpapi.TestCustomMcpConnectionJSONRequestBody
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 24<<10), &input, "invalid MCP test request") != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid custom connector test request")
		return
	}
	var token string
	if input.Token != nil {
		token = *input.Token
	}
	tools, err := a.externalSources.TestCustomMCP(c.Request.Context(), input.Endpoint, token)
	if a.writeCustomMCPError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"tools": tools})
}

func (a *App) deleteCustomMCP(c *gin.Context) {
	session := currentPrincipal(c).Session
	err := a.externalSources.DeleteCustomMCP(c.Request.Context(), session.HumanTenantID, session.HumanActorID, c.Param("connectionId"))
	if !a.writeCustomMCPError(c, err) {
		c.Status(http.StatusNoContent)
	}
}

func (a *App) startCustomMCPOAuth(c *gin.Context) {
	var input httpapi.StartCustomMcpOAuthJSONRequestBody
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 24<<10), &input, "invalid MCP OAuth request") != nil ||
		(input.Id == nil) != (input.Revision == nil) ||
		input.Revision != nil && (*input.Revision < 1 || *input.Id == "") {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid custom connector configuration")
		return
	}
	ctx, err := composio.WithDesktopOAuthCallback(c.Request.Context(), input.DesktopCallbackUrl)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid Desktop authorization callback")
		return
	}
	item := externalsource.CustomMCPConnection{Name: input.Name, Endpoint: input.Endpoint}
	if input.Id != nil {
		item.ID, item.Revision = *input.Id, *input.Revision
	}
	if input.Scope != nil {
		item.RequestedScope = *input.Scope
	}
	options := externalsource.CustomMCPOAuthInput{
		Connection: item, ClientSecret: input.ClientSecret,
		WebCallback: a.cfg.PublicWebURL + customMCPOAuthCallbackPath, DesktopCallback: composio.DesktopOAuthCallback(ctx),
	}
	if input.ClientId != nil {
		options.ClientID = *input.ClientId
	}
	if input.RedirectOnly != nil {
		options.RedirectOnly = *input.RedirectOnly
	}
	session := currentPrincipal(c).Session
	c.Header("Cache-Control", "no-store")
	result, err := a.externalSources.StartCustomMCPOAuth(ctx, session.AccountID, session.HumanTenantID, session.HumanActorID, options)
	if errors.Is(err, custommcp.ErrOAuthRegistrationRequired) {
		a.writeErrorWithDetails(c, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_REGISTRATION_REQUIRED",
			"Enter credentials for a registered OAuth client", []httpapi.ErrorDetail{{Field: "redirect_uri", Reason: result.RedirectURI}})
		return
	}
	if !a.writeCustomMCPError(c, err) {
		c.JSON(http.StatusOK, result)
	}
}

func (a *App) completeCustomMCPOAuth(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("Referrer-Policy", "no-referrer")
	var input custommcp.OAuthCallback
	desktop := c.Request.Method == http.MethodPost
	if desktop {
		if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10), &input, "invalid MCP OAuth response") != nil {
			a.writeCustomMCPError(c, custommcp.ErrOAuthResponse)
			return
		}
	} else {
		var err error
		input, err = parseCustomMCPOAuthQuery(c.Request.URL.RawQuery)
		if a.writeCustomMCPError(c, err) {
			return
		}
	}
	session := currentPrincipal(c).Session
	err := a.externalSources.CompleteCustomMCPOAuth(c.Request.Context(), session.AccountID, session.HumanTenantID, session.HumanActorID, input, desktop)
	if a.writeCustomMCPError(c, err) {
		return
	}
	if desktop {
		c.Status(http.StatusNoContent)
		return
	}
	c.Header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte("<!doctype html><html lang=en><meta charset=utf-8><title>Linger authorization</title><h1>Authorization complete</h1><p>You can close this tab and go back to Linger.</p></html>"))
}

func parseCustomMCPOAuthQuery(raw string) (custommcp.OAuthCallback, error) {
	if len(raw) > 32<<10 {
		return custommcp.OAuthCallback{}, custommcp.ErrOAuthResponse
	}
	query, err := url.ParseQuery(raw)
	if err != nil {
		return custommcp.OAuthCallback{}, custommcp.ErrOAuthResponse
	}
	for _, key := range []string{"state", "callback_id", "code", "iss", "error"} {
		if values := query[key]; len(values) > 1 || len(values) == 1 && values[0] == "" {
			return custommcp.OAuthCallback{}, custommcp.ErrOAuthResponse
		}
	}
	return custommcp.OAuthCallback{
		State: query.Get("state"), CallbackID: query.Get("callback_id"), Code: query.Get("code"),
		Issuer: query.Get("iss"), Error: query.Get("error"),
	}, nil
}

func (a *App) writeCustomMCPError(c *gin.Context, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, externalsource.ErrCustomMCPOAuthState):
		a.writeError(c, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_STATE_INVALID", "The authorization attempt is invalid or has expired")
	case errors.Is(err, custommcp.ErrOAuthMetadata):
		a.writeError(c, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_METADATA_INVALID", "The MCP server did not provide a supported OAuth configuration")
	case errors.Is(err, custommcp.ErrOAuthBindingChanged):
		a.writeError(c, http.StatusConflict, "CUSTOM_MCP_OAUTH_BINDING_CHANGED", "The authorization server changed. Refresh the connector and authorize again.")
	case errors.Is(err, custommcp.ErrOAuthResponse), errors.Is(err, custommcp.ErrOAuthClientRejected):
		a.writeError(c, http.StatusBadRequest, "CUSTOM_MCP_OAUTH_RESPONSE_INVALID", "The authorization server did not complete authorization")
	case errors.Is(err, externalsource.ErrCustomMCPReauthorization):
		a.writeError(c, http.StatusConflict, "CUSTOM_MCP_REAUTHORIZATION_REQUIRED", "Authorize the MCP connector again")
	case errors.Is(err, custommcp.ErrOAuthRequired):
		a.writeError(c, http.StatusConflict, "CUSTOM_MCP_OAUTH_REQUIRED", "The MCP server requires OAuth authorization")
	case errors.Is(err, custommcp.ErrInvalid), errors.Is(err, externalsource.ErrInvalid):
		message := "Enter a public MCP URL and use HTTPS for a bearer token"
		if a.cfg.ExternalApps.CustomMCPNetwork == custommcp.NetworkLocal {
			message = "Enter an allowed MCP URL. Use HTTPS for a bearer token unless the server is on loopback."
		}
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", message)
	case errors.Is(err, custommcp.ErrUnauthorized):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "The MCP server rejected authentication")
	case errors.Is(err, custommcp.ErrUnavailable):
		a.writeError(c, http.StatusBadGateway, "EXTERNAL_SOURCE_UNAVAILABLE", "The MCP server could not complete the connection test")
	case errors.Is(err, externalsource.ErrManagedKeyStorageMissing):
		a.writeError(c, http.StatusServiceUnavailable, "EXTERNAL_SOURCE_UNAVAILABLE", "This deployment cannot save MCP tokens")
	default:
		return a.writeExternalSourceError(c, "manage custom MCP connector", err)
	}
	return true
}
