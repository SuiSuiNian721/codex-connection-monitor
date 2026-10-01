package main

import "time"

type watchAction string

const (
	watchNone             watchAction = ""
	watchLongOutage       watchAction = "long-outage"
	watchEvaluateRecovery watchAction = "evaluate-recovery"
)

type watchState struct {
	proxy         string
	outageStart   time.Time
	recoveryStart time.Time
	longOutage    bool
	proxyChanged  bool
	evaluated     bool
	retryAfter    time.Time
}

func newWatchState(proxy string) *watchState {
	return &watchState{proxy: proxy}
}

func (s *watchState) observe(now time.Time, healthy bool, proxy string) watchAction {
	if proxy != "" && proxy != s.proxy {
		s.proxy = proxy
		s.proxyChanged = true
		s.recoveryStart = time.Time{}
		s.evaluated = false
		s.retryAfter = time.Time{}
	}
	if !healthy {
		if s.outageStart.IsZero() {
			s.outageStart = now
		}
		s.recoveryStart = time.Time{}
		s.evaluated = false
		s.retryAfter = time.Time{}
		if !s.longOutage && now.Sub(s.outageStart) >= 180*time.Second {
			s.longOutage = true
			return watchLongOutage
		}
		return watchNone
	}
	if !s.longOutage && !s.proxyChanged {
		s.outageStart = time.Time{}
		return watchNone
	}
	if s.recoveryStart.IsZero() {
		s.recoveryStart = now
		return watchNone
	}
	if !s.evaluated && !now.Before(s.retryAfter) && now.Sub(s.recoveryStart) >= 15*time.Second {
		s.evaluated = true
		return watchEvaluateRecovery
	}
	return watchNone
}

// 保持恢复待确认状态，等待自然重连并保留后续提醒机会。
func (s *watchState) deferRecovery(now time.Time) {
	s.evaluated = false
	s.retryAfter = now.Add(30 * time.Second)
}

func (s *watchState) markRecovered(proxy string) {
	s.proxy = proxy
	s.outageStart = time.Time{}
	s.recoveryStart = time.Time{}
	s.longOutage = false
	s.proxyChanged = false
	s.evaluated = false
	s.retryAfter = time.Time{}
}

func notificationAllowed(last, now time.Time) bool {
	return last.IsZero() || now.Sub(last) >= 600*time.Second
}
