// Package chrome locates a Chrome installation, toggles the WebMCP flag in its
// Local State file, and installs the native messaging host manifest.
package chrome

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// FlagEntry is the chrome://flags entry that enables document.modelContext
// (feature WebMCPTesting). The @1 suffix selects "Enabled".
const FlagEntry = "enable-webmcp-testing@1"

// Browser is a supported Chrome flavor.
type Browser string

const (
	Chrome       Browser = "chrome"
	ChromeBeta   Browser = "beta"
	ChromeDev    Browser = "dev"
	ChromeCanary Browser = "canary"
	Chromium     Browser = "chromium"
)

// Install describes one detected browser.
type Install struct {
	Browser     Browser
	Executable  string // binary path, or the .app bundle on macOS
	UserDataDir string
	// NativeHostDir is the per-user NativeMessagingHosts directory.
	NativeHostDir string
}

// LocalStatePath is the JSON file holding browser.enabled_labs_experiments.
func (i Install) LocalStatePath() string {
	return filepath.Join(i.UserDataDir, "Local State")
}

// Candidates lists the flavors to probe, most common first.
func Candidates() []Browser {
	return []Browser{Chrome, Chromium, ChromeBeta, ChromeDev, ChromeCanary}
}

type flavor struct {
	macApp        string
	macDataDir    string
	linuxBinaries []string
	linuxDataDir  string
}

var flavors = map[Browser]flavor{
	Chrome:       {"Google Chrome", "Google/Chrome", []string{"google-chrome", "google-chrome-stable"}, "google-chrome"},
	ChromeBeta:   {"Google Chrome Beta", "Google/Chrome Beta", []string{"google-chrome-beta"}, "google-chrome-beta"},
	ChromeDev:    {"Google Chrome Dev", "Google/Chrome Dev", []string{"google-chrome-unstable"}, "google-chrome-unstable"},
	ChromeCanary: {"Google Chrome Canary", "Google/Chrome Canary", nil, ""},
	Chromium:     {"Chromium", "Chromium", []string{"chromium", "chromium-browser"}, "chromium"},
}

// Detect finds the requested flavor (or the first available) on this machine.
// userDataDir overrides the default profile directory.
func Detect(browser Browser, userDataDir string) (Install, error) {
	if browser != "" {
		return detect(browser, userDataDir)
	}
	var errs []string
	for _, candidate := range Candidates() {
		install, err := detect(candidate, userDataDir)
		if err == nil {
			return install, nil
		}
		errs = append(errs, err.Error())
	}
	return Install{}, fmt.Errorf("no Chrome installation found (%s); pass --browser", strings.Join(errs, "; "))
}

