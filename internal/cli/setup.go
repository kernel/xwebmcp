package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/extension"
	"github.com/kernel/xwebmcp/internal/bridge"
	"github.com/kernel/xwebmcp/internal/chrome"
	"github.com/kernel/xwebmcp/internal/store"
)

const extensionDirName = "extension"

func (a *App) setupCommand() *cli.Command {
	return &cli.Command{
		Name:  "setup",
		Usage: "prepare a browser for local tools",
		Commands: []*cli.Command{
			{
				Name:  "chrome",
				Usage: "enable the WebMCP flag, install the native messaging host, and unpack the extension",
				Description: `Detects Google Chrome (or --browser chromium|beta|dev|canary) and its user data
directory, backs up "Local State" and enables the WebMCP flag, installs the
native messaging host manifest that lets the CLI talk to the extension, writes
the unpacked extension under the state directory, and opens chrome://extensions
for the one-time "Load unpacked" step. Safe to run again at any time.

Chrome must be closed while "Local State" is edited; the command refuses to
touch it otherwise.`,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "browser", Usage: "chrome, chromium, beta, dev, or canary (default: first found)"},
					&cli.StringFlag{Name: "user-data-dir", Usage: "override the Chrome profile directory"},
					&cli.BoolFlag{Name: "no-open", Usage: "do not launch Chrome on chrome://extensions"},
				},
				Action: func(ctx context.Context, cmd *cli.Command) error {
					return a.setupChrome(ctx, setupOptions{
						browser:     chrome.Browser(cmd.String("browser")),
						userDataDir: cmd.String("user-data-dir"),
						open:        !cmd.Bool("no-open"),
					})
				},
			},
		},
	}
}

type setupOptions struct {
	browser     chrome.Browser
	userDataDir string
	open        bool
}

func (a *App) setupChrome(ctx context.Context, opts setupOptions) error {
	install, err := chrome.Detect(opts.browser, opts.userDataDir)
	if err != nil {
		return err
	}
	a.printf("browser:        %s (%s)\n", install.Browser, install.Executable)
	a.printf("user data dir:  %s\n", install.UserDataDir)

	st, err := a.store()
	if err != nil {
		return err
	}
	if err := store.RecordHomePointer(st.Dir); err != nil {
		return err
	}

	// 1. WebMCP flag in Local State.
	enabled, err := install.FlagEnabled()
	if err != nil {
		return err
	}
	if enabled {
		a.printf("webmcp flag:    already enabled\n")
	} else {
		running, err := install.IsRunning()
		if err != nil {
			return err
		}
		if running {
			return fmt.Errorf("%s is running with %s; quit it completely, then run `xwebmcp setup chrome` again so the WebMCP flag can be enabled", install.Browser, install.UserDataDir)
		}
		changed, backup, err := install.EnableFlag()
		if err != nil {
			return fmt.Errorf("enable WebMCP flag: %w", err)
		}
		if changed {
			a.printf("webmcp flag:    enabled (%s)\n", chrome.FlagEntry)
			if backup != "" {
				a.printf("backup:         %s\n", backup)
			}
		}
	}

	// 2. Unpacked extension.
	extensionDir := filepath.Join(st.Dir, extensionDirName)
	if err := extension.Write(extensionDir); err != nil {
		return fmt.Errorf("write extension: %w", err)
	}
	extensionID, err := extension.ID()
	if err != nil {
		return err
	}
	a.printf("extension:      %s (id %s)\n", extensionDir, extensionID)

	// 3. Native messaging host manifest.
	executable, err := a.executablePath()
	if err != nil {
		return err
	}
	changed, manifestPath, err := install.InstallHostManifest(bridge.HostName, executable, extensionID)
	if err != nil {
		return fmt.Errorf("install native messaging host: %w", err)
	}
	if changed {
		a.printf("native host:    installed %s -> %s\n", manifestPath, executable)
	} else {
		a.printf("native host:    up to date (%s)\n", manifestPath)
	}

	// 4. Is the extension already loaded and connected?
	if client, err := bridge.Dial(ctx, st.Dir); err == nil {
		defer client.Close()
		if info, err := client.Ping(ctx); err == nil {
			a.printf("bridge:         connected (extension %v)\n", info["version"])
			a.printf("\nsetup is complete\n")
			return nil
		}
	}

	a.printf("\nOne-time step in Chrome:\n")
	a.printf("  1. open chrome://extensions and turn on \"Developer mode\" (top right)\n")
	a.printf("  2. click \"Load unpacked\" and choose:\n     %s\n", extensionDir)
	a.printf("  3. run `xwebmcp status` to confirm the extension is connected\n")
	if opts.open {
		if err := install.OpenURL("chrome://extensions"); err != nil {
			a.warnf("could not open chrome://extensions: %v\n", err)
		}
	}
	return nil
}

func (a *App) executablePath() (string, error) {
	if a.Executable != "" {
		return a.Executable, nil
	}
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path, nil
	}
	if resolved == "" {
		return "", errors.New("cannot determine the xwebmcp executable path")
	}
	return resolved, nil
}
