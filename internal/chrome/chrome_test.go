package chrome

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestEnableFlag(t *testing.T) {
	dir := t.TempDir()
	install := Install{Browser: Chrome, UserDataDir: dir, NativeHostDir: filepath.Join(dir, "NativeMessagingHosts")}
	original := `{"browser":{"enabled_labs_experiments":["enable-webmcp-testing@2","other-flag@1"],"other":true},"profile":{"x":1}}`
	if err := os.WriteFile(install.LocalStatePath(), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	enabled, err := install.FlagEnabled()
	if err != nil || enabled {
		t.Fatalf("FlagEnabled before = %v, %v", enabled, err)
	}
	changed, backup, err := install.EnableFlag()
	if err != nil || !changed || backup == "" {
		t.Fatalf("EnableFlag = %v, %q, %v", changed, backup, err)
	}
	backupData, err := os.ReadFile(backup)
	if err != nil || string(backupData) != original {
		t.Errorf("backup content = %q, %v", backupData, err)
	}
	data, _ := os.ReadFile(install.LocalStatePath())
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	got := experiments(state)
	if strings.Join(got, ",") != "other-flag@1,enable-webmcp-testing@1" {
		t.Errorf("experiments = %v", got)
	}
	if state["profile"].(map[string]any)["x"] != float64(1) || state["browser"].(map[string]any)["other"] != true {
		t.Errorf("unrelated keys were lost: %v", state)
	}

	enabled, err = install.FlagEnabled()
	if err != nil || !enabled {
		t.Fatalf("FlagEnabled after = %v, %v", enabled, err)
	}
	changed, backup, err = install.EnableFlag()
	if err != nil || changed || backup != "" {
		t.Errorf("second EnableFlag = %v, %q, %v; want no change", changed, backup, err)
	}
}

func TestEnableFlagCreatesLocalState(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	install := Install{UserDataDir: dir}
	changed, backup, err := install.EnableFlag()
	if err != nil || !changed || backup != "" {
		t.Fatalf("EnableFlag = %v, %q, %v", changed, backup, err)
	}
	enabled, err := install.FlagEnabled()
	if err != nil || !enabled {
		t.Errorf("FlagEnabled = %v, %v", enabled, err)
	}
}

func TestHostManifest(t *testing.T) {
	dir := t.TempDir()
	install := Install{UserDataDir: dir, NativeHostDir: filepath.Join(dir, "NativeMessagingHosts")}
	changed, path, err := install.InstallHostManifest("sh.kernel.xwebmcp", "/usr/local/bin/xwebmcp", "abcdefghijklmnopabcdefghijklmnop")
	if err != nil || !changed {
		t.Fatalf("install = %v, %v", changed, err)
	}
	data, _ := os.ReadFile(path)
	var manifest HostManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Type != "stdio" || manifest.Path != "/usr/local/bin/xwebmcp" || manifest.AllowedOrigins[0] != "chrome-extension://abcdefghijklmnopabcdefghijklmnop/" {
		t.Errorf("manifest = %+v", manifest)
	}
	if !install.HostManifestInstalled("sh.kernel.xwebmcp", "/usr/local/bin/xwebmcp") {
		t.Error("HostManifestInstalled = false")
	}
	if install.HostManifestInstalled("sh.kernel.xwebmcp", "/elsewhere/xwebmcp") {
		t.Error("HostManifestInstalled should compare the executable path")
	}
	changed, _, err = install.InstallHostManifest("sh.kernel.xwebmcp", "/usr/local/bin/xwebmcp", "abcdefghijklmnopabcdefghijklmnop")
	if err != nil || changed {
		t.Errorf("second install = %v, %v; want no change", changed, err)
	}
}

func TestIsRunning(t *testing.T) {
	dir := t.TempDir()
	install := Install{UserDataDir: dir}
	running, err := install.IsRunning()
	if err != nil || running {
		t.Fatalf("no lock: %v, %v", running, err)
	}
	// A live pid (this process) means Chrome is running.
	if err := os.Symlink("host-"+itoa(os.Getpid()), filepath.Join(dir, "SingletonLock")); err != nil {
		t.Fatal(err)
	}
	running, err = install.IsRunning()
	if err != nil || !running {
		t.Errorf("live pid: %v, %v", running, err)
	}
	os.Remove(filepath.Join(dir, "SingletonLock"))
	// A dead pid means a stale lock.
	if err := os.Symlink("host-999999999", filepath.Join(dir, "SingletonLock")); err != nil {
		t.Fatal(err)
	}
	running, err = install.IsRunning()
	if err != nil || running {
		t.Errorf("stale pid: %v, %v", running, err)
	}
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