func detect(browser Browser, userDataDir string) (Install, error) {
	spec, ok := flavors[browser]
	if !ok {
		return Install{}, fmt.Errorf("unknown browser %q", browser)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Install{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		app := filepath.Join("/Applications", spec.macApp+".app")
		if _, err := os.Stat(app); err != nil {
			userApp := filepath.Join(home, "Applications", spec.macApp+".app")
			if _, err := os.Stat(userApp); err != nil {
				return Install{}, fmt.Errorf("%s: %s not found", browser, app)
			}
			app = userApp
		}
		support := filepath.Join(home, "Library", "Application Support", spec.macDataDir)
		dataDir := userDataDir
		if dataDir == "" {
			dataDir = support
		}
		return Install{Browser: browser, Executable: app, UserDataDir: dataDir, NativeHostDir: filepath.Join(support, "NativeMessagingHosts")}, nil
	case "linux":
		if spec.linuxDataDir == "" {
			return Install{}, fmt.Errorf("%s is not available on Linux", browser)
		}
		var executable string
		for _, name := range spec.linuxBinaries {
			if path, err := exec.LookPath(name); err == nil {
				executable = path
				break
			}
		}
		if executable == "" {
			return Install{}, fmt.Errorf("%s: none of %s on PATH", browser, strings.Join(spec.linuxBinaries, ", "))
		}
		configHome := os.Getenv("XDG_CONFIG_HOME")
		if configHome == "" {
			configHome = filepath.Join(home, ".config")
		}
		dataDir := userDataDir
		if dataDir == "" {
			dataDir = filepath.Join(configHome, spec.linuxDataDir)
		}
		// Linux resolves native messaging hosts relative to the user data dir.
		return Install{Browser: browser, Executable: executable, UserDataDir: dataDir, NativeHostDir: filepath.Join(dataDir, "NativeMessagingHosts")}, nil
	default:
		return Install{}, fmt.Errorf("%s is not supported on %s", browser, runtime.GOOS)
	}
}

// IsRunning reports whether a Chrome process holds the profile. Chrome keeps
// a SingletonLock symlink (hostname-pid) in the user data dir while running.
func (i Install) IsRunning() (bool, error) {
	link, err := os.Readlink(filepath.Join(i.UserDataDir, "SingletonLock"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		// Not a symlink on this platform: fall back to the process table.
		return processHoldsProfile(i.UserDataDir), nil
	}
	_, pidText, found := strings.Cut(link, "-")
	if !found {
		return true, nil
	}
	var pid int
	if _, err := fmt.Sscanf(pidText, "%d", &pid); err != nil {
		return true, nil
	}
	return processAlive(pid), nil
}

// OpenURL opens url in this browser, starting it when needed.
func (i Install) OpenURL(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-a", i.Executable, url)
	default:
		cmd = exec.Command(i.Executable, url)
		if i.UserDataDir != "" {
			cmd = exec.Command(i.Executable, "--user-data-dir="+i.UserDataDir, url)
		}
	}
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// FlagEnabled reports whether the WebMCP flag is on in Local State.
func (i Install) FlagEnabled() (bool, error) {
	state, err := readLocalState(i.LocalStatePath())
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, entry := range experiments(state) {
		if entry == FlagEntry {
			return true, nil
		}
	}
	return false, nil
}

// EnableFlag adds the WebMCP flag to Local State. It backs the file up first
// and returns the backup path; changed is false when the flag was already on.
func (i Install) EnableFlag() (changed bool, backup string, err error) {
	path := i.LocalStatePath()
	state, err := readLocalState(path)
	if errors.Is(err, os.ErrNotExist) {
		state = map[string]any{}
	} else if err != nil {
		return false, "", err
	}
	current := experiments(state)
	var next []string
	for _, entry := range current {
		if entry == FlagEntry {
			return false, "", nil
		}
		if strings.HasPrefix(entry, strings.TrimSuffix(FlagEntry, "@1")+"@") {
			continue // replace an explicit "Disabled" choice
		}
		next = append(next, entry)
	}
	next = append(next, FlagEntry)

	browser, _ := state["browser"].(map[string]any)
	if browser == nil {
		browser = map[string]any{}
		state["browser"] = browser
	}
	browser["enabled_labs_experiments"] = next

	if original, err := os.ReadFile(path); err == nil {
		backup = fmt.Sprintf("%s.xwebmcp-backup-%s", path, time.Now().UTC().Format("20060102T150405Z"))
		if err := os.WriteFile(backup, original, 0o600); err != nil {
			return false, "", fmt.Errorf("back up Local State: %w", err)
		}
	} else if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, "", err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return false, "", err
	}
	tmp := path + ".xwebmcp-tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return false, "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return false, "", err
	}
	return true, backup, nil
}

func readLocalState(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return state, nil
}

func experiments(state map[string]any) []string {
	browser, _ := state["browser"].(map[string]any)
	raw, _ := browser["enabled_labs_experiments"].([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// HostManifest is a native messaging host manifest.
type HostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

// InstallHostManifest writes the manifest for hostName pointing at executable
// and allowing extensionID. Returns whether the file changed.
func (i Install) InstallHostManifest(hostName, executable, extensionID string) (bool, string, error) {
	manifest := HostManifest{
		Name:           hostName,
		Description:    "xwebmcp native messaging bridge",
		Path:           executable,
		Type:           "stdio",
		AllowedOrigins: []string{"chrome-extension://" + extensionID + "/"},
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return false, "", err
	}
	data = append(data, '\n')
	path := filepath.Join(i.NativeHostDir, hostName+".json")
	if existing, err := os.ReadFile(path); err == nil && string(existing) == string(data) {
		return false, path, nil
	}
	if err := os.MkdirAll(i.NativeHostDir, 0o755); err != nil {
		return false, "", err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return false, "", err
	}
	return true, path, nil
}

// HostManifestInstalled reports whether the manifest exists and points at executable.
func (i Install) HostManifestInstalled(hostName, executable string) bool {
	data, err := os.ReadFile(filepath.Join(i.NativeHostDir, hostName+".json"))
	if err != nil {
		return false
	}
	var manifest HostManifest
	if json.Unmarshal(data, &manifest) != nil {
		return false
	}
	return manifest.Path == executable
}
