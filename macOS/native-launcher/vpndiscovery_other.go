//go:build !windows && !darwin

package main

import (
	"context"
	"net"
)

func collectVPNProcesses(context.Context, int) (vpnProcessSnapshot, error) {
	return vpnProcessSnapshot{}, errVPNUnsupported
}

func vpnLocalDialer(vpnEndpoint) (func(context.Context) (net.Conn, error), error) {
	return nil, errVPNUnsupported
}
