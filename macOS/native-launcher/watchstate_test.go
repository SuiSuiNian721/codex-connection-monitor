package main

import (
	"testing"
	"time"
)

func TestRecoveryNeedsLongOutageAndStableReturn(t *testing.T) {
	start := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	state := newWatchState(proxy)

	if got := state.observe(start, false, proxy); got != watchNone {
		t.Fatalf("first failure: got %q", got)
	}
	if got := state.observe(start.Add(179*time.Second), false, proxy); got != watchNone {
		t.Fatalf("short outage: got %q", got)
	}
	if got := state.observe(start.Add(180*time.Second), false, proxy); got != watchLongOutage {
		t.Fatalf("long outage: got %q", got)
	}
	if got := state.observe(start.Add(181*time.Second), true, proxy); got != watchNone {
		t.Fatalf("first recovery probe: got %q", got)
	}
	if got := state.observe(start.Add(195*time.Second), true, proxy); got != watchNone {
		t.Fatalf("unstable recovery: got %q", got)
	}
	if got := state.observe(start.Add(196*time.Second), true, proxy); got != watchEvaluateRecovery {
		t.Fatalf("stable recovery: got %q", got)
	}
}

func TestShortOutageDoesNotTriggerRecoveryReminder(t *testing.T) {
	start := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	state := newWatchState(proxy)
	state.observe(start, false, proxy)
	state.observe(start.Add(30*time.Second), true, proxy)
	if got := state.observe(start.Add(60*time.Second), true, proxy); got != watchNone {
		t.Fatalf("short outage recovered: got %q", got)
	}
}

func TestProxyChangeWaitsForStability(t *testing.T) {
	start := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	oldProxy := "http://127.0.0.1:7890"
	newProxy := "http://127.0.0.1:7891"
	state := newWatchState(oldProxy)
	if got := state.observe(start, true, newProxy); got != watchNone {
		t.Fatalf("proxy changed: got %q", got)
	}
	if got := state.observe(start.Add(15*time.Second), true, newProxy); got != watchEvaluateRecovery {
		t.Fatalf("stable new proxy: got %q", got)
	}
	state.markRecovered(newProxy)
	if got := state.observe(start.Add(18*time.Second), true, newProxy); got != watchNone {
		t.Fatalf("already recovered: got %q", got)
	}
}

func TestRecoveryResetsAfterSecondFailure(t *testing.T) {
	start := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	state := newWatchState(proxy)
	state.observe(start, false, proxy)
	state.observe(start.Add(180*time.Second), false, proxy)
	state.observe(start.Add(181*time.Second), true, proxy)
	state.observe(start.Add(190*time.Second), false, proxy)
	if got := state.observe(start.Add(196*time.Second), true, proxy); got != watchNone {
		t.Fatalf("recovery must restart countdown: got %q", got)
	}
	if got := state.observe(start.Add(211*time.Second), true, proxy); got != watchEvaluateRecovery {
		t.Fatalf("second stable recovery: got %q", got)
	}
}

func TestNotificationCooldown(t *testing.T) {
	start := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	if !notificationAllowed(time.Time{}, start) {
		t.Fatal("first prompt must be allowed")
	}
	if notificationAllowed(start, start.Add(599*time.Second)) {
		t.Fatal("prompt inside cooldown")
	}
	if !notificationAllowed(start, start.Add(600*time.Second)) {
		t.Fatal("prompt after cooldown")
	}
}

func TestFailureAfterEvaluatingRecoveryCanRecoverAgain(t *testing.T) {
	start := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	state := newWatchState(proxy)
	state.observe(start, false, proxy)
	state.observe(start.Add(180*time.Second), false, proxy)
	state.observe(start.Add(181*time.Second), true, proxy)
	state.observe(start.Add(196*time.Second), true, proxy)
	state.observe(start.Add(197*time.Second), false, proxy)
	state.observe(start.Add(198*time.Second), true, proxy)
	if got := state.observe(start.Add(213*time.Second), true, proxy); got != watchEvaluateRecovery {
		t.Fatalf("new stable recovery after evaluation: got %q", got)
	}
}

func TestDeferredRecoveryIsCheckedAgainWithoutAnotherOutage(t *testing.T) {
	start := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	proxy := "http://127.0.0.1:7890"
	state := newWatchState(proxy)
	state.observe(start, false, proxy)
	state.observe(start.Add(180*time.Second), false, proxy)
	state.observe(start.Add(181*time.Second), true, proxy)
	state.observe(start.Add(196*time.Second), true, proxy)
	state.deferRecovery(start.Add(196 * time.Second))
	if got := state.observe(start.Add(225*time.Second), true, proxy); got != watchNone {
		t.Fatalf("deferred recovery evaluated too soon: got %q", got)
	}
	if got := state.observe(start.Add(226*time.Second), true, proxy); got != watchEvaluateRecovery {
		t.Fatalf("pending recovery was lost: got %q", got)
	}
	state.markRecovered(proxy)
	if got := state.observe(start.Add(600*time.Second), true, proxy); got != watchNone {
		t.Fatalf("connected app should not be prompted: got %q", got)
	}
}
