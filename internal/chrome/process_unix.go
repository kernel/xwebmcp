//go:build darwin || linux

package chrome

import (
	"os/exec"
	"strings"
	"syscall"
)

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// processHoldsProfile scans the process table for a Chrome using the profile.
func processHoldsProfile(userDataDir string) bool {
	out, err := exec.Command("ps", "-eo", "args").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "--user-data-dir="+userDataDir) && strings.Contains(strings.ToLower(line), "chrom") {
			return true
		}
	}
	return false
}
