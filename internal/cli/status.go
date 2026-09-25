package cli

import (
	"context"
	"path/filepath"

	"github.com/urfave/cli/v3"

	"github.com/kernel/xwebmcp/extension"
	"github.com/kernel/xwebmcp/internal/bridge"
	"github.com/kernel/xwebmcp/internal/chrome"
)

func (a *App) statusCommand() *cli.Command {
	return &cli.Command{
		Name:  "status",
		Usage: "show the local setup state",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "browser", Usage: "chrome, chromium, beta, dev, or canary"},
			&cli.StringFlag{Name: "user-data-dir", Usage: "override the Chrome profile directory"},
		},
		Action: func(ctx context.Context, cmd *cli.Command) error {
			return a.status(ctx, chrome.Browser(cmd.String("browser")), cmd.String("user-data-dir"))
		},
	}
}

func (a *App) status(ctx context.Context, browser chrome.Browser, userDataDir string) error {
	st, err := a.store()
	if err != nil {
		return err
	}
	lock, err := st.ReadLock()
	if err != nil {
		return err
	}
	a.printf("state dir:      %s\n", st.Dir)
	a.printf("installed:      %d tool(s) from %d source(s)\n", len(lock.Installed()), len(lock.Sources))

	install, err := chrome.Detect(browser, userDataDir)
	if err != nil {
		a.printf("browser:        not found (%v)\n", err)
	} else {
		a.printf("browser:        %s (%s)\n", install.Browser, install.Executable)
		enabled, err := install.FlagEnabled()
		switch {
		case err != nil:
			a.printf("webmcp flag:    unknown (%v)\n", err)
		case enabled:
			a.printf("webmcp flag:    enabled\n")
		default:
			a.printf("webmcp flag:    not enabled; run `xwebmcp setup chrome`\n")
		}
		executable, _ := a.executablePath()
		if install.HostManifestInstalled(bridge.HostName, executable) {
			a.printf("native host:    installed\n")
		} else {
			a.printf("native host:    not installed; run `xwebmcp setup chrome`\n")
		}
	}
	extensionID, _ := extension.ID()
	a.printf("extension dir:  %s (id %s)\n", filepath.Join(st.Dir, extensionDirName), extensionID)

	client, err := bridge.Dial(ctx, st.Dir)
	if err != nil {
		a.printf("bridge:         not connected (%v)\n", err)
		return nil
	}
	defer client.Close()
	info, err := client.Ping(ctx)
	if err != nil {
		a.printf("bridge:         socket present but the extension did not answer (%v)\n", err)
		return nil
	}
	a.printf("bridge:         connected (extension %v)\n", info["version"])

	var custom struct {
		Tools          []extensionTool `json:"tools"`
		PendingOrigins []string        `json:"pending_origins"`
	}
	if err := client.Call(ctx, "listCustomTools", nil, &custom); err != nil {
		return err
	}
	a.printf("attached:       %d tool(s) in the extension\n", len(custom.Tools))
	if len(custom.PendingOrigins) > 0 {
		a.printf("site access:    %d origin(s) need a grant: open the xwebmcp popup and click \"Grant access\"\n", len(custom.PendingOrigins))
		for _, origin := range custom.PendingOrigins {
			a.printf("                %s\n", origin)
		}
	}
	return nil
}
