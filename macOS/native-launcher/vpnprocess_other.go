//go:build !windows

package main

// Mac 监测器直接传入应用身份检查；CLI 的 Windows FILETIME 参数不用于其他平台。
func vpnProcessAlive(pid int, expectedBirth int64) bool { return false }
