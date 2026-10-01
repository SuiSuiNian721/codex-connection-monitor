//go:build windows

package main

import "golang.org/x/sys/windows"

func vpnProcessAlive(pid int, expectedBirth int64) bool {
	if pid <= 0 || expectedBirth <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if windows.GetExitCodeProcess(handle, &code) != nil || code != 259 {
		return false
	}
	var birth, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &birth, &exit, &kernel, &user) != nil {
		return false
	}
	actual := int64(uint64(birth.HighDateTime)<<32 | uint64(birth.LowDateTime))
	return actual == expectedBirth
}
