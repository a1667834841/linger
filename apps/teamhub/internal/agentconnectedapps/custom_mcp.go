package agentconnectedapps

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// The revision is part of the slug so edited endpoints and credentials cannot
// inherit an approval granted for the old destination.
const customMCPToolVersion = "20251125_01"

type customMCPAuthority interface {
	CustomMCPTools(context.Context, externalsource.AgentToolConnection) ([]custommcp.Tool, error)
	InvokeCustomMCP(context.Context, externalsource.AgentToolConnection, string, map[string]any) (json.RawMessage, error)
}

func customMCPToolSlug(connection externalsource.AgentToolConnection, name string) string {
	hash := sha256.Sum256(fmt.Appendf(nil, "%s:%d:%d:%s", connection.ID, connection.Revision, connection.GrantRevision, name))
	return strings.ToUpper(fmt.Sprintf("MCP_%x", hash))
}

func (s *Service) customMCPTools(ctx context.Context, connection externalsource.AgentToolConnection) ([]custommcp.Tool, error) {
	authority, ok := s.connections.(customMCPAuthority)
	if !ok {
		return nil, unavailableError(nil)
	}
	return authority.CustomMCPTools(ctx, connection)
}

func (s *Service) findCustomMCPTool(ctx context.Context, connection externalsource.AgentToolConnection, action confirmationAction) (custommcp.Tool, error) {
	tools, err := s.customMCPTools(ctx, connection)
	if err != nil {
		return custommcp.Tool{}, err
	}
	for _, tool := range tools {
		if action.ToolVersion == customMCPToolVersion && customMCPToolSlug(connection, tool.Name) == action.ToolSlug {
			return tool, nil
		}
	}
	return custommcp.Tool{}, errToolNotFound
}

func (s *Service) searchCustomMCPTools(ctx context.Context, connection externalsource.AgentToolConnection, query string, limit int) ([]AppTool, error) {
	tools, err := s.customMCPTools(ctx, connection)
	if err != nil {
		return nil, err
	}
	result := make([]AppTool, 0, min(limit, len(tools)))
	query = strings.ToLower(query)
	for _, tool := range tools {
		if query != "*" && !strings.Contains(strings.ToLower(connection.DisplayName+" "+tool.Name+" "+tool.Description), query) {
			continue
		}
		var schema map[string]any
		if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
			return nil, err
		}
		result = append(result, AppTool{
			ToolSlug: customMCPToolSlug(connection, tool.Name), ToolVersion: customMCPToolVersion,
			Name: tool.Name, Description: tool.Description, AppKey: connection.AppKey,
			InputSchema: schema, AvailableConnections: []ConnectedApp{publicConnection(connection)},
		})
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (s *Service) prepareCustomMCP(ctx context.Context, connection externalsource.AgentToolConnection, action confirmationAction) (Result, error) {
	tool, err := s.findCustomMCPTool(ctx, connection, action)
	if err != nil {
		return Result{}, mapToolError(err, "execute")
	}
	result, err := s.prepareConfirmation(ctx, connection, action)
	if err == nil {
		result.Confirmation.Card.Title = "Run " + tool.Name
		result.Confirmation.Card.Tool = tool.Name
	}
	return result, err
}

func (s *Service) invokeConfirmedCustomMCP(ctx context.Context, connection externalsource.AgentToolConnection, action confirmationAction) (string, string, any) {
	tool, err := s.findCustomMCPTool(ctx, connection, action)
	if err != nil {
		return "failed", "The custom connector or tool changed before confirmation.", nil
	}
	authority := s.connections.(customMCPAuthority)
	result, err := authority.InvokeCustomMCP(ctx, connection, tool.Name, action.Arguments)
	if errors.Is(err, externalsource.ErrNotActive) {
		return "failed", "The custom connector is no longer active.", nil
	}
	var response struct {
		IsError bool `json:"isError"`
	}
	if err != nil || json.Unmarshal(result, &response) != nil || response.IsError {
		return "unknown", "The custom MCP server did not confirm success. Check the server before retrying.", nil
	}
	return "succeeded", "", result
}
