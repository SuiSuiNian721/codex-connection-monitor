package main

import "time"

func observeVPNHardFailure(since, now time.Time, kind string, localHealthy bool, proxyURI, previousProxy string) time.Time {
	if !localHealthy || proxyURI == "" || !vpnWatchHardFailure(kind) {
		return time.Time{}
	}
	if since.IsZero() || proxyURI != previousProxy || now.Before(since) {
		return now
	}
	return since
}

func vpnWatchHardFailure(kind string) bool {
	switch kind {
	case "Timeout", "TlsFailure", "ConnectionFailure", "NameResolutionFailure", "ResponseFailure":
		return true
	default:
		return false
	}
}

func shouldAssistVPN(now, lastAttempt, outageStart time.Time, longOutage bool, proxyURI, boundProxy, kind string, localHealthy bool) bool {
	if !longOutage || outageStart.IsZero() || now.Sub(outageStart) < 180*time.Second || !localHealthy || proxyURI == "" || proxyURI != boundProxy {
		return false
	}
	if !lastAttempt.IsZero() && now.Sub(lastAttempt) < 600*time.Second {
		return false
	}
	return vpnWatchHardFailure(kind)
}
