package custommcp

import (
	"net/netip"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/publicnet"
)

// NetworkPolicy controls which destinations a custom MCP client can contact.
type NetworkPolicy string

const (
	// NetworkPublic allows only public endpoints.
	NetworkPublic NetworkPolicy = "public"
	// NetworkLocal also allows loopback, private, and shared addresses.
	NetworkLocal NetworkPolicy = "local"
)

var (
	sharedIPv4 = netip.MustParsePrefix("100.64.0.0/10")
	globalIPv6 = netip.MustParsePrefix("2000::/3")
	// Keep the local policy's special-purpose exclusions separate from URL previews.
	localExcludedPrefixes = [...]netip.Prefix{
		netip.MustParsePrefix("192.88.99.0/24"),
		netip.MustParsePrefix("2001::/23"),
		netip.MustParsePrefix("3ffe::/16"),
		netip.MustParsePrefix("3fff::/20"),
	}
)

func (policy NetworkPolicy) allowsAddress(addr netip.Addr) bool {
	// A scope identifier must not bypass the prefix checks.
	addr = addr.WithZone("").Unmap()
	if policy != NetworkLocal {
		return publicnet.IsPublic(addr)
	}
	if addr.IsLoopback() || addr.IsPrivate() || sharedIPv4.Contains(addr) {
		return true
	}
	if !publicnet.IsPublic(addr) || (addr.Is6() && !globalIPv6.Contains(addr)) {
		return false
	}
	for _, prefix := range localExcludedPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func isLocalhost(host string) bool {
	return strings.EqualFold(strings.TrimSuffix(host, "."), "localhost")
}
